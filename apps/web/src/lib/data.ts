/**
 * Leseveiene til UI-et.
 *
 * Alle spørringer filtrerer på `user_id`, selv om v1 kjører med én bruker per
 * installasjon. Det er ikke pynt: den dagen innlogging kommer, skal det ikke
 * finnes en eneste spørring som mangler filteret og lekker på tvers av
 * brukere. Å legge det til etterpå er den typen jobb ingen blir ferdig med.
 */
import "server-only";
import {
  and,
  asc,
  bankTransactions,
  corrections,
  count,
  desc,
  eq,
  getDb,
  gte,
  ilike,
  ingestionChannels,
  inArray,
  isNull,
  lte,
  ne,
  or,
  rawDocuments,
  sql,
  sum,
  users,
  voucherLines,
  voucherMatches,
  vouchers,
  type User,
  type Voucher,
} from "@qbikk/db";
import { vatTermFor, VAT_RATES, type VatCode } from "@qbikk/core/vat";

/**
 * V1 har ingen innlogging: én bruker per installasjon. Denne funksjonen er
 * likevel det ENESTE stedet som slår fast hvem «vi» er, så når auth kommer,
 * er det denne ene funksjonen som byttes ut.
 */
export async function currentUser(): Promise<User | null> {
  const db = getDb();
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  return user ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new Error("Ingen bruker i databasen. Kjør `pnpm seed`.");
  return user;
}

/* ------------------------------------------------------------- bilagsliste */

export interface VoucherFilter {
  from?: string;
  to?: string;
  direction?: "income" | "expense";
  status?: Voucher["status"];
  category?: string;
  channel?: Voucher["sourceChannel"];
  q?: string;
  limit?: number;
}

export async function listVouchers(userId: string, filter: VoucherFilter = {}): Promise<Voucher[]> {
  const db = getDb();

  const conditions = [eq(vouchers.userId, userId)];
  if (filter.from) conditions.push(gte(vouchers.date, filter.from));
  if (filter.to) conditions.push(lte(vouchers.date, filter.to));
  if (filter.direction) conditions.push(eq(vouchers.direction, filter.direction));
  if (filter.status) conditions.push(eq(vouchers.status, filter.status));
  if (filter.category) conditions.push(eq(vouchers.category, filter.category));
  if (filter.channel) conditions.push(eq(vouchers.sourceChannel, filter.channel));
  if (filter.q) {
    const pattern = `%${filter.q}%`;
    const search = or(
      ilike(vouchers.counterpartyName, pattern),
      ilike(vouchers.description, pattern),
      ilike(vouchers.externalRef, pattern),
    );
    if (search) conditions.push(search);
  }

  return db
    .select()
    .from(vouchers)
    .where(and(...conditions))
    .orderBy(desc(vouchers.date), desc(vouchers.createdAt))
    .limit(filter.limit ?? 200);
}

export async function getVoucherDetail(userId: string, voucherId: string) {
  const db = getDb();

  const [voucher] = await db
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.userId, userId), eq(vouchers.id, voucherId)))
    .limit(1);
  if (!voucher) return null;

  const [lines, history, raw] = await Promise.all([
    db.select().from(voucherLines).where(eq(voucherLines.voucherId, voucherId)).orderBy(asc(voucherLines.lineNo)),
    db.select().from(corrections).where(eq(corrections.voucherId, voucherId)).orderBy(desc(corrections.createdAt)),
    voucher.rawDocumentId
      ? db.select().from(rawDocuments).where(eq(rawDocuments.id, voucher.rawDocumentId)).limit(1)
      : Promise.resolve([]),
  ]);

  return { voucher, lines, corrections: history, rawDocument: raw[0] ?? null };
}

/* ---------------------------------------------------------- krever handling */

export interface ActionItems {
  /** Banktransaksjoner uten kvittering. */
  missingDocumentation: Voucher[];
  /** Lav confidence eller manglende felt. */
  needsReview: Voucher[];
  /** Foreslåtte, ubesluttede matcher. */
  proposedMatches: Array<{
    match: typeof voucherMatches.$inferSelect;
    bank: Voucher | undefined;
    document: Voucher | undefined;
  }>;
  /** Kanaler som venter på at brukeren gjør noe. */
  channelsNeedingAuth: Array<typeof ingestionChannels.$inferSelect>;
}

export async function loadActionItems(userId: string): Promise<ActionItems> {
  const db = getDb();

  const [missingDocumentation, needsReview, matches, channelsNeedingAuth] = await Promise.all([
    db
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.userId, userId),
          eq(vouchers.needsDocumentation, true),
          ne(vouchers.status, "duplicate"),
        ),
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

  // Bilagene til forslagene hentes i ETT oppslag, ikke ett per forslag.
  const ids = matches.flatMap((m) => [m.bankVoucherId, m.documentVoucherId]);
  const involved =
    ids.length > 0
      ? await db.select().from(vouchers).where(and(eq(vouchers.userId, userId), inArray(vouchers.id, ids)))
      : [];
  const byId = new Map(involved.map((v) => [v.id, v]));

  return {
    missingDocumentation,
    needsReview,
    proposedMatches: matches.map((match) => ({
      match,
      bank: byId.get(match.bankVoucherId),
      document: byId.get(match.documentVoucherId),
    })),
    channelsNeedingAuth,
  };
}

export async function countActionItems(userId: string): Promise<number> {
  const items = await loadActionItems(userId);
  return (
    items.missingDocumentation.length +
    items.needsReview.length +
    items.proposedMatches.length +
    items.channelsNeedingAuth.length
  );
}

/* ------------------------------------------------------------- dashboard -- */

export interface DashboardData {
  months: Array<{ month: string; income: number; expense: number }>;
  categories: Array<{ category: string; direction: string; total: number; count: number }>;
  channels: Array<{ channel: string; total: number; count: number }>;
  totals: { income: number; expense: number; result: number; vouchers: number };
}

/**
 * Tall til forsiden.
 *
 * Alt regnes i `amount_nok` - beløpet er allerede omregnet og LAGRET på
 * bilaget med kursen fra transaksjonsdatoen. Vi regner aldri om ved lesing;
 * da ville forsiden endret seg fra dag til dag for de samme bilagene.
 *
 * Duplikater holdes utenfor overalt: et bankbilag som er slått sammen med en
 * kvittering ville ellers telt beløpet to ganger.
 */
export async function loadDashboard(userId: string, year: number): Promise<DashboardData> {
  const db = getDb();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const base = and(
    eq(vouchers.userId, userId),
    ne(vouchers.status, "duplicate"),
    gte(vouchers.date, from),
    lte(vouchers.date, to),
  );

  const [months, categories, channels] = await Promise.all([
    db
      .select({
        month: sql<string>`to_char(${vouchers.date}, 'YYYY-MM')`,
        direction: vouchers.direction,
        total: sql<number>`coalesce(sum(${vouchers.amountNok}), 0)::bigint`,
      })
      .from(vouchers)
      .where(base)
      .groupBy(sql`to_char(${vouchers.date}, 'YYYY-MM')`, vouchers.direction)
      .orderBy(sql`to_char(${vouchers.date}, 'YYYY-MM')`),
    db
      .select({
        category: sql<string>`coalesce(${vouchers.category}, 'ukategorisert')`,
        direction: vouchers.direction,
        total: sql<number>`coalesce(sum(${vouchers.amountNok}), 0)::bigint`,
        count: count(),
      })
      .from(vouchers)
      .where(base)
      .groupBy(vouchers.category, vouchers.direction)
      .orderBy(desc(sql`sum(${vouchers.amountNok})`)),
    db
      .select({
        channel: vouchers.sourceChannel,
        total: sql<number>`coalesce(sum(${vouchers.amountNok}), 0)::bigint`,
        count: count(),
      })
      .from(vouchers)
      .where(base)
      .groupBy(vouchers.sourceChannel),
  ]);

  const byMonth = new Map<string, { month: string; income: number; expense: number }>();
  for (const row of months) {
    const entry = byMonth.get(row.month) ?? { month: row.month, income: 0, expense: 0 };
    if (row.direction === "income") entry.income = Number(row.total);
    else entry.expense = Number(row.total);
    byMonth.set(row.month, entry);
  }

  const income = [...byMonth.values()].reduce((a, m) => a + m.income, 0);
  const expense = [...byMonth.values()].reduce((a, m) => a + m.expense, 0);
  const voucherCount = channels.reduce((a, c) => a + Number(c.count), 0);

  return {
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: categories.map((c) => ({
      category: c.category,
      direction: c.direction,
      total: Number(c.total),
      count: Number(c.count),
    })),
    channels: channels.map((c) => ({
      channel: c.channel,
      total: Number(c.total),
      count: Number(c.count),
    })),
    totals: { income, expense, result: income - expense, vouchers: voucherCount },
  };
}

/* ------------------------------------------------------------------- mva -- */

export interface VatTermSummary {
  term: number;
  from: string;
  to: string;
  outgoing: Array<{ code: VatCode; rate: number; base: number; vat: number }>;
  incoming: Array<{ code: VatCode; rate: number; base: number; vat: number }>;
  reverseCharge: { base: number; vat: number; count: number };
  net: number;
}

/**
 * MVA per termin.
 *
 * `reverse_charge` skilles ut i en egen bolk med vilje. Ved omvendt
 * avgiftsplikt skal kjøperen selv beregne 25 % utgående MVA og føre det
 * samme beløpet som inngående. Nettoeffekten er null for en
 * fradragsberettiget virksomhet, men BEGGE tallene skal stå i MVA-meldingen -
 * og at de ikke gjør det er en av de vanligste feilene i småbedrifter.
 */
export async function loadVatSummary(userId: string, year: number): Promise<VatTermSummary[]> {
  const db = getDb();

  const rows = await db
    .select({
      date: vouchers.date,
      direction: vouchers.direction,
      vatCode: vouchers.vatCode,
      netAmount: vouchers.netAmount,
      vatAmount: vouchers.vatAmount,
      amountNok: vouchers.amountNok,
      grossAmount: vouchers.grossAmount,
      currency: vouchers.currency,
      exchangeRate: vouchers.exchangeRate,
      reverseCharge: vouchers.reverseCharge,
    })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.userId, userId),
        ne(vouchers.status, "duplicate"),
        gte(vouchers.date, `${year}-01-01`),
        lte(vouchers.date, `${year}-12-31`),
      ),
    );

  const terms = new Map<number, VatTermSummary>();
  for (let t = 1; t <= 6; t++) {
    const { from, to } = vatTermFor(`${year}-${String((t - 1) * 2 + 1).padStart(2, "0")}-01`);
    terms.set(t, {
      term: t,
      from,
      to,
      outgoing: [],
      incoming: [],
      reverseCharge: { base: 0, vat: 0, count: 0 },
      net: 0,
    });
  }

  for (const row of rows) {
    const { term } = vatTermFor(row.date);
    const summary = terms.get(term);
    if (!summary) continue;

    // Alt rapporteres i NOK. MVA-beløpet er lagret i bilagets valuta, så det
    // skaleres med den samme kursen som ble brukt på totalen - ikke med en
    // ny kurs hentet i dag.
    const rate = Number(row.exchangeRate) || 1;
    const scale = row.currency === "NOK" ? 1 : rate;
    const vatNok = Math.round((row.vatAmount ?? 0) * scale);
    const netNok = Math.round((row.netAmount ?? row.grossAmount) * scale);

    if (row.reverseCharge || row.vatCode === "reverse_charge") {
      const computed = Math.round((netNok * 25) / 100);
      summary.reverseCharge.base += netNok;
      summary.reverseCharge.vat += computed;
      summary.reverseCharge.count += 1;
      continue;
    }

    if (!row.vatCode) continue;

    const bucket = row.direction === "income" ? summary.outgoing : summary.incoming;
    const existing = bucket.find((b) => b.code === row.vatCode);
    if (existing) {
      existing.base += netNok;
      existing.vat += vatNok;
    } else {
      bucket.push({
        code: row.vatCode as VatCode,
        rate: VAT_RATES[row.vatCode as VatCode],
        base: netNok,
        vat: vatNok,
      });
    }
  }

  for (const summary of terms.values()) {
    const out = summary.outgoing.reduce((a, b) => a + b.vat, 0);
    const inn = summary.incoming.reduce((a, b) => a + b.vat, 0);
    // Omvendt avgiftsplikt går inn på begge sider og går i null for en
    // fradragsberettiget virksomhet - derfor påvirker den ikke `net`.
    summary.net = out - inn;
  }

  return [...terms.values()];
}

/* --------------------------------------------------------------- kanaler -- */

export async function listChannelRows(userId: string) {
  const db = getDb();
  return db
    .select()
    .from(ingestionChannels)
    .where(eq(ingestionChannels.userId, userId))
    .orderBy(asc(ingestionChannels.createdAt));
}

/** Distinkte kategorier i bruk - fyller filtermenyen i bilagslista. */
export async function listUsedCategories(userId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ category: vouchers.category })
    .from(vouchers)
    .where(and(eq(vouchers.userId, userId), isNull(vouchers.supersedesVoucherId)));
  return rows.map((r) => r.category).filter((c): c is string => Boolean(c)).sort();
}

export { bankTransactions, sum };
