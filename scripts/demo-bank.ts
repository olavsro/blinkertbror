/**
 * Legger inn syntetiske banktransaksjoner som matcher fixture-bilagene.
 *
 * Kjør: pnpm demo:bank
 *
 * GoCardless krever en ekte bank og et ekte samtykke, så kanal 3 kan ikke
 * demonstreres uten. Denne snarveien går inn ETT steg lenger inne - på
 * `upsertBankTransaction`, som er nøyaktig det bankkanalen kaller for hver
 * transaksjon den henter. Alt etter det punktet er den ekte kodeveien:
 * dedup, matching, og regelen om at usikre matcher foreslås og ikke utføres.
 *
 * Demoen viser begge utfallene:
 *   - et trekk med én åpenbar kvittering  -> kobles automatisk
 *   - et trekk med TO like gode kvitteringer -> foreslås, og blir stående
 *     til brukeren velger. Høy score er ikke nok når nummer to er like god.
 */
import "dotenv/config";
import { eq, getDb, users, vouchers, voucherMatches, ne, and } from "@qbikk/db";
import { createManualVoucher, loadUserContext, proposeMatches, upsertBankTransaction } from "@qbikk/core";
import { formatPlain } from "@qbikk/core/money";

async function main(): Promise<void> {
  const db = getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("Ingen bruker. Kjør `pnpm seed` først.");

  const { profile, rules } = await loadUserContext(db, user.id);

  // Finn et dokumentbilag å matche mot, så demoen speiler faktiske data.
  const [target] = await db
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.userId, user.id),
        eq(vouchers.direction, "expense"),
        eq(vouchers.currency, "NOK"),
        ne(vouchers.status, "duplicate"),
      ),
    )
    .limit(1);

  if (!target) throw new Error("Fant ingen NOK-utgift å matche mot. Kjør `pnpm demo:email alle` først.");

  const transactions = [
    {
      // Entydig: samme beløp, samme motpart, én dag etter. Skal auto-kobles.
      externalId: "demo-tx-001",
      accountId: "DEMO-KONTO",
      bookingDate: shift(target.date, 1),
      valueDate: target.date,
      amount: -target.amountNok,
      currency: "NOK",
      counterpartyName: (target.counterpartyName ?? "Ukjent").toUpperCase(),
      remittanceInfo: `Varekjøp ${target.date}`,
    },
    // Ett trekk som har TO like gode kvitteringer å velge mellom. Se under.
    {
      externalId: "demo-tx-002",
      accountId: "DEMO-KONTO",
      bookingDate: "2026-03-05",
      valueDate: "2026-03-05",
      amount: -29_900,
      currency: "NOK",
      counterpartyName: "ABONNEMENT AS",
      remittanceInfo: "Månedstrekk",
    },
  ];

  // Den klassiske tvetydigheten: samme leverandør sender to fakturaer på
  // samme beløp samme dag (to abonnementer på én konto). Banken viser ett
  // trekk. Hvilken kvitteringen hører til, kan ikke avgjøres av tallene -
  // og det er nettopp da en automatisk kobling ville tatt feil.
  //
  // De to må ha ULIKE fakturanumre for i det hele tatt å bli to bilag:
  // uten det er de identiske, og dedupen slår dem sammen til ett - som er
  // riktig oppførsel når to importer beskriver det samme kjøpet.
  for (const invoice of ["ABO-5001", "ABO-5002"]) {
    await createManualVoucher(db, {
      userId: user.id,
      profile,
      rules,
      date: "2026-03-04",
      direction: "expense",
      grossAmount: 29_900,
      currency: "NOK",
      counterpartyName: "Abonnement AS",
      description: `Månedsabonnement ${invoice}`,
      externalRef: invoice,
    });
  }

  console.log("");
  for (const tx of transactions) {
    const result = await upsertBankTransaction(db, {
      userId: user.id,
      channelId: null,
      profile,
      rules,
      tx,
    });

    const match = await proposeMatches(db, { userId: user.id, voucherId: result.voucherId });

    console.log(
      `  ${tx.externalId}  ${formatPlain(Math.abs(tx.amount))} kr  ${tx.counterpartyName}` +
        (result.isDuplicate ? "  (fantes fra før)" : ""),
    );
    if (match.linked.length > 0) {
      console.log(`      -> KOBLET automatisk (utvilsom match)`);
    } else if (match.proposals.length > 0) {
      const p = match.proposals[0]!;
      console.log(`      -> foreslått, ${Math.round(p.score * 100)} % - venter på deg i «krever handling»`);
    } else {
      console.log(`      -> ingen kvittering funnet, havner i «krever handling»`);
    }
  }

  const proposed = await db
    .select()
    .from(voucherMatches)
    .where(and(eq(voucherMatches.userId, user.id), eq(voucherMatches.status, "proposed")));

  console.log("");
  console.log(`  ${proposed.length} forslag venter på godkjenning:  http://localhost:3000/handling`);
  console.log("");
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Demoen feilet:", err);
    process.exit(1);
  });
