/**
 * KANAL 2 - Bakoversøk i innboksen (IMAP / Gmail).
 *
 * Videresending (kanal 1) fanger alt som kommer FRA NÅ AV. Denne kanalen
 * finner de tre årene som allerede ligger i innboksen. For en bruker som
 * setter opp systemet i mars er det forskjellen på et halvferdig regnskap og
 * et komplett et.
 *
 * SØKET ER MED VILJE SNEVERT. Vi leser ikke hele innboksen - vi søker på ord
 * som «kvittering», «faktura», «receipt», «invoice». Det er både et
 * personvernhensyn og et kostnadshensyn: hver treff koster en ekstraksjon.
 *
 * imapflow og mailparser importeres DYNAMISK inne i pull(). Registret laster
 * alle kanaler ved oppstart, og en webprosess som bare skal ta imot en webhook
 * skal ikke dra inn en IMAP-klient for å komme dit.
 */
import { z } from "zod";
import { htmlToText } from "@qbikk/core/text";
import {
  ChannelAuthError,
  ChannelTemporaryError,
  type ChannelContext,
  type ChannelHealth,
  type Cursor,
  type DocumentItem,
  type IngestionChannel,
  type IngestionItem,
  type SetupResult,
} from "../types.js";

export const inboxScanConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1),
  /**
   * App-passord eller OAuth access token. Lagres ALLTID kryptert av kalleren
   * (`encryptJson`), aldri i `config_meta`.
   *
   * For Gmail bør dette være et OAuth-token, ikke et app-passord: et
   * app-passord gir full og evigvarende tilgang til hele postkassen, og kan
   * ikke begrenses til lesing.
   */
  pass: z.string().min(1),
  authMethod: z.enum(["password", "oauth2"]).default("password"),
  mailbox: z.string().default("INBOX"),
  /** Hvor langt bakover en full backfill går. */
  backfillMonths: z.number().int().positive().default(24),
});

export type InboxScanConfig = z.infer<typeof inboxScanConfigSchema>;

/** Ordene som skiller et bilag fra resten av innboksen. */
export const RECEIPT_TERMS = [
  "kvittering",
  "faktura",
  "receipt",
  "invoice",
  "order confirmation",
  "ordrebekreftelse",
] as const;

interface InboxCursor extends Cursor {
  /** Nullstilles av serveren når UID-ene ikke lenger er gyldige. */
  uidValidity: string | null;
  lastUid: number;
}

export class InboxScanChannel implements IngestionChannel<InboxScanConfig, never> {
  readonly type = "inbox_scan" as const;
  readonly label = "Søk i innboksen";
  readonly capabilities = {
    push: false,
    pull: true,
    backfill: true,
    producesDocuments: true,
    producesTransactions: false,
    requiresCredentials: true,
    fragile: false,
  };
  readonly configSchema = inboxScanConfigSchema;

  async setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult> {
    const config = inboxScanConfigSchema.parse(input.params);
    return {
      // `pass` havner i config og krypteres av kalleren. Den skal aldri i meta.
      config,
      meta: { host: config.host, user: config.user, mailbox: config.mailbox },
      instructions: [
        {
          title: "Bruk app-passord, ikke hovedpassordet",
          body: "Gmail og Outlook lar deg lage et eget passord for enkeltprogrammer. Da kan du trekke tilgangen tilbake uten å bytte passordet ditt.",
          actionUrl: "https://myaccount.google.com/apppasswords",
        },
        {
          title: "Vi leser bare bilag",
          body: `Vi søker etter e-post som inneholder ${RECEIPT_TERMS.join(", ")} og henter bare de. Resten av innboksen røres ikke.`,
        },
      ],
    };
  }

  async healthCheck(ctx: ChannelContext<InboxScanConfig>): Promise<ChannelHealth> {
    try {
      const client = await connect(ctx.config, ctx.signal);
      await client.logout();
      return { ok: true, message: `Tilkoblet ${ctx.config.host}`, checkedAt: new Date() };
    } catch (err) {
      const needsUserAction = err instanceof ChannelAuthError;
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        needsUserAction,
        checkedAt: new Date(),
      };
    }
  }

  async *pull(
    ctx: ChannelContext<InboxScanConfig>,
    options?: { since?: Date; full?: boolean },
  ): AsyncIterable<IngestionItem> {
    const { simpleParser } = await import("mailparser");
    const cursor = readCursor(ctx.cursor);
    const client = await connect(ctx.config, ctx.signal);

    try {
      const lock = await client.getMailboxLock(ctx.config.mailbox);
      try {
        const box = client.mailbox;
        const uidValidity = box && typeof box !== "boolean" ? String(box.uidValidity) : null;

        // Serveren har bygget om postkassen: UID-ene våre peker på feil
        // meldinger nå. Da er det eneste trygge å begynne forfra.
        const validityChanged = cursor.uidValidity !== null && cursor.uidValidity !== uidValidity;
        const full = options?.full === true || validityChanged;
        if (validityChanged) {
          ctx.logger.warn("UIDVALIDITY endret seg - tar full backfill", {
            before: cursor.uidValidity,
            after: uidValidity,
          });
        }

        const since =
          options?.since ??
          (full ? monthsAgo(ctx.config.backfillMonths) : undefined);

        const uids = await searchForReceipts(client, { full, since, lastUid: cursor.lastUid });
        ctx.logger.info("Fant kandidater i innboksen", { count: uids.length });

        for (const uid of uids) {
          if (ctx.signal.aborted) return;

          const message = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
          if (!message || typeof message === "boolean" || !message.source) continue;

          const parsed = await simpleParser(message.source);
          yield toDocumentItem(parsed, uid, message.source);
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * Cursor = (uidValidity, høyeste UID vi har sett).
   *
   * UID-en alene holder ikke: den er bare unik innenfor én uidValidity. Endrer
   * serveren den, betyr «UID 5012» plutselig noe helt annet, og vi ville
   * hoppet over ekte bilag i stillhet.
   */
  nextCursor(items: IngestionItem[], previous: Cursor | null): Cursor {
    const prev = readCursor(previous);
    let lastUid = prev.lastUid;
    for (const item of items) {
      if (item.kind !== "document") continue;
      const uid = Number(item.externalRef?.replace(/^imap:/, ""));
      if (Number.isFinite(uid) && uid > lastUid) lastUid = uid;
    }
    return { ...prev, lastUid };
  }
}

export const inboxScanChannel = new InboxScanChannel();

/* ------------------------------------------------------------- hjelpere -- */

/** Minimumsformen vi trenger av imapflow. Holder resten av filen typet. */
interface ImapLike {
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  mailbox: { uidValidity: bigint | number } | boolean | undefined;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    options: { uid: true },
  ): Promise<{ source?: Buffer } | boolean | undefined>;
  logout(): Promise<void>;
  connect(): Promise<void>;
}

async function connect(config: InboxScanConfig, signal: AbortSignal): Promise<ImapLike> {
  const { ImapFlow } = await import("imapflow");

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.authMethod === "oauth2"
        ? { user: config.user, accessToken: config.pass }
        : { user: config.user, pass: config.pass },
    logger: false,
  }) as unknown as ImapLike;

  try {
    await client.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Feil passord fikser seg ikke av å prøve igjen - brukeren må inn.
    if (/auth|credential|login|invalid/i.test(message)) {
      throw new ChannelAuthError(`Innlogging mot ${config.host} feilet: ${message}`);
    }
    throw new ChannelTemporaryError(`Fikk ikke kontakt med ${config.host}: ${message}`, 300);
  }

  signal.addEventListener("abort", () => void client.logout().catch(() => undefined), { once: true });
  return client;
}

/**
 * Søker etter bilag.
 *
 * IMAP har ingen OR over vilkårlig mange ledd i imapflow sitt API, så vi
 * kjører ett søk per ord og slår sammen. Det er flere rundturer, men det gjør
 * søket lesbart og lar oss legge til ord uten å bygge et uttrykkstre.
 */
async function searchForReceipts(
  client: ImapLike,
  opts: { full: boolean; since?: Date; lastUid: number },
): Promise<number[]> {
  const found = new Set<number>();

  for (const term of RECEIPT_TERMS) {
    for (const field of ["subject", "body"] as const) {
      const query: Record<string, unknown> = { [field]: term };
      if (opts.since) query.since = opts.since;
      // Inkrementelt: bare UID-er vi ikke har sett. `${n}:*` er IMAP for
      // «fra n og oppover».
      if (!opts.full && opts.lastUid > 0) query.uid = `${opts.lastUid + 1}:*`;

      const result = await client.search(query, { uid: true });
      if (!result) continue;
      for (const uid of result) {
        if (opts.full || uid > opts.lastUid) found.add(uid);
      }
    }
  }

  return [...found].sort((a, b) => a - b);
}

interface ParsedMailLike {
  subject?: string;
  from?: { text?: string };
  to?: { text?: string } | Array<{ text?: string }>;
  date?: Date;
  text?: string;
  html?: string | false;
  messageId?: string;
  attachments?: Array<{
    filename?: string;
    contentType?: string;
    content: Buffer;
    contentId?: string;
    contentDisposition?: string;
  }>;
}

function toDocumentItem(parsed: ParsedMailLike, uid: number, source: Buffer): DocumentItem {
  const html = typeof parsed.html === "string" ? parsed.html : null;
  const to = Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to?.text;

  return {
    kind: "document",
    // UID-en er prefikset slik at den ikke forveksles med en Message-ID.
    externalRef: `imap:${uid}`,
    receivedAt: parsed.date ?? new Date(),
    subject: parsed.subject ?? null,
    sender: parsed.from?.text ?? null,
    recipient: to ?? null,
    text: parsed.text?.trim() || (html ? htmlToText(html) : null),
    html,
    // Hele MIME-meldingen lagres uendret - det er den en revisor får se.
    raw: source,
    rawMime: "message/rfc822",
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      mime: a.contentType ?? "application/octet-stream",
      data: a.content,
      contentId: a.contentId ?? null,
      inline: a.contentDisposition === "inline" || Boolean(a.contentId),
    })),
    rawPayload: { uid, messageId: parsed.messageId ?? null },
  };
}

function readCursor(cursor: Cursor | null): InboxCursor {
  const uidValidity = cursor?.uidValidity;
  const lastUid = Number(cursor?.lastUid ?? 0);
  return {
    uidValidity: typeof uidValidity === "string" ? uidValidity : null,
    lastUid: Number.isFinite(lastUid) ? lastUid : 0,
  };
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}
