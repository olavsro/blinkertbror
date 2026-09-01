/**
 * Blob-lager for rådokumenter og vedlegg.
 *
 * Bilag skal ligge uendret i fem år. Derfor er lageret write-once:
 * `put` med en nøkkel som allerede finnes er en no-op, og det finnes ingen
 * `delete`. Nøkkelen er innholdsadressert (sha256), så samme fil lagret to
 * ganger tar plass én gang.
 *
 * Lokalt driver = filsystem. Bytt til S3/MinIO ved å implementere samme
 * grensesnitt; ingen kallende kode endres.
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { findRepoRoot } from "./env.js";
import { sha256 } from "./dedup.js";

export interface BlobRef {
  key: string;
  sha256: string;
  sizeBytes: number;
  mime: string;
}

export interface BlobStore {
  put(input: { data: Buffer; mime: string; filename?: string; prefix?: string }): Promise<BlobRef>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "message/rfc822": "eml",
  "application/json": "json",
};

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    // Nøkkelen er alltid generert av oss (hex + kjent ext), men vi normaliserer
    // og verifiserer likevel at den blir liggende under root.
    const full = resolve(join(this.root, key));
    if (!full.startsWith(resolve(this.root))) throw new Error(`Ugyldig blob-nøkkel: ${key}`);
    return full;
  }

  async put(input: { data: Buffer; mime: string; filename?: string; prefix?: string }): Promise<BlobRef> {
    const hash = sha256(input.data);
    const ext = EXT_BY_MIME[input.mime] ?? "bin";
    const prefix = input.prefix ? `${input.prefix}/` : "";
    // Sharding på to hex-tegn holder katalogene små i filsystemet.
    const key = `${prefix}${hash.slice(0, 2)}/${hash}.${ext}`;
    const path = this.pathFor(key);

    if (!(await this.exists(key))) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.data, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
        // Kappløp mellom to workere om samme innhold er harmløst: filen er identisk.
        if (err.code !== "EEXIST") throw err;
      });
    }

    return { key, sha256: hash, sizeBytes: input.data.byteLength, mime: input.mime };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

let store: BlobStore | undefined;

export function getBlobStore(): BlobStore {
  if (store) return store;
  const driver = process.env.BLOB_DRIVER ?? "local";
  if (driver !== "local") {
    throw new Error(`BLOB_DRIVER=${driver} er ikke implementert ennå. Implementer BlobStore og registrer den her.`);
  }
  store = new LocalBlobStore(resolveBlobRoot(process.env.BLOB_LOCAL_PATH ?? "./storage/blobs"));
  return store;
}

/**
 * Gjør en relativ BLOB_LOCAL_PATH om til én absolutt sti, forankret i roten
 * av monorepoet.
 *
 * Uten dette resolves stien mot `process.cwd()`, og prosessene starter i hver
 * sin katalog: web i `apps/web`, worker i `apps/worker`, scripts i roten. Da
 * skriver webhooken et rådokument til ett arkiv mens workeren leter etter det
 * i et annet - og ekstraksjon av PDF-er og bilder feiler med «filen finnes
 * ikke», selv om alt ser riktig konfigurert ut.
 */
export function resolveBlobRoot(configured: string): string {
  if (isAbsolute(configured)) return configured;
  const root = findRepoRoot();
  return root ? resolve(root, configured) : resolve(configured);
}

export function guessMime(filename: string | null | undefined, fallback = "application/octet-stream"): string {
  if (!filename) return fallback;
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return fallback;
  const found = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext);
  return found?.[0] ?? fallback;
}

export function docKindFor(mime: string): "email" | "pdf" | "image" | "csv" | "html" | "other" {
  if (mime === "message/rfc822") return "email";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/csv") return "csv";
  if (mime === "text/html") return "html";
  return "other";
}
