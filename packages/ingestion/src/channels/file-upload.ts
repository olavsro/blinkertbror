/**
 * KANAL 4a - Opplasting (drag & drop, mobilfoto).
 *
 * Den enkleste kanalen, og den som redder papirkvitteringene. Brukeren tar et
 * bilde av kvitteringen fra kaffebaren og laster det opp; Claude leser bildet
 * direkte. INGEN EGEN OCR-PIPELINE - det er hele poenget med å ha valgt en
 * modell som ser.
 *
 * Kanalen er `push`: web-ruten kaller `receive()` med filene, akkurat som
 * e-postruten kaller `receive()` med en e-post. At den ene kommer fra en
 * webhook og den andre fra en `<input type="file">` er usynlig bak
 * grensesnittet.
 */
import { z } from "zod";
import {
  type ChannelContext,
  type ChannelHealth,
  type DocumentItem,
  type IngestionChannel,
  type SetupResult,
} from "../types.js";

export const fileUploadConfigSchema = z.object({
  /** Maksstørrelse per fil. Et mobilfoto er 3-8 MB; 25 MB tar høyde for PDF-er. */
  maxBytes: z.number().int().positive().default(25 * 1024 * 1024),
});

export type FileUploadConfig = z.infer<typeof fileUploadConfigSchema>;

/** Det ekstraktoren faktisk kan lese. Alt annet avvises med en gang. */
export const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "text/plain",
  "text/html",
]);

export interface UploadedFile {
  filename: string | null;
  mime: string;
  data: Buffer;
}

export interface UploadPayload {
  files: UploadedFile[];
  /** Fri tekst brukeren skrev ved opplasting. Blir kontekst for ekstraksjonen. */
  note?: string | null;
  receivedAt?: Date;
}

export class FileUploadChannel implements IngestionChannel<FileUploadConfig, UploadPayload> {
  readonly type = "file_upload" as const;
  readonly label = "Last opp fil";
  readonly capabilities = {
    push: true,
    pull: false,
    backfill: false,
    producesDocuments: true,
    producesTransactions: false,
    requiresCredentials: false,
    fragile: false,
  };
  readonly configSchema = fileUploadConfigSchema;

  async setup(): Promise<SetupResult> {
    return {
      config: fileUploadConfigSchema.parse({}),
      instructions: [
        {
          title: "Dra filer inn i vinduet",
          body: "PDF-faktura, skjermbilde eller et bilde av en papirkvittering - alt går. Bildet leses direkte, du trenger ikke skanne noe.",
        },
        {
          title: "Ta bildet med hele kvitteringen synlig",
          body: "Beløp, dato og butikknavn må være med. Er noe uleselig, havner bilaget til gjennomgang i stedet for å bli gjettet på.",
        },
      ],
    };
  }

  async healthCheck(): Promise<ChannelHealth> {
    return { ok: true, message: "Klar til å ta imot filer", checkedAt: new Date() };
  }

  /**
   * ÉN FIL = ÉTT DOKUMENT.
   *
   * Laster brukeren opp fem kvitteringer samtidig, er det fem bilag - ikke ett
   * med fem vedlegg. Hvert bilag skal kunne bokføres og korrigeres for seg.
   */
  async receive(
    ctx: Omit<ChannelContext<FileUploadConfig>, "cursor">,
    payload: UploadPayload,
  ): Promise<DocumentItem[]> {
    const receivedAt = payload.receivedAt ?? new Date();
    const items: DocumentItem[] = [];

    for (const file of payload.files) {
      if (file.data.byteLength === 0) continue;

      if (file.data.byteLength > ctx.config.maxBytes) {
        ctx.logger.warn("Hoppet over for stor fil", {
          filename: file.filename,
          bytes: file.data.byteLength,
        });
        continue;
      }
      if (!ACCEPTED_MIME.has(file.mime)) {
        ctx.logger.warn("Hoppet over filtype vi ikke kan lese", {
          filename: file.filename,
          mime: file.mime,
        });
        continue;
      }

      const isText = file.mime === "text/plain" || file.mime === "text/html";

      items.push({
        kind: "document",
        // Filnavn er ikke unikt ("IMG_0421.jpg"), så det er ikke en externalRef.
        // Dedupen går uansett på sha256 over innholdet.
        externalRef: null,
        receivedAt,
        subject: file.filename,
        sender: null,
        recipient: null,
        text: isText ? file.data.toString("utf8") : (payload.note ?? null),
        html: file.mime === "text/html" ? file.data.toString("utf8") : null,
        raw: file.data,
        rawMime: file.mime,
        // Selve filen er BÅDE råbytene og vedlegget: rådokumentet er det vi
        // arkiverer, vedlegget er det ekstraktoren får se.
        attachments: isText
          ? []
          : [{ filename: file.filename, mime: file.mime, data: file.data, inline: false }],
        rawPayload: { filename: file.filename, note: payload.note ?? null, source: "upload" },
      });
    }

    ctx.logger.info("Tok imot opplasting", { files: payload.files.length, accepted: items.length });
    return items;
  }
}

export const fileUploadChannel = new FileUploadChannel();
