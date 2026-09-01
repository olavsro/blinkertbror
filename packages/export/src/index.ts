/**
 * Eksport til regnskapsfører.
 *
 * `loadVouchersForExport` er den eneste leseveien: den henter bilagene for et
 * år og gjør dem om til `SaftVoucher`. Begge eksportformatene bruker den, så
 * en CSV og en SAF-T-fil for det samme året er garantert bygget på det samme
 * datagrunnlaget.
 */
import { and, eq, getDb, gte, lte, ne, vouchers as vouchersTable, users } from "@qbikk/db";
import type { Database } from "@qbikk/db";
import type { VatCode } from "@qbikk/core/vat";
import type { SaftCompany, SaftVoucher } from "./saft.js";

export * from "./saft.js";
export * from "./csv.js";
export { escapeXml } from "./xml.js";

/**
 * Bilagene som skal med i et årsregnskap.
 *
 * DUPLIKATER ER UTELATT, og det er ikke en detalj: et bankbilag som er slått
 * sammen med en kvittering er allerede representert av kvitteringen. Tok vi
 * begge med, ville hvert kjøp med både betaling og kvittering blitt bokført
 * to ganger.
 */
export async function loadVouchersForExport(
  db: Database,
  userId: string,
  year: number,
): Promise<SaftVoucher[]> {
  const rows = await db
    .select()
    .from(vouchersTable)
    .where(
      and(
        eq(vouchersTable.userId, userId),
        ne(vouchersTable.status, "duplicate"),
        gte(vouchersTable.date, `${year}-01-01`),
        lte(vouchersTable.date, `${year}-12-31`),
      ),
    )
    .orderBy(vouchersTable.date, vouchersTable.createdAt);

  return rows.map((v) => {
    // MVA er lagret i bilagets valuta. Til regnskapet trengs NOK, og da må
    // den skaleres med NØYAKTIG den kursen som ble brukt på totalen - ikke
    // med en kurs hentet i dag.
    const scale = v.currency === "NOK" ? 1 : Number(v.exchangeRate) || 1;
    const vatAmountNok = Math.round((v.vatAmount ?? 0) * scale);

    return {
      id: v.id,
      date: v.date,
      bookingDate: v.bookingDate,
      direction: v.direction,
      amountNok: v.amountNok,
      // Netto utledes av totalen, ikke av det lagrede nettobeløpet: da er
      // netto + mva alltid nøyaktig lik brutto, og posteringene går i null.
      netAmountNok: v.amountNok - vatAmountNok,
      vatAmountNok,
      vatCode: (v.vatCode as VatCode | null) ?? null,
      currency: v.currency,
      grossAmount: v.grossAmount,
      exchangeRate: v.exchangeRate,
      rateDate: v.rateDate,
      counterpartyName: v.counterpartyName,
      counterpartyCountry: v.counterpartyCountry,
      counterpartyOrgNumber: null,
      description: v.description,
      accountCode: v.accountCode,
      externalRef: v.externalRef,
      reverseCharge: v.reverseCharge,
      sourceChannel: v.sourceChannel,
    };
  });
}

export async function loadCompany(db: Database, userId: string): Promise<SaftCompany> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error(`Ukjent bruker: ${userId}`);
  return {
    name: user.name ?? user.email,
    orgNumber: user.orgNumber,
    country: "NO",
  };
}

/** Filnavn en regnskapsfører kan lagre uten å døpe om. */
export function exportFilename(company: SaftCompany, year: number, extension: string): string {
  const slug = (company.orgNumber ?? company.name)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `saft-${slug}-${year}.${extension}`;
}

export { getDb };
