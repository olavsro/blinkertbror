/**
 * SAF-T og CSV.
 *
 * Den kritiske invarianten er at debet er lik kredit. En eksport som ikke går
 * i null blir avvist av mottakeren - og verre: går den likevel gjennom, har
 * regnskapsføreren fått et regnskap som ikke stemmer.
 */
import { describe, expect, it } from "vitest";
import {
  buildSaftXml,
  checkBalanced,
  postingsFor,
  toAccountantCsv,
  toSimpleCsv,
  escapeXml,
  exportFilename,
  ACCOUNTS,
  type SaftVoucher,
} from "@qbikk/export";

const expense: SaftVoucher = {
  id: "v1",
  date: "2026-03-09",
  bookingDate: "2026-03-10",
  direction: "expense",
  amountNok: 345_625,
  netAmountNok: 276_500,
  vatAmountNok: 69_125,
  vatCode: "standard_25",
  currency: "NOK",
  grossAmount: 345_625,
  exchangeRate: "1",
  rateDate: null,
  counterpartyName: "Rørlegger & Sønn AS",
  counterpartyCountry: "NO",
  counterpartyOrgNumber: "918273645",
  description: "Varekjøp",
  accountCode: "4300",
  externalRef: "240118",
  reverseCharge: false,
  sourceChannel: "email_forward",
};

const income: SaftVoucher = {
  ...expense,
  id: "v2",
  direction: "income",
  counterpartyName: "Klubb Oslo AS",
  accountCode: "3000",
  externalRef: "F-2001",
};

const reverseCharged: SaftVoucher = {
  ...expense,
  id: "v3",
  amountNok: 12_318,
  netAmountNok: 12_318,
  vatAmountNok: 0,
  vatCode: "reverse_charge",
  currency: "EUR",
  grossAmount: 1099,
  exchangeRate: "11.2083",
  rateDate: "2026-03-01",
  counterpartyName: "Spotify AB",
  counterpartyCountry: "SE",
  counterpartyOrgNumber: null,
  accountCode: "6810",
  reverseCharge: true,
};

describe("dobbel bokføring", () => {
  it("utgift blir debet kostnad + debet inngående mva, kredit leverandørgjeld", () => {
    const postings = postingsFor(expense);
    expect(postings).toHaveLength(3);

    expect(postings[0]).toMatchObject({ accountId: "4300", side: "debit", amount: 276_500 });
    expect(postings[1]).toMatchObject({ accountId: ACCOUNTS.incomingVat, side: "debit", amount: 69_125 });
    expect(postings[2]).toMatchObject({ accountId: ACCOUNTS.accountsPayable, side: "credit", amount: 345_625 });
  });

  it("inntekt blir debet kundefordring, kredit inntekt + kredit utgående mva", () => {
    const postings = postingsFor(income);
    expect(postings[0]).toMatchObject({ accountId: ACCOUNTS.accountsReceivable, side: "debit" });
    expect(postings[1]).toMatchObject({ accountId: "3000", side: "credit", amount: 276_500 });
    expect(postings[2]).toMatchObject({ accountId: ACCOUNTS.outgoingVat, side: "credit", amount: 69_125 });
  });

  it("omvendt avgiftsplikt gir BARE to linjer", () => {
    // Selger fakturerte ingen mva, så det er ingenting å postere på 2710.
    // Den beregnede avgiften hører hjemme i mva-meldingen, ikke som et krav
    // mot leverandøren.
    const postings = postingsFor(reverseCharged);
    expect(postings).toHaveLength(2);
    expect(postings.some((p) => p.accountId === ACCOUNTS.incomingVat)).toBe(false);
  });

  it("går i null - for hvert bilag og for hele settet", () => {
    for (const voucher of [expense, income, reverseCharged]) {
      expect(checkBalanced([voucher]).balanced, `bilag ${voucher.id} går ikke i null`).toBe(true);
    }

    const all = checkBalanced([expense, income, reverseCharged]);
    expect(all.balanced).toBe(true);
    expect(all.debit).toBe(all.credit);
  });

  it("går i null også når mva er null eller beløpet er ett øre", () => {
    const odd: SaftVoucher = { ...expense, amountNok: 1, netAmountNok: 1, vatAmountNok: 0, vatCode: null };
    expect(checkBalanced([odd]).balanced).toBe(true);
  });
});

describe("SAF-T XML", () => {
  const xml = buildSaftXml({
    company: { name: "Ola Nordmann", orgNumber: "912345678", country: "NO" },
    year: 2026,
    vouchers: [expense, income, reverseCharged],
    createdAt: new Date("2026-04-01T12:00:00Z"),
  });

  it("har riktig rot, namespace og versjon", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns="urn:StandardAuditFile-Taxation-Financial:NO"');
    expect(xml).toContain("<AuditFileVersion>1.30</AuditFileVersion>");
    expect(xml).toContain("<AuditFileCountry>NO</AuditFileCountry>");
  });

  it("har header med selskap og periode", () => {
    expect(xml).toContain("<RegistrationNumber>912345678</RegistrationNumber>");
    expect(xml).toContain("<SelectionStartDate>2026-01-01</SelectionStartDate>");
    expect(xml).toContain("<SelectionEndDate>2026-12-31</SelectionEndDate>");
  });

  it("oppgir totaler som stemmer med posteringene", () => {
    const { debit, credit } = checkBalanced([expense, income, reverseCharged]);
    expect(xml).toContain(`<TotalDebit>${(debit / 100).toFixed(2)}</TotalDebit>`);
    expect(xml).toContain(`<TotalCredit>${(credit / 100).toFixed(2)}</TotalCredit>`);
    expect(xml).toContain("<NumberOfEntries>3</NumberOfEntries>");
  });

  it("tar med kontoplanen som faktisk er i bruk, og ikke mer", () => {
    expect(xml).toContain("<AccountID>4300</AccountID>");
    expect(xml).toContain("<AccountID>3000</AccountID>");
    expect(xml).toContain("<AccountID>2710</AccountID>");
    // Hele NS 4102 ville fylt filen med hundrevis av kontoer uten bevegelser.
    expect(xml).not.toContain("<AccountID>7140</AccountID>");
  });

  it("escaper tegn som ellers ville gjort filen ugyldig", () => {
    // «Rørlegger & Sønn AS» er et gyldig leverandørnavn og ugyldig XML.
    expect(xml).toContain("Rørlegger &amp; Sønn AS");
    expect(xml).not.toMatch(/<Name>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("lagrer valuta og kurs på bilag i fremmed valuta", () => {
    expect(xml).toContain("<CurrencyCode>EUR</CurrencyCode>");
    expect(xml).toContain("<ExchangeRate>11.2083</ExchangeRate>");
  });

  it("skriver mva-koder etter SAF-T sitt kodesett", () => {
    expect(xml).toContain("<TaxCode>3</TaxCode>");
    expect(xml).toContain("<TaxCode>86</TaxCode>");
  });

  it("sier eksplisitt at motkontoen er en antakelse", () => {
    // Regnskapsføreren skal se at 2400/1500 er valgt av oss og kan omkonteres.
    expect(xml).toMatch(/Motkonto \d{4} er en antakelse/);
  });
});

describe("escapeXml", () => {
  it("håndterer alle fem XML-entitetene", () => {
    expect(escapeXml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &apos;");
  });

  it("fjerner kontrolltegn som gjør filen ugyldig", () => {
    // Slike tegn kommer fra tekst hentet ut av PDF-er.
    expect(escapeXml("a\u0001b\u001Fc")).toBe("abc");
    // Linjeskift, tab og CR er lovlige i XML 1.0 og skal beholdes.
    expect(escapeXml("a\nb\tc\rd")).toBe("a\nb\tc\rd");
  });
});

describe("CSV", () => {
  it("bruker semikolon og BOM, så norsk Excel åpner den riktig", () => {
    const csv = toAccountantCsv([expense]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split("\r\n")[0]).toContain("Bilagsnr;Bilagsdato");
  });

  it("skriver én linje per postering, med komma som desimaltegn", () => {
    const lines = toAccountantCsv([expense]).trim().split("\r\n");
    // Overskrift + tre posteringer.
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("2765,00");
  });

  it("siterer felter som inneholder skilletegnet", () => {
    const csv = toAccountantCsv([{ ...expense, description: "Kjøp; med semikolon" }]);
    expect(csv).toContain('"Kjøp; med semikolon"');
  });

  it("dobler sitattegn inni felter", () => {
    const csv = toAccountantCsv([{ ...expense, counterpartyName: 'Firma "Kallenavn" AS' }]);
    expect(csv).toContain('"Firma ""Kallenavn"" AS"');
  });

  it("enkel CSV gir én linje per bilag", () => {
    const lines = toSimpleCsv([expense, income]).trim().split("\r\n");
    expect(lines).toHaveLength(3);
  });

  it("regner likt som SAF-T - de kaller samme funksjon", () => {
    const csvLines = toAccountantCsv([expense]).trim().split("\r\n").slice(1);
    expect(csvLines).toHaveLength(postingsFor(expense).length);
  });
});

describe("filnavn", () => {
  it("bruker organisasjonsnummer når det finnes", () => {
    expect(exportFilename({ name: "Ola", orgNumber: "912345678", country: "NO" }, 2026, "xml")).toBe(
      "saft-912345678-2026.xml",
    );
  });

  it("faller tilbake på navn, uten tegn et filsystem ikke tåler", () => {
    expect(exportFilename({ name: "Ola Nordmann AS", orgNumber: null, country: "NO" }, 2026, "csv")).toBe(
      "saft-ola-nordmann-as-2026.csv",
    );
  });
});
