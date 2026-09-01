/**
 * CSV til regnskapsførere som ikke tar SAF-T.
 *
 * De aller fleste norske regnskapskontorer importerer gjerne en CSV med
 * kolonnene under, og det er en langt kortere vei enn å be dem om å ta imot
 * XML. Formatet er derfor ikke en nødløsning - det er den varianten som
 * faktisk blir brukt.
 *
 * Valgene som er tatt, og hvorfor:
 *  - SEMIKOLON som skilletegn. Norsk Excel bruker komma som DESIMALTEGN, så
 *    en komma-separert fil med norske tall åpner seg som én kolonne søppel.
 *  - BOM foran. Uten den viser Excel på Windows «Kjøpmann» som «KjÃ¸pmann».
 *  - Beløp med KOMMA som desimaltegn, fordi det er norsk Excel som skal lese
 *    det. SAF-T-eksporten bruker punktum, fordi det er en maskin som leser den.
 */
import type { SaftVoucher } from "./saft.js";
import { ACCOUNTS, isReverseCharge, postingsFor } from "./saft.js";

const SEPARATOR = ";";
/** Byte order mark. Excel på Windows trenger den for å skjønne at fila er UTF-8. */
const BOM = "﻿";

const COLUMNS = [
  "Bilagsnr",
  "Bilagsdato",
  "Bokføringsdato",
  "Konto",
  "Kontonavn",
  "Debet",
  "Kredit",
  "MVA-kode",
  "MVA-beløp",
  "Motpart",
  "Org.nr",
  "Land",
  "Beskrivelse",
  "Valuta",
  "Beløp i valuta",
  "Kurs",
  "Kursdato",
  "Kilde",
  "Omvendt avgiftsplikt",
] as const;

function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Sitér når feltet inneholder skilletegn, sitat eller linjeskift - ellers
  // sklir et leverandørnavn med semikolon over i neste kolonne.
  if (s.includes(SEPARATOR) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Øre -> "1234,56" med komma, for norsk Excel. */
function money(minor: number): string {
  return (minor / 100).toFixed(2).replace(".", ",");
}

/**
 * Én linje per POSTERING, ikke per bilag.
 *
 * Et regnskapssystem vil ha debet og kredit hver for seg. Ett bilag gir
 * dermed to eller tre rader som summerer til null - de samme posteringene som
 * SAF-T-eksporten lager, fra den samme funksjonen. To eksportformater som
 * regnet ulikt ville vært en feilkilde ingen oppdaget før ved bokettersyn.
 */
export function toAccountantCsv(vouchers: SaftVoucher[]): string {
  const rows: string[] = [COLUMNS.join(SEPARATOR)];
  let number = 0;

  for (const v of vouchers) {
    number++;
    for (const p of postingsFor(v)) {
      rows.push(
        [
          field(number),
          field(v.date),
          field(v.bookingDate ?? v.date),
          field(p.accountId),
          field(ACCOUNT_LABEL[p.accountId] ?? ""),
          field(p.side === "debit" ? money(p.amount) : ""),
          field(p.side === "credit" ? money(p.amount) : ""),
          field(p.vatCode ?? ""),
          field(p.vatAmount > 0 ? money(p.vatAmount) : ""),
          field(v.counterpartyName ?? ""),
          field(v.counterpartyOrgNumber ?? ""),
          field(v.counterpartyCountry ?? ""),
          field(v.description ?? ""),
          field(v.currency),
          field(v.currency === "NOK" ? "" : money(v.grossAmount)),
          field(v.currency === "NOK" ? "" : v.exchangeRate.replace(".", ",")),
          field(v.currency === "NOK" ? "" : (v.rateDate ?? "")),
          field(v.sourceChannel),
          field(isReverseCharge(v) ? "ja" : ""),
        ].join(SEPARATOR),
      );
    }
  }

  return BOM + rows.join("\r\n") + "\r\n";
}

/**
 * Enklere variant: én linje per bilag, uten dobbel bokføring.
 *
 * For regnskapsførere som bare vil ha en oversikt å avstemme mot, og for
 * brukeren selv når hen skal se hva som ligger inne.
 */
export function toSimpleCsv(vouchers: SaftVoucher[]): string {
  const columns = [
    "Dato",
    "Retning",
    "Motpart",
    "Beskrivelse",
    "Kategori",
    "Konto",
    "Netto NOK",
    "MVA NOK",
    "Brutto NOK",
    "Valuta",
    "Brutto i valuta",
    "MVA-kode",
    "Omvendt avgiftsplikt",
    "Kilde",
  ];

  const rows = [columns.join(SEPARATOR)];
  for (const v of vouchers) {
    rows.push(
      [
        field(v.date),
        field(v.direction === "income" ? "inntekt" : "utgift"),
        field(v.counterpartyName ?? ""),
        field(v.description ?? ""),
        field(v.accountCode ?? ""),
        field(v.accountCode ?? ""),
        field(money(v.netAmountNok)),
        field(money(v.vatAmountNok)),
        field(money(v.amountNok)),
        field(v.currency),
        field(money(v.grossAmount)),
        field(v.vatCode ?? ""),
        field(isReverseCharge(v) ? "ja" : ""),
        field(v.sourceChannel),
      ].join(SEPARATOR),
    );
  }

  return BOM + rows.join("\r\n") + "\r\n";
}

const ACCOUNT_LABEL: Record<string, string> = {
  [ACCOUNTS.accountsReceivable]: "Kundefordringer",
  [ACCOUNTS.accountsPayable]: "Leverandørgjeld",
  [ACCOUNTS.outgoingVat]: "Utgående merverdiavgift",
  [ACCOUNTS.incomingVat]: "Inngående merverdiavgift",
};
