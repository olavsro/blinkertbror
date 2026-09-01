/**
 * Røyktest av pipeline mot en ekte database.
 *
 * Kjører en fixture gjennom nøyaktig den veien en videresendt e-post tar:
 * kanal -> storeRawDocument -> runExtraction -> upsertVoucher -> proposeMatches.
 * Ingen webhook, ingen jobbkø - bare limet, slik at en feil her ikke kan
 * gjemme seg bak infrastruktur.
 *
 * Kjør: pnpm tsx scripts/smoke.ts [fixture-navn]
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { eq, getDb, users, vouchers, voucherLines } from "@qbikk/db";
import {
  getBlobStore,
  loadUserContext,
  proposeMatches,
  runExtraction,
  storeRawDocument,
  upsertVoucher,
  formatAmount,
} from "@qbikk/core";
import { rawDocuments } from "@qbikk/db";
import { getExtractor } from "@qbikk/extraction";
import { emailForwardChannel, type InboundEmail } from "@qbikk/ingestion/channels/email-forward";

const fixture = process.argv[2] ?? "beatport-purchase";

async function main(): Promise<void> {
  const db = getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("Ingen bruker. Kjør `pnpm seed` først.");

  const payload = JSON.parse(
    (await readFile(new URL(`../fixtures/emails/${fixture}.json`, import.meta.url), "utf8")).replaceAll(
      "SLUG@",
      `${user.inboundSlug}@`,
    ),
  ) as InboundEmail;

  const items = await emailForwardChannel.receive(
    {
      userId: user.id,
      channelId: "smoke",
      config: { slug: user.inboundSlug, allowedSenders: [] },
      logger: console,
      signal: new AbortController().signal,
    },
    payload,
  );
  const item = items[0];
  if (!item || item.kind !== "document") throw new Error("Kanalen produserte ikke et dokument");

  const stored = await storeRawDocument(db, getBlobStore(), {
    userId: user.id,
    channelId: null,
    channelType: "email_forward",
    item,
  });
  console.log(`  rådokument   ${stored.rawDocumentId}${stored.isDuplicate ? " (fantes fra før)" : ""}`);

  const extraction = await runExtraction(db, getExtractor(), {
    userId: user.id,
    rawDocumentId: stored.rawDocumentId,
    force: true,
  });
  console.log(`  ekstraksjon  ${extraction.document.direction} / ${extraction.document.grossAmount} ${extraction.document.currency}`);

  const [raw] = await db.select().from(rawDocuments).where(eq(rawDocuments.id, stored.rawDocumentId)).limit(1);
  if (!raw) throw new Error("Rådokumentet forsvant");

  const { profile, rules } = await loadUserContext(db, user.id);
  const result = await upsertVoucher(db, {
    userId: user.id,
    profile,
    rules,
    extractionId: extraction.extractionId,
    document: extraction.document,
    rawDocument: raw,
  });

  const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, result.voucherId)).limit(1);
  if (!voucher) throw new Error("Bilaget forsvant");
  const lines = await db.select().from(voucherLines).where(eq(voucherLines.voucherId, voucher.id));

  const matches = await proposeMatches(db, { userId: user.id, voucherId: voucher.id });

  console.log("");
  console.log(`  BILAG        ${voucher.id}${result.isDuplicate ? "  (dublett - fantes fra før)" : ""}`);
  console.log(`  dato         ${voucher.date}`);
  console.log(`  retning      ${voucher.direction}`);
  console.log(`  beløp        ${formatAmount(voucher.grossAmount, voucher.currency)}  (${formatAmount(voucher.amountNok, "NOK")})`);
  console.log(`  motpart      ${voucher.counterpartyName ?? "-"} (${voucher.counterpartyCountry ?? "?"})`);
  console.log(`  kategori     ${voucher.category} / konto ${voucher.accountCode}`);
  console.log(`  mva          ${voucher.vatCode} ${voucher.vatRate ?? "-"} % = ${formatAmount(voucher.vatAmount ?? 0, voucher.currency)}`);
  console.log(`  omvendt      ${voucher.reverseCharge ? "ja" : "nei"}`);
  console.log(`  status       ${voucher.status} (confidence ${voucher.confidence})`);
  console.log(`  linjer       ${lines.length}`);
  console.log(`  matcher      ${matches.proposals.length} forslag, ${matches.linked.length} koblet`);
  if (result.reviewReasons.length) {
    console.log("  til gjennomgang fordi:");
    for (const r of result.reviewReasons) console.log(`    - ${r}`);
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Røyktest feilet:", err);
    process.exit(1);
  });
