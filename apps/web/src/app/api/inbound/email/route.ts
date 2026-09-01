/**
 * INNKOMMENDE E-POST - den kritiske stien i hele referanseimplementasjonen.
 *
 * Rekkefølgen er ikke tilfeldig, og skal ikke endres:
 *
 *   1. VERIFISER SIGNATUREN. Uten dette kan hvem som helst POSTe falske bilag
 *      inn i regnskapet ditt. Feil signatur -> 401, og vi leser ikke kroppen.
 *   2. Normaliser til `InboundEmail`. Mailgun, Postmark og MailHog-broen ser
 *      ulike ut på tråden og helt like etter dette punktet.
 *   3. Slå opp brukeren på lokaldelen av mottakeradressen.
 *   4. La kanalen lage `DocumentItem` - ruten vet ikke hva et bilag er.
 *   5. Lagre rått, køe ekstraksjonen.
 *   6. SVAR 200 RASKT. Alt tungt skjer i workeren.
 *
 * To statuskoder som ser rare ut, men er riktige:
 *   - Ukjent slug gir 200, ikke 404. En 404 får leverandøren til å retrye i
 *     evighet på en adresse som aldri kommer til å finnes.
 *   - Dublett gir 200. Leverandøren gjorde jobben sin; vi hadde den bare fra før.
 */
import { NextResponse } from "next/server";
import { eq, getDb, ingestionChannels, users, and } from "@qbikk/db";
import { getBlobStore, storeRawDocument } from "@qbikk/core";
import { config } from "@qbikk/core/config";
import {
  emailForwardChannel,
  normalizeMailgun,
  slugFromRecipient,
  verifyMailgunSignature,
  verifySharedSecret,
  type InboundEmail,
  type IncomingAttachment,
} from "@qbikk/ingestion";
import { JOBS, sendJob } from "@qbikk/jobs";
import { getQueue } from "@/lib/queue";

export const runtime = "nodejs";
/** Webhooks skal aldri caches, og skal aldri prerenderes. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const cfg = config();

  let payload: InboundEmail;

  try {
    if (cfg.INBOUND_PROVIDER === "mailgun") {
      const form = await request.formData();
      const fields: Record<string, string> = {};
      const files: IncomingAttachment[] = [];

      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          fields[key] = value;
        } else {
          files.push({
            filename: value.name || null,
            mime: value.type || "application/octet-stream",
            data: Buffer.from(await value.arrayBuffer()),
          });
        }
      }

      const ok = verifyMailgunSignature(
        {
          timestamp: fields.timestamp ?? "",
          token: fields.token ?? "",
          signature: fields.signature ?? "",
        },
        cfg.INBOUND_WEBHOOK_SECRET,
      );
      if (!ok) return unauthorized();

      payload = normalizeMailgun(fields, files);
    } else {
      // Postmark og MailHog-broen: delt hemmelighet i en header, og en kropp
      // som allerede har InboundEmail-formen.
      const provided =
        request.headers.get("x-qbikk-secret") ?? request.headers.get("x-postmark-token");
      if (!verifySharedSecret(provided, cfg.INBOUND_WEBHOOK_SECRET)) return unauthorized();

      payload = (await request.json()) as InboundEmail;
    }
  } catch (err) {
    console.error("[inbound] klarte ikke å lese webhook-kroppen:", err);
    return NextResponse.json({ ok: false, error: "Ugyldig kropp" }, { status: 400 });
  }

  const slug = slugFromRecipient(payload.To);
  if (!slug) {
    console.warn("[inbound] mottaker uten gyldig lokaldel:", payload.To);
    return NextResponse.json({ ok: true, ignored: "ugyldig mottaker" });
  }

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.inboundSlug, slug)).limit(1);
  if (!user) {
    // 200, ikke 404 - se filhodet.
    console.warn("[inbound] ukjent bilagsadresse:", slug);
    return NextResponse.json({ ok: true, ignored: "ukjent adresse" });
  }

  const [channel] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.userId, user.id), eq(ingestionChannels.type, "email_forward")))
    .limit(1);

  const items = await emailForwardChannel.receive(
    {
      userId: user.id,
      channelId: channel?.id ?? "email_forward",
      config: { slug, allowedSenders: [] },
      logger: consoleLogger,
      signal: request.signal,
    },
    payload,
  );

  const boss = await getQueue();
  const stored: string[] = [];
  let duplicates = 0;

  for (const item of items) {
    if (item.kind !== "document") continue;

    const result = await storeRawDocument(db, getBlobStore(), {
      userId: user.id,
      channelId: channel?.id ?? null,
      channelType: "email_forward",
      item,
    });

    if (result.isDuplicate) {
      duplicates++;
      continue;
    }
    stored.push(result.rawDocumentId);
    await sendJob(boss, JOBS.extractDocument, {
      userId: user.id,
      rawDocumentId: result.rawDocumentId,
    });
  }

  if (channel) {
    await db
      .update(ingestionChannels)
      .set({ lastSyncAt: new Date(), lastError: null, consecutiveFailures: 0 })
      .where(eq(ingestionChannels.id, channel.id));
  }

  return NextResponse.json({ ok: true, received: stored.length, duplicates });
}

function unauthorized(): NextResponse {
  // Ingen detaljer i svaret: en angriper skal ikke få vite HVA som var galt
  // med signaturen sin.
  console.warn("[inbound] avviste webhook med ugyldig signatur");
  return NextResponse.json({ ok: false }, { status: 401 });
}

const consoleLogger = {
  debug: (m: string, meta?: Record<string, unknown>) => console.debug("[inbound]", m, meta ?? ""),
  info: (m: string, meta?: Record<string, unknown>) => console.info("[inbound]", m, meta ?? ""),
  warn: (m: string, meta?: Record<string, unknown>) => console.warn("[inbound]", m, meta ?? ""),
  error: (m: string, meta?: Record<string, unknown>) => console.error("[inbound]", m, meta ?? ""),
};
