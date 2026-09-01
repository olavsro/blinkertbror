/**
 * Opplasting - kanal 4a.
 *
 * Merk hvor lik denne er e-postruten under overflaten: ta imot, la kanalen
 * lage `DocumentItem`, `storeRawDocument`, køe ekstraksjon, svar. Forskjellen
 * er bare hvordan bytene kom hit. Det er hele gevinsten ved
 * `IngestionChannel`-abstraksjonen, sett fra kallstedet.
 */
import { NextResponse } from "next/server";
import { getDb, users } from "@qbikk/db";
import { getBlobStore, storeRawDocument } from "@qbikk/core";
import { fileUploadChannel, type UploadedFile } from "@qbikk/ingestion";
import { JOBS, sendJob } from "@qbikk/jobs";
import { getQueue } from "@/lib/queue";
import { currentUser } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Ingen bruker" }, { status: 400 });

  const form = await request.formData();
  const files: UploadedFile[] = [];

  for (const value of form.getAll("files")) {
    if (typeof value === "string") continue;
    files.push({
      filename: value.name || null,
      mime: value.type || "application/octet-stream",
      data: Buffer.from(await value.arrayBuffer()),
    });
  }

  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "Ingen filer" }, { status: 400 });
  }

  const note = form.get("note");

  const items = await fileUploadChannel.receive(
    {
      userId: user.id,
      channelId: "file_upload",
      config: { maxBytes: 25 * 1024 * 1024 },
      logger: console,
      signal: request.signal,
    },
    { files, note: typeof note === "string" ? note : null },
  );

  const db = getDb();
  const boss = await getQueue();
  let created = 0;
  let duplicates = 0;

  for (const item of items) {
    const result = await storeRawDocument(db, getBlobStore(), {
      userId: user.id,
      channelId: null,
      channelType: "file_upload",
      item,
    });
    if (result.isDuplicate) {
      duplicates++;
      continue;
    }
    created++;
    await sendJob(boss, JOBS.extractDocument, { userId: user.id, rawDocumentId: result.rawDocumentId });
  }

  return NextResponse.json({
    ok: true,
    created,
    duplicates,
    rejected: files.length - items.length,
  });
}
