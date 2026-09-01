/**
 * MCP-server for Qbikk.
 *
 * Lar en agent lese og skrive i regnskapet: «hva brukte jeg på musikk i mars»,
 * «legg denne kvitteringen på uttaket 12. mars», «hva må jeg se på».
 *
 * REGELEN SOM STYRER HELE FILA: ingen skrivende verktøy her skriver til
 * databasen selv. Alle kaller de samme pipeline-funksjonene som webhooken,
 * workeren og web-UI-et bruker. Konsekvensen er at et verktøy IKKE KAN omgå
 * dedupen, korreksjonshistorikken eller matchereglene - uansett hva agenten
 * prøver på. Skulle noen legge inn et `db.insert(vouchers)` her, er det den
 * endringen som skal stoppes i review.
 *
 * `confirm_match` er med vilje skilt fra `propose_match`: en agent skal kunne
 * FORESLÅ en kobling, men å slå to bilag sammen krever et eget, eksplisitt
 * kall. Det speiler regelen fra resten av systemet - usikre matcher foreslås,
 * de utføres ikke.
 */
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  getDb,
  gte,
  ilike,
  ingestionChannels,
  inArray,
  lte,
  ne,
  or,
  users,
  voucherLines,
  voucherMatches,
  vouchers,
  corrections,
  rawDocuments,
  type Voucher,
} from "@qbikk/db";
import {
  applyCorrection,
  attachDocumentToVoucher,
  createManualVoucher,
  getBlobStore,
  loadUserContext,
  mergeMatched,
  proposeMatches,
  CORRECTABLE_FIELDS,
  type CorrectableField,
} from "@qbikk/core";
import { formatPlain } from "@qbikk/core/money";
import { VAT_LABELS, VAT_RATES, vatTermFor, type VatCode } from "@qbikk/core/vat";
import { getChannel } from "@qbikk/ingestion";

const server = new McpServer({ name: "qbikk", version: "0.1.0" });

/* ------------------------------------------------------------- hjelpere -- */

/** V1: én bruker per installasjon. Samme sted som web slår det fast. */
async function requireUserId(): Promise<string> {
  const db = getDb();
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) throw new Error("Ingen bruker i databasen. Kjør `pnpm seed`.");
  return user.id;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Bilag i den formen en agent kan resonnere om: kroner, ikke øre. */
function present(v: Voucher) {
  return {
    id: v.id,
    date: v.date,
    bookingDate: v.bookingDate,
    direction: v.direction,
    grossAmount: v.grossAmount / 100,
    netAmount: v.netAmount === null ? null : v.netAmount / 100,
    vatAmount: v.vatAmount === null ? null : v.vatAmount / 100,
    vatCode: v.vatCode,
    vatRate: v.vatRate,
    currency: v.currency,
    amountNok: v.amountNok / 100,
    counterparty: v.counterpartyName,
    counterpartyCountry: v.counterpartyCountry,
    description: v.description,
    category: v.category,
    accountCode: v.accountCode,
    status: v.status,
    confidence: v.confidence === null ? null : Number(v.confidence),
    needsDocumentation: v.needsDocumentation,
    reverseCharge: v.reverseCharge,
    sourceChannel: v.sourceChannel,
    hasDocument: v.attachmentPath !== null,
  };
}

/* -------------------------------------------------------------- lesende -- */

server.registerTool(
  "search_vouchers",
  {
    title: "Søk i bilag",
    description:
      "Finn bilag med fritekst og filtre. Beløp oppgis og returneres i hele valutaenheter (kroner), ikke øre. Duplikater er utelatt som standard - det er bilag som er slått sammen med et annet.",
    inputSchema: {
      query: z.string().optional().describe("Fritekst mot motpart, beskrivelse og referanse"),
      from: z.string().optional().describe("Fra og med, YYYY-MM-DD"),
      to: z.string().optional().describe("Til og med, YYYY-MM-DD"),
      direction: z.enum(["income", "expense"]).optional(),
      status: z.enum(["needs_review", "matched", "confirmed", "duplicate"]).optional(),
      category: z.string().optional(),
      counterparty: z.string().optional(),
      minAmount: z.number().optional().describe("I hele kroner"),
      maxAmount: z.number().optional().describe("I hele kroner"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const userId = await requireUserId();
    const db = getDb();

    const conditions = [eq(vouchers.userId, userId)];
    if (args.from) conditions.push(gte(vouchers.date, args.from));
    if (args.to) conditions.push(lte(vouchers.date, args.to));
    if (args.direction) conditions.push(eq(vouchers.direction, args.direction));
    if (args.category) conditions.push(eq(vouchers.category, args.category));
    if (args.counterparty) conditions.push(ilike(vouchers.counterpartyName, `%${args.counterparty}%`));
    if (args.minAmount !== undefined) conditions.push(gte(vouchers.amountNok, Math.round(args.minAmount * 100)));
    if (args.maxAmount !== undefined) conditions.push(lte(vouchers.amountNok, Math.round(args.maxAmount * 100)));

    if (args.status) conditions.push(eq(vouchers.status, args.status));
    else conditions.push(ne(vouchers.status, "duplicate"));

    if (args.query) {
      const pattern = `%${args.query}%`;
      const search = or(
        ilike(vouchers.counterpartyName, pattern),
        ilike(vouchers.description, pattern),
        ilike(vouchers.externalRef, pattern),
      );
      if (search) conditions.push(search);
    }

    const rows = await db
      .select()
      .from(vouchers)
      .where(and(...conditions))
      .orderBy(desc(vouchers.date))
      .limit(args.limit);

    return json({ count: rows.length, vouchers: rows.map(present) });
  },
);

server.registerTool(
  "get_voucher",
  {
    title: "Hent ett bilag",
    description:
      "Alt om ett bilag: felter, varelinjer, korreksjonshistorikk og lenke til rådokumentet. Korreksjonshistorikken viser hvem som endret hva og når - den er revisjonssporet.",
    inputSchema: { id: z.string().describe("Bilagets uuid") },
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => {
    const userId = await requireUserId();
    const db = getDb();

    const [voucher] = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.userId, userId), eq(vouchers.id, id)))
      .limit(1);
    if (!voucher) return text(`Fant ikke bilag ${id}`);

    const [lines, history, raw] = await Promise.all([
      db.select().from(voucherLines).where(eq(voucherLines.voucherId, id)).orderBy(asc(voucherLines.lineNo)),
      db.select().from(corrections).where(eq(corrections.voucherId, id)).orderBy(desc(corrections.createdAt)),
      voucher.rawDocumentId
        ? db.select().from(rawDocuments).where(eq(rawDocuments.id, voucher.rawDocumentId)).limit(1)
        : Promise.resolve([]),
    ]);

    return json({
      voucher: present(voucher),
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description,
        netAmount: l.netAmount / 100,
        vatRate: Number(l.vatRate),
        vatAmount: l.vatAmount / 100,
        grossAmount: l.grossAmount / 100,
        vatCode: l.vatCode,
        accountCode: l.accountCode,
      })),
      corrections: history.map((c) => ({
        at: c.createdAt.toISOString(),
        field: c.field,
        from: c.oldValue,
        to: c.newValue,
        reason: c.reason,
        actor: c.actor,
        learnedRule: c.learnedRuleId !== null,
      })),
      rawDocument: raw[0]
        ? {
            id: raw[0].id,
            kind: raw[0].kind,
            receivedAt: raw[0].receivedAt.toISOString(),
            sender: raw[0].sender,
            subject: raw[0].subject,
            sha256: raw[0].contentSha256,
            storageKey: raw[0].storageKey,
            textBody: raw[0].textBody?.slice(0, 4000) ?? null,
          }
        : null,
    });
  },
);

server.registerTool(
  "list_action_items",
  {
    title: "Hva krever handling",
    description:
      "Køen brukeren må ta stilling til: betalinger uten kvittering, bilag med lav sikkerhet, foreslåtte koblinger og kanaler som har stoppet. Ingenting her løses automatisk.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const userId = await requireUserId();
    const db = getDb();

    const [missing, review, proposed, channels] = await Promise.all([
      db
        .select()
        .from(vouchers)
        .where(
          and(eq(vouchers.userId, userId), eq(vouchers.needsDocumentation, true), ne(vouchers.status, "duplicate")),
        )
        .orderBy(desc(vouchers.date))
        .limit(100),
      db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.userId, userId),
            eq(vouchers.status, "needs_review"),
            eq(vouchers.needsDocumentation, false),
          ),
        )
        .orderBy(desc(vouchers.date))
        .limit(100),
      db
        .select()
        .from(voucherMatches)
        .where(and(eq(voucherMatches.userId, userId), eq(voucherMatches.status, "proposed")))
        .orderBy(desc(voucherMatches.score))
        .limit(50),
      db
        .select()
        .from(ingestionChannels)
        .where(
          and(
            eq(ingestionChannels.userId, userId),
            or(eq(ingestionChannels.status, "needs_auth"), eq(ingestionChannels.status, "error")),
          ),
        ),
    ]);

    const ids = proposed.flatMap((m) => [m.bankVoucherId, m.documentVoucherId]);
    const involved =
      ids.length > 0
        ? await db.select().from(vouchers).where(and(eq(vouchers.userId, userId), inArray(vouchers.id, ids)))
        : [];
    const byId = new Map(involved.map((v) => [v.id, v]));

    return json({
      missingDocumentation: missing.map(present),
      needsReview: review.map(present),
      proposedMatches: proposed.map((m) => ({
        bankVoucherId: m.bankVoucherId,
        documentVoucherId: m.documentVoucherId,
        score: Number(m.score),
        reasons: m.reasons,
        bank: byId.get(m.bankVoucherId) ? present(byId.get(m.bankVoucherId)!) : null,
        document: byId.get(m.documentVoucherId) ? present(byId.get(m.documentVoucherId)!) : null,
      })),
      channelsNeedingAction: channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
        lastError: c.lastError,
      })),
    });
  },
);

server.registerTool(
  "vat_summary",
  {
    title: "MVA per termin",
    description:
      "MVA-oppsummering for et år, med egen post for omvendt avgiftsplikt. Ved omvendt avgiftsplikt skal beløpet føres BÅDE som utgående og som inngående MVA - netto blir null, men begge tallene skal med i meldingen.",
    inputSchema: {
      year: z.number().int().min(2000).max(2100),
      term: z.number().int().min(1).max(6).optional().describe("1-6. Utelates for hele året."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ year, term }) => {
    const userId = await requireUserId();
    const db = getDb();

    const rows = await db
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.userId, userId),
          ne(vouchers.status, "duplicate"),
          gte(vouchers.date, `${year}-01-01`),
          lte(vouchers.date, `${year}-12-31`),
        ),
      );

    const terms = new Map<number, {
      term: number;
      from: string;
      to: string;
      outgoing: Record<string, { base: number; vat: number }>;
      incoming: Record<string, { base: number; vat: number }>;
      reverseCharge: { base: number; vat: number; count: number };
    }>();

    for (const row of rows) {
      const t = vatTermFor(row.date);
      if (term !== undefined && t.term !== term) continue;

      const entry =
        terms.get(t.term) ??
        {
          term: t.term,
          from: t.from,
          to: t.to,
          outgoing: {},
          incoming: {},
          reverseCharge: { base: 0, vat: 0, count: 0 },
        };

      const scale = row.currency === "NOK" ? 1 : Number(row.exchangeRate) || 1;
      const vatNok = Math.round((row.vatAmount ?? 0) * scale);
      const netNok = Math.round((row.netAmount ?? row.grossAmount) * scale);

      if (row.reverseCharge || row.vatCode === "reverse_charge") {
        entry.reverseCharge.base += netNok;
        entry.reverseCharge.vat += Math.round((netNok * VAT_RATES.reverse_charge) / 100);
        entry.reverseCharge.count += 1;
      } else if (row.vatCode) {
        const bucket = row.direction === "income" ? entry.outgoing : entry.incoming;
        const existing = bucket[row.vatCode] ?? { base: 0, vat: 0 };
        existing.base += netNok;
        existing.vat += vatNok;
        bucket[row.vatCode] = existing;
      }

      terms.set(t.term, entry);
    }

    return json({
      year,
      terms: [...terms.values()]
        .sort((a, b) => a.term - b.term)
        .map((t) => {
          const out = Object.values(t.outgoing).reduce((a, b) => a + b.vat, 0);
          const inn = Object.values(t.incoming).reduce((a, b) => a + b.vat, 0);
          return {
            term: t.term,
            period: `${t.from} – ${t.to}`,
            outgoing: mapAmounts(t.outgoing),
            incoming: mapAmounts(t.incoming),
            reverseCharge: {
              base: t.reverseCharge.base / 100,
              vatBothWays: t.reverseCharge.vat / 100,
              vouchers: t.reverseCharge.count,
              note: "Føres som utgående OG inngående. Netto null, men begge skal rapporteres.",
            },
            payable: (out - inn) / 100,
          };
        }),
    });
  },
);

function mapAmounts(bucket: Record<string, { base: number; vat: number }>) {
  return Object.entries(bucket).map(([code, v]) => ({
    code,
    label: VAT_LABELS[code as VatCode],
    rate: VAT_RATES[code as VatCode],
    base: v.base / 100,
    vat: v.vat / 100,
  }));
}

server.registerTool(
  "channel_status",
  {
    title: "Kanalstatus",
    description: "Hvor bilagene kommer fra: sist synk, siste feil, og hva som krever at brukeren gjør noe.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const userId = await requireUserId();
    const rows = await getDb()
      .select()
      .from(ingestionChannels)
      .where(eq(ingestionChannels.userId, userId))
      .orderBy(asc(ingestionChannels.createdAt));

    return json(
      rows.map((row) => {
        const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
        return {
          id: row.id,
          name: row.name,
          type: row.type,
          label: channel.label,
          status: row.status,
          fragile: channel.capabilities.fragile,
          lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
          lastError: row.lastError,
          consecutiveFailures: row.consecutiveFailures,
          needsUserAction: row.status === "needs_auth",
        };
      }),
    );
  },
);

/* ------------------------------------------------------------- skrivende -- */

server.registerTool(
  "create_voucher",
  {
    title: "Opprett bilag manuelt",
    description:
      "Lag et bilag for hånd, f.eks. en kontantkvittering uten dokumentasjon. Kjører den SAMME dedupen som alt annet: finnes bilaget fra før, får du det eksisterende tilbake i stedet for en dublett.",
    inputSchema: {
      date: z.string().describe("Dokumentdato, YYYY-MM-DD"),
      direction: z.enum(["income", "expense"]),
      grossAmount: z.number().positive().describe("Totalbeløp inkl. mva, i hele kroner"),
      currency: z.string().length(3).default("NOK"),
      counterpartyName: z.string(),
      description: z.string(),
      category: z.string().optional().describe("Kategorinøkkel fra bransjeprofilen"),
      vatAmount: z.number().optional().describe("MVA-beløp i hele kroner, hvis kjent"),
      vatRate: z.number().optional().describe("MVA-sats i prosent, f.eks. 25"),
      counterpartyCountry: z.string().length(2).optional(),
    },
  },
  async (args) => {
    const userId = await requireUserId();
    const db = getDb();
    const { profile, rules } = await loadUserContext(db, userId);

    const result = await createManualVoucher(db, {
      userId,
      profile,
      rules,
      date: args.date,
      direction: args.direction,
      grossAmount: Math.round(args.grossAmount * 100),
      currency: args.currency,
      counterpartyName: args.counterpartyName,
      description: args.description,
      category: args.category ?? null,
      vatAmount: args.vatAmount === undefined ? null : Math.round(args.vatAmount * 100),
      vatRate: args.vatRate ?? null,
      counterpartyCountry: args.counterpartyCountry ?? null,
    });

    return json({
      voucherId: result.voucherId,
      wasDuplicate: result.isDuplicate,
      reviewReasons: result.reviewReasons,
      message: result.isDuplicate
        ? "Bilaget fantes fra før - returnerte det eksisterende i stedet for å lage en dublett."
        : "Bilaget er opprettet.",
    });
  },
);

server.registerTool(
  "attach_document",
  {
    title: "Legg dokumentasjon på et bilag",
    description:
      "Legger en kvittering eller faktura på et bilag som mangler dokumentasjon - typisk en banktransaksjon. Filen arkiveres som et vanlig rådokument og kan tolkes på nytt senere.",
    inputSchema: {
      voucherId: z.string(),
      filename: z.string(),
      contentBase64: z.string().describe("Filinnholdet base64-kodet"),
      mime: z.string().describe("f.eks. application/pdf eller image/jpeg"),
    },
  },
  async (args) => {
    const userId = await requireUserId();
    const data = Buffer.from(args.contentBase64, "base64");
    if (data.byteLength === 0) return text("Tomt filinnhold.");

    const result = await attachDocumentToVoucher(getDb(), getBlobStore(), {
      userId,
      voucherId: args.voucherId,
      filename: args.filename,
      mime: args.mime,
      data,
    });

    return json({
      rawDocumentId: result.rawDocumentId,
      wasDuplicate: result.isDuplicate,
      message: "Dokumentasjonen er lagt på bilaget, som ikke lenger mangler dokumentasjon.",
    });
  },
);

server.registerTool(
  "correct_voucher",
  {
    title: "Rett et felt på et bilag",
    description:
      "Retter ett felt. Endringen skrives til korreksjonshistorikken - ingenting overskrives uten spor. Rettinger av kategori, konto og MVA-kode lærer i tillegg en regel, slik at samme leverandør havner riktig neste gang.",
    inputSchema: {
      id: z.string(),
      field: z.enum(CORRECTABLE_FIELDS),
      value: z.string().describe("Ny verdi. Beløp oppgis i hele kroner."),
      reason: z.string().optional().describe("Hvorfor - havner i revisjonssporet"),
    },
  },
  async (args) => {
    const userId = await requireUserId();

    let value: unknown = args.value;
    if (args.field === "grossAmount") {
      const { parseAmount } = await import("@qbikk/core/money");
      const parsed = parseAmount(args.value);
      if (parsed === null) return text(`«${args.value}» er ikke et gyldig beløp.`);
      value = parsed;
    }

    const result = await applyCorrection(getDb(), {
      userId,
      voucherId: args.id,
      field: args.field as CorrectableField,
      value,
      reason: args.reason ?? null,
      actor: "mcp",
    });

    return json({
      voucherId: result.voucherId,
      learnedRule: result.learnedRuleId !== null,
      message: result.learnedRuleId
        ? "Rettet, og lærte en regel for neste bilag fra samme leverandør."
        : "Rettet. Endringen står i korreksjonshistorikken.",
    });
  },
);

server.registerTool(
  "propose_match",
  {
    title: "Foreslå kobling",
    description:
      "Leter etter motstykket til et bilag - kvitteringen til en betaling, eller betalingen til en kvittering - og lagrer forslaget. Slår IKKE bilagene sammen med mindre matchen er utvilsom. Bruk confirm_match for å bekrefte.",
    inputSchema: {
      voucherId: z.string().describe("Bilaget det skal letes fra"),
    },
  },
  async ({ voucherId }) => {
    const userId = await requireUserId();
    const result = await proposeMatches(getDb(), { userId, voucherId });

    return json({
      proposals: result.proposals.map((p) => ({
        bankVoucherId: p.bankVoucherId,
        documentVoucherId: p.documentVoucherId,
        score: p.score,
        reasons: p.reasons,
        autoLinked: result.linked.some((l) => l.documentVoucherId === p.documentVoucherId),
      })),
      message:
        result.linked.length > 0
          ? "Matchen var utvilsom og ble koblet."
          : result.proposals.length > 0
            ? "Forslag lagret. Bruk confirm_match for å slå dem sammen."
            : "Fant ingen match.",
    });
  },
);

server.registerTool(
  "confirm_match",
  {
    title: "Bekreft kobling",
    description:
      "Slår et bankbilag og et dokumentbilag sammen til ETT bilag. Dokumentbilaget overlever (det har MVA og dokumentasjon) og får bokføringsdato fra banken; bankbilaget merkes som dublett, men slettes aldri. Krever et eksplisitt kall - dette skjer aldri automatisk fra en usikker match.",
    inputSchema: {
      bankVoucherId: z.string(),
      documentVoucherId: z.string(),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async (args) => {
    const userId = await requireUserId();
    const result = await mergeMatched(getDb(), {
      userId,
      bankVoucherId: args.bankVoucherId,
      documentVoucherId: args.documentVoucherId,
      actor: "mcp",
    });

    return json({
      voucherId: result.voucherId,
      message: "Slått sammen. Bankbilaget er merket som dublett og peker på bilaget som overlevde.",
    });
  },
);

/* ------------------------------------------------------------------ start */

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout er MCP-protokollen. All logging MÅ gå til stderr, ellers ødelegger
  // vi meldingsstrømmen for klienten.
  console.error("qbikk MCP-server kjører på stdio");
}

main().catch((err: unknown) => {
  console.error("MCP-serveren klarte ikke å starte:", err);
  process.exit(1);
});

export { formatPlain };
