/**
 * KANAL 4b - Overvåket mappe (lokal, Dropbox, Google Drive).
 *
 * For brukeren som allerede HAR en rutine: alt skannes eller lastes ned til
 * «Kvitteringer 2026» i Dropbox. Da skal systemet møte dem der de er i stedet
 * for å be dem om å endre vane.
 *
 * Cursoren er (sti, mtime, størrelse) for det siste vi så. Vi bruker ikke
 * filnavn til dedup - folk skanner den samme kvitteringen to ganger og får
 * «scan_001 (1).pdf». sha256 over innholdet i pipeline tar den.
 *
 * Lokal mappe er implementert. Dropbox/Drive går gjennom nøyaktig samme
 * `pull()` med en annen `FolderDriver` - se `driverFor()` nederst.
 */
import { z } from "zod";
import {
  ChannelTemporaryError,
  type ChannelContext,
  type ChannelHealth,
  type Cursor,
  type IngestionChannel,
  type IngestionItem,
  type SetupResult,
} from "../types.js";

export const folderWatchConfigSchema = z.object({
  driver: z.enum(["local", "dropbox", "gdrive"]).default("local"),
  /** Sti for local, mappe-id for Dropbox/Drive. */
  path: z.string().min(1),
  /** OAuth-token for skydriverne. Krypteres av kalleren. */
  token: z.string().nullable().default(null),
  extensions: z.array(z.string()).default([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic"]),
  /** Vi går aldri dypere enn dette - en feilkonfigurert sti skal ikke lese hele disken. */
  maxDepth: z.number().int().min(1).max(5).default(2),
  maxBytes: z.number().int().positive().default(25 * 1024 * 1024),
});

export type FolderWatchConfig = z.infer<typeof folderWatchConfigSchema>;

interface FolderCursor extends Cursor {
  /** ISO-tidspunkt. Filer eldre enn dette er allerede hentet. */
  lastModified: string | null;
}

export interface FolderEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/** Det en mappekilde må kunne. Dropbox og Drive implementerer den samme. */
export interface FolderDriver {
  list(config: FolderWatchConfig, since: Date | null): Promise<FolderEntry[]>;
  read(config: FolderWatchConfig, path: string): Promise<Buffer>;
}

export class FolderWatchChannel implements IngestionChannel<FolderWatchConfig, never> {
  readonly type = "folder_watch" as const;
  readonly label = "Overvåket mappe";
  readonly capabilities = {
    push: false,
    pull: true,
    backfill: true,
    producesDocuments: true,
    producesTransactions: false,
    requiresCredentials: false,
    fragile: false,
  };
  readonly configSchema = folderWatchConfigSchema;

  async setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult> {
    const config = folderWatchConfigSchema.parse(input.params);
    return {
      config,
      meta: { driver: config.driver, path: config.path },
      instructions: [
        {
          title: "Pek på mappa du allerede bruker",
          body: "Legger du kvitteringene i en mappe fra før, trenger du ikke endre noe. Vi ser etter nye filer der og lar dem ligge.",
        },
        {
          title: "Vi flytter og sletter ingenting",
          body: "Filene dine blir liggende urørt. Vi leser dem og tar en kopi til arkivet.",
        },
      ],
    };
  }

  async healthCheck(ctx: ChannelContext<FolderWatchConfig>): Promise<ChannelHealth> {
    try {
      const entries = await driverFor(ctx.config).list(ctx.config, null);
      return {
        ok: true,
        message: `${entries.length} fil(er) i ${ctx.config.path}`,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        needsUserAction: true,
        checkedAt: new Date(),
      };
    }
  }

  async *pull(
    ctx: ChannelContext<FolderWatchConfig>,
    options?: { since?: Date; full?: boolean },
  ): AsyncIterable<IngestionItem> {
    const cursor = readCursor(ctx.cursor);
    const since = options?.full
      ? null
      : (options?.since ?? (cursor.lastModified ? new Date(cursor.lastModified) : null));

    const driver = driverFor(ctx.config);
    const entries = await driver.list(ctx.config, since);
    const wanted = entries
      .filter((e) => ctx.config.extensions.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .filter((e) => e.sizeBytes > 0 && e.sizeBytes <= ctx.config.maxBytes)
      .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime());

    ctx.logger.info("Fant filer i mappa", { seen: entries.length, wanted: wanted.length });

    for (const entry of wanted) {
      if (ctx.signal.aborted) return;

      const data = await driver.read(ctx.config, entry.path);
      const mime = mimeFor(entry.name);

      yield {
        kind: "document",
        externalRef: `${ctx.config.driver}:${entry.path}`,
        receivedAt: entry.modifiedAt,
        subject: entry.name,
        sender: null,
        recipient: null,
        text: null,
        html: null,
        raw: data,
        rawMime: mime,
        attachments: [{ filename: entry.name, mime, data, inline: false }],
        rawPayload: { path: entry.path, driver: ctx.config.driver, sizeBytes: entry.sizeBytes },
      };
    }
  }

  nextCursor(items: IngestionItem[], previous: Cursor | null): Cursor {
    const prev = readCursor(previous);
    let latest = prev.lastModified ? new Date(prev.lastModified) : null;
    for (const item of items) {
      if (item.kind !== "document") continue;
      if (!latest || item.receivedAt > latest) latest = item.receivedAt;
    }
    return { lastModified: latest?.toISOString() ?? null };
  }
}

export const folderWatchChannel = new FolderWatchChannel();

/* ------------------------------------------------------------- drivere --- */

/**
 * Lokal mappe. Node-modulene importeres dynamisk av samme grunn som i
 * IMAP-kanalen: registret skal kunne lastes uten å dra inn filsystemet.
 */
export const localFolderDriver: FolderDriver = {
  async list(config, since) {
    const { readdir, stat } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");

    const root = resolve(config.path);
    const out: FolderEntry[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > config.maxDepth) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // .DS_Store og venner
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        const info = await stat(full);
        // Strengt større enn: en fil med nøyaktig samme mtime er den vi
        // stoppet på sist, og den er allerede hentet.
        if (since && info.mtime <= since) continue;
        out.push({ path: full, name: entry.name, sizeBytes: info.size, modifiedAt: info.mtime });
      }
    }

    await walk(root, 1);
    return out;
  },

  async read(_config, path) {
    const { readFile } = await import("node:fs/promises");
    return readFile(path);
  },
};

function driverFor(config: FolderWatchConfig): FolderDriver {
  if (config.driver === "local") return localFolderDriver;
  // Dropbox og Drive er samme grensesnitt med et REST-kall bak. Vi kaster
  // eksplisitt i stedet for å late som kanalen virker: en tom mappe og en
  // uimplementert driver ser ellers helt like ut i UI.
  throw new ChannelTemporaryError(
    `Mappedriveren «${config.driver}» er ikke implementert ennå. Implementer FolderDriver og registrer den i driverFor().`,
  );
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  txt: "text/plain",
  html: "text/html",
};

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function readCursor(cursor: Cursor | null): FolderCursor {
  const value = cursor?.lastModified;
  return { lastModified: typeof value === "string" ? value : null };
}
