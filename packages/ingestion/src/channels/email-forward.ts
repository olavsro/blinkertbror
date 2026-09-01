/**
 * KANAL 1 - Videresendingsadresse.
 *
 * Den viktigste kanalen, og for de fleste brukere hele onboardingen:
 * de får adressen `ola-4f9c@bilag.minapp.no`, setter opp én videresendingsregel
 * hos seg selv eller bytter fakturaadresse hos leverandørene, og er ferdig.
 *
 * MOTTAK I UTVIKLING
 *   MailHog i docker-compose tar imot SMTP på 1025. `scripts/mailhog-bridge.ts`
 *   poller MailHog og POSTer til `/api/inbound/email` i NØYAKTIG samme form som
 *   produksjonsleverandøren. Det gir én kodevei lokalt og i drift.
 *
 * MOTTAK I PRODUKSJON
 *   Mailgun Routes eller Postmark Inbound tar imot på MX for bilag-domenet,
 *   parser MIME og POSTer til samme endepunkt. Du slipper å drifte SMTP,
 *   spamfiltrering og TLS. Begge har gratisnivå som holder lenge.
 *
 * Kanalen er `push`, ikke `pull`: den har ingen tilstand og trenger ingen
 * cursor. Feiler mottaket, retryer leverandøren selv.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { htmlToText } from "@qbikk/core/text";
import type {
  ChannelContext,
  ChannelHealth,
  DocumentItem,
  IncomingAttachment,
  IngestionChannel,
  SetupResult,
} from "../types.js";

export const emailForwardConfigSchema = z.object({
  /** Lokaldelen brukeren har fått tildelt. */
  slug: z.string().min(3),
  /** Adresser vi godtar videresending fra. Tom = alle. */
  allowedSenders: z.array(z.string()).default([]),
});

export type EmailForwardConfig = z.infer<typeof emailForwardConfigSchema>;

/**
 * Felles form for innkommende e-post. Postmark sender denne direkte;
 * Mailgun normaliseres til den i `normalizeMailgun`. MailHog-broen i
 * utvikling produserer også denne.
 */
export interface InboundEmail {
  From: string;
  To: string;
  Subject: string | null;
  TextBody: string | null;
  HtmlBody: string | null;
  MessageID: string | null;
  Date: string | null;
  Attachments: Array<{
    Name: string;
    /** base64 */
    Content: string;
    ContentType: string;
    ContentLength?: number;
    ContentID?: string | null;
  }>;
  /** Hele MIME-meldingen når leverandøren gir oss den. Lagres uendret. */
  RawEmail?: string | null;
  Headers?: Record<string, string>;
}

export class EmailForwardChannel implements IngestionChannel<EmailForwardConfig, InboundEmail> {
  readonly type = "email_forward" as const;
  readonly label = "Videresendingsadresse";
  readonly capabilities = {
    push: true,
    pull: false,
    backfill: false,
    producesDocuments: true,
    producesTransactions: false,
    requiresCredentials: false,
    fragile: false,
  };
  readonly configSchema = emailForwardConfigSchema;

  async setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult> {
    const slug = String(input.params.slug ?? "");
    const domain = String(input.params.domain ?? process.env.INBOUND_EMAIL_DOMAIN ?? "bilag.minapp.no");
    const address = `${slug}@${domain}`;

    return {
      config: { slug, allowedSenders: [] },
      meta: { address },
      instructions: [
        {
          title: "Din bilagsadresse",
          body: "Alt som sendes hit blir automatisk lest og lagt inn som bilag. Adressen er personlig - del den bare med leverandører du handler hos.",
          copyValue: address,
        },
        {
          title: "Sett opp videresending i e-posten din",
          body: "Lag én regel i Gmail eller Outlook som videresender e-post med ordene «kvittering», «faktura», «receipt» eller «invoice» til adressen over. Det er alt som skal til.",
        },
        {
          title: "Eller bytt fakturaadresse hos leverandørene",
          body: "For abonnementer du betaler fast (strøm, programvare, grossist) kan du oppgi adressen over som fakturamottaker. Da kommer bilaget rett inn uten videresending.",
        },
      ],
    };
  }

  async healthCheck(_ctx: ChannelContext<EmailForwardConfig>): Promise<ChannelHealth> {
    // Ingenting å teste - kanalen er passiv. Den er frisk så lenge den finnes.
    return { ok: true, message: "Klar til å ta imot e-post", checkedAt: new Date() };
  }

  async receive(
    ctx: Omit<ChannelContext<EmailForwardConfig>, "cursor">,
    payload: InboundEmail,
  ): Promise<DocumentItem[]> {
    const allowed = ctx.config.allowedSenders;
    const sender = extractAddress(payload.From);
    if (allowed.length > 0 && sender && !allowed.includes(sender)) {
      ctx.logger.warn("Avviste e-post fra ukjent avsender", { sender });
      return [];
    }

    const attachments = decodeAttachments(payload.Attachments ?? []);
    const text = payload.TextBody?.trim() || (payload.HtmlBody ? htmlToText(payload.HtmlBody) : null);

    const item: DocumentItem = {
      kind: "document",
      externalRef: payload.MessageID ?? null,
      receivedAt: payload.Date ? new Date(payload.Date) : new Date(),
      subject: payload.Subject ?? null,
      sender,
      recipient: extractAddress(payload.To),
      text,
      html: payload.HtmlBody ?? null,
      // Har vi hele MIME-meldingen lagrer vi den; ellers lagrer vi brødteksten
      // som råbytes. Uansett har vi noe uendret å vise en revisor om fem år.
      raw: payload.RawEmail ? Buffer.from(payload.RawEmail, "utf8") : Buffer.from(text ?? "", "utf8"),
      rawMime: payload.RawEmail ? "message/rfc822" : "text/plain",
      attachments,
      rawPayload: {
        headers: payload.Headers ?? {},
        messageId: payload.MessageID,
        to: payload.To,
        from: payload.From,
      },
    };

    ctx.logger.info("Mottok e-post", {
      sender,
      subject: payload.Subject,
      attachments: attachments.length,
    });

    return [item];
  }
}

export const emailForwardChannel = new EmailForwardChannel();

/* ------------------------------------------------------------- hjelpere ---- */

function decodeAttachments(
  raw: InboundEmail["Attachments"],
): IncomingAttachment[] {
  return raw
    .map((a) => ({
      filename: a.Name || null,
      mime: a.ContentType || "application/octet-stream",
      data: Buffer.from(a.Content, "base64"),
      contentId: a.ContentID ?? null,
      // Innebygde bilder med Content-ID er nesten alltid logoer i signaturen.
      // Vi kaster dem ikke - vi markerer dem, så ekstraksjonen kan prioritere.
      inline: Boolean(a.ContentID),
    }))
    .filter((a) => a.data.byteLength > 0);
}

export function extractAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^>]+)>/);
  const raw = angle ? angle[1]! : value;
  const trimmed = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(trimmed) ? trimmed : null;
}

/** Lokaldelen av mottakeradressen - det er den som identifiserer brukeren. */
export function slugFromRecipient(recipient: string | null): string | null {
  const address = extractAddress(recipient);
  if (!address) return null;
  const local = address.split("@")[0];
  // Gmail-stil "+"-suffiks skal ikke ødelegge oppslaget.
  return local ? local.split("+")[0]! : null;
}

/* ------------------------------------------------- leverandørnormalisering - */

/** Mailgun POSTer multipart/form-data med sine egne feltnavn. */
export function normalizeMailgun(
  fields: Record<string, string>,
  attachments: IncomingAttachment[],
): InboundEmail {
  return {
    From: fields.from ?? fields.sender ?? "",
    To: fields.recipient ?? fields.To ?? "",
    Subject: fields.subject ?? null,
    TextBody: fields["stripped-text"] ?? fields["body-plain"] ?? null,
    HtmlBody: fields["stripped-html"] ?? fields["body-html"] ?? null,
    MessageID: fields["Message-Id"] ?? fields["message-id"] ?? null,
    Date: fields.Date ?? fields.date ?? null,
    Attachments: attachments.map((a) => ({
      Name: a.filename ?? "vedlegg",
      Content: a.data.toString("base64"),
      ContentType: a.mime,
      ContentLength: a.data.byteLength,
      ContentID: a.contentId ?? null,
    })),
    RawEmail: fields["body-mime"] ?? null,
    Headers: safeParseHeaders(fields["message-headers"]),
  };
}

function safeParseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as [string, string][];
    return Object.fromEntries(parsed);
  } catch {
    return {};
  }
}

/* ----------------------------------------------------------- verifisering -- */

/**
 * Mailgun signerer med HMAC-SHA256 over timestamp+token.
 * Uten dette kan hvem som helst POSTe falske bilag inn i regnskapet ditt.
 */
export function verifyMailgunSignature(
  input: { timestamp: string; token: string; signature: string },
  signingKey: string,
): boolean {
  const expected = createHmac("sha256", signingKey)
    .update(input.timestamp + input.token)
    .digest("hex");
  return safeEqual(expected, input.signature);
}

/** Postmark og MailHog-broen bruker en delt hemmelighet i en header. */
export function verifySharedSecret(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  return safeEqual(provided, expected);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
