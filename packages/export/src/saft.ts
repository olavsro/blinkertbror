/**
 * SAF-T Financial (Norge) - eksport til regnskapsfører og Skatteetaten.
 *
 * Grunnen til at dette lar seg gjøre i det hele tatt, er at skjemaet ble
 * forberedt for det fra dag én: `account_code` etter NS 4102, `vat_code` per
 * linje, motpart med organisasjonsnummer og land, og `exchange_rate` +
 * `rate_date` LAGRET på bilaget. Uten kursen lagret måtte vi ha slått opp
 * historiske kurser på nytt, og tallene ville endret seg mellom to eksporter
 * av det samme regnskapsåret.
 *
 * DOBBEL BOKFØRING. Et bilag hos oss er én rad; SAF-T vil ha debet og kredit
 * som går i null. Vi genererer derfor to eller tre linjer per bilag:
 *
 *   Utgift:  debet  resultatkonto (f.eks. 6560)   netto
 *            debet  2710 inngående mva            mva
 *            kredit 2400 leverandørgjeld          brutto
 *
 *   Inntekt: debet  1500 kundefordringer          brutto
 *            kredit resultatkonto (f.eks. 3000)   netto
 *            kredit 2700 utgående mva             mva
 *
 * Motkontoen er en ANTAKELSE: vi vet ikke alltid om bilaget ble betalt
 * kontant, med kort eller mot faktura. 2400/1500 er det konservative valget
 * en regnskapsfører kan omkontere fra. Antakelsen står i `<Description>` på
 * transaksjonen, slik at den er synlig og ikke må gjettes.
 *
 * MERK: filen er bygget etter strukturen i SAF-T Financial v1.30, men den er
 * IKKE validert mot den offisielle XSD-en i dette prosjektet. Kjør den
 * gjennom Skatteetatens valideringstjeneste før den sendes inn på ekte.
 */
import { VAT_RATES, type VatCode } from "@qbikk/core/vat";
import { document, el, node, type XmlNode } from "./xml.js";

export const SAFT_NAMESPACE = "urn:StandardAuditFile-Taxation-Financial:NO";
export const SAFT_VERSION = "1.30";

/** Standardkontoer i NS 4102 som eksporten trenger. */
export const ACCOUNTS = {
  /** Utgående merverdiavgift (salg). */
  outgoingVat: "2700",
  /** Inngående merverdiavgift (kjøp, fradragsberettiget). */
  incomingVat: "2710",
  /** Leverandørgjeld - motkonto for utgifter. */
  accountsPayable: "2400",
  /** Kundefordringer - motkonto for inntekter. */
  accountsReceivable: "1500",
} as const;

/** SAF-T sine standardkoder for norsk mva. */
export const SAFT_TAX_CODES: Record<VatCode, string> = {
  standard_25: "3",
  food_15: "31",
  transport_12: "33",
  zero_0: "5",
  exempt: "0",
  reverse_charge: "86",
  outside_scope: "7",
};

export interface SaftCompany {
  name: string;
  orgNumber: string | null;
  country: string;
}

export interface SaftVoucher {
  id: string;
  date: string;
  bookingDate: string | null;
  direction: "income" | "expense";
  /** I øre NOK. Alltid positivt. */
  amountNok: number;
  netAmountNok: number;
  vatAmountNok: number;
  vatCode: VatCode | null;
  currency: string;
  /** I minste enhet av `currency`. */
  grossAmount: number;
  exchangeRate: string;
  rateDate: string | null;
  counterpartyName: string | null;
  counterpartyCountry: string | null;
  counterpartyOrgNumber: string | null;
  description: string | null;
  accountCode: string | null;
  externalRef: string | null;
  reverseCharge: boolean;
  sourceChannel: string;
}

export interface SaftInput {
  company: SaftCompany;
  year: number;
  vouchers: SaftVoucher[];
  /** Programvaren som lagde filen - påkrevd i headeren. */
  software?: { name: string; version: string };
  createdAt?: Date;
}

/**
 * Er bilaget omvendt avgiftspliktig?
 *
 * To kilder kan si det: flagget på bilaget og mva-koden. De skal normalt være
 * enige, men en ekstraksjon kan ha satt koden uten å kjenne selgers land - og
 * da ville MVA-siden i UI-et og eksporten rapportert ulikt om det samme
 * bilaget. Ett sted å spørre, så det ikke kan skje.
 */
export function isReverseCharge(v: Pick<SaftVoucher, "reverseCharge" | "vatCode">): boolean {
  return v.reverseCharge || v.vatCode === "reverse_charge";
}

/** Øre -> "1234.56". SAF-T vil ha punktum og to desimaler. */
function money(minor: number): string {
  return (minor / 100).toFixed(2);
}

function counterpartyId(name: string | null): string {
  if (!name) return "UKJENT";
  // Deterministisk id: den samme leverandøren må få den samme id-en i hver
  // eksport, ellers ser det ut som nye leverandører hver gang.
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 24) || "UKJENT";
}

/* -------------------------------------------------------------- header --- */

function header(input: SaftInput): XmlNode {
  const created = input.createdAt ?? new Date();
  const software = input.software ?? { name: "Qbikk", version: "0.1.0" };

  return node("Header", [
    el("AuditFileVersion", SAFT_VERSION),
    el("AuditFileCountry", "NO"),
    el("AuditFileDateCreated", created.toISOString().slice(0, 10)),
    el("SoftwareCompanyName", software.name),
    el("SoftwareID", software.name),
    el("SoftwareVersion", software.version),
    node("Company", [
      el("RegistrationNumber", input.company.orgNumber),
      el("Name", input.company.name),
      node("Address", [el("Country", input.company.country)]),
    ]),
    el("DefaultCurrencyCode", "NOK"),
    node("SelectionCriteria", [
      el("SelectionStartDate", `${input.year}-01-01`),
      el("SelectionEndDate", `${input.year}-12-31`),
    ]),
    // 0 = fullstendig fil. Deling brukes bare for svært store regnskap.
    el("HeaderComment", "Generert av Qbikk. Verifiser mot offisiell XSD før innsending."),
    el("TaxAccountingBasis", "A"),
  ]);
}

/* --------------------------------------------------------- master files -- */

function masterFiles(input: SaftInput): XmlNode {
  // Kontoplanen bygges av kontoene som FAKTISK er i bruk, pluss de faste
  // mva- og balansekontoene. Å eksportere hele NS 4102 ville fylt filen med
  // hundrevis av kontoer uten bevegelser.
  const used = new Set<string>([
    ACCOUNTS.outgoingVat,
    ACCOUNTS.incomingVat,
    ACCOUNTS.accountsPayable,
    ACCOUNTS.accountsReceivable,
  ]);
  for (const v of input.vouchers) if (v.accountCode) used.add(v.accountCode);

  const accounts = [...used].sort().map((code) =>
    node("Account", [
      el("AccountID", code),
      el("AccountDescription", ACCOUNT_NAMES[code] ?? `Konto ${code}`),
      el("StandardAccountID", code),
      el("AccountType", accountTypeFor(code)),
      // Vi fører ikke saldi i v1 - bare bevegelser. Åpning og lukking er
      // derfor null, ikke et oppdiktet tall.
      el("OpeningDebitBalance", "0.00"),
      el("ClosingDebitBalance", "0.00"),
    ]),
  );

  // Leverandører og kunder skilles på retning, slik SAF-T krever.
  const suppliers = new Map<string, SaftVoucher>();
  const customers = new Map<string, SaftVoucher>();
  for (const v of input.vouchers) {
    if (!v.counterpartyName) continue;
    const target = v.direction === "expense" ? suppliers : customers;
    target.set(counterpartyId(v.counterpartyName), v);
  }

  const party = (tag: "Supplier" | "Customer", idTag: string, v: SaftVoucher) =>
    node(tag, [
      el(idTag, counterpartyId(v.counterpartyName)),
      el("AccountID", v.direction === "expense" ? ACCOUNTS.accountsPayable : ACCOUNTS.accountsReceivable),
      el(tag === "Supplier" ? "SupplierID" : "CustomerID", counterpartyId(v.counterpartyName)),
      el("Name", v.counterpartyName),
      el("RegistrationNumber", v.counterpartyOrgNumber),
      node("Address", [el("Country", v.counterpartyCountry ?? "NO")]),
      el("OpeningDebitBalance", "0.00"),
      el("ClosingDebitBalance", "0.00"),
    ]);

  // Bare mva-kodene som er i bruk. En tom TaxTable er lovlig, men lite hjelp.
  const usedTaxCodes = new Set<VatCode>();
  for (const v of input.vouchers) if (v.vatCode) usedTaxCodes.add(v.vatCode);

  return node("MasterFiles", [
    node("GeneralLedgerAccounts", accounts),
    ...[...customers.values()].map((v) => party("Customer", "CustomerID", v)),
    ...[...suppliers.values()].map((v) => party("Supplier", "SupplierID", v)),
    node("TaxTable", [
      node("TaxTableEntry", [
        el("TaxType", "MVA"),
        el("Description", "Merverdiavgift"),
        ...[...usedTaxCodes].map((code) =>
          node("TaxCodeDetails", [
            el("TaxCode", SAFT_TAX_CODES[code]),
            el("Description", code),
            el("TaxPercentage", VAT_RATES[code].toFixed(2)),
            el("Country", "NO"),
          ]),
        ),
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------ posteringer */

interface Posting {
  accountId: string;
  side: "debit" | "credit";
  amount: number;
  vatCode: VatCode | null;
  vatAmount: number;
}

/**
 * Ett bilag -> to eller tre posteringer som går i null.
 *
 * Ved omvendt avgiftsplikt er det bevisst BARE to linjer: selger fakturerte
 * ingen mva, så det er ingenting å postere på 2710 her. Den beregnede
 * avgiften føres på begge sider og går uansett i null - den hører hjemme i
 * mva-meldingen, ikke som et krav mot leverandøren.
 */
export function postingsFor(v: SaftVoucher): Posting[] {
  const gross = v.amountNok;
  const vat = isReverseCharge(v) ? 0 : v.vatAmountNok;
  const net = gross - vat;

  if (v.direction === "expense") {
    return [
      { accountId: v.accountCode ?? "6790", side: "debit", amount: net, vatCode: v.vatCode, vatAmount: vat },
      ...(vat > 0
        ? [{ accountId: ACCOUNTS.incomingVat, side: "debit" as const, amount: vat, vatCode: null, vatAmount: 0 }]
        : []),
      { accountId: ACCOUNTS.accountsPayable, side: "credit", amount: gross, vatCode: null, vatAmount: 0 },
    ];
  }

  return [
    { accountId: ACCOUNTS.accountsReceivable, side: "debit", amount: gross, vatCode: null, vatAmount: 0 },
    { accountId: v.accountCode ?? "3000", side: "credit", amount: net, vatCode: v.vatCode, vatAmount: vat },
    ...(vat > 0
      ? [{ accountId: ACCOUNTS.outgoingVat, side: "credit" as const, amount: vat, vatCode: null, vatAmount: 0 }]
      : []),
  ];
}

function transaction(v: SaftVoucher, index: number): XmlNode {
  const postings = postingsFor(v);
  const notes = [
    v.description,
    `Kilde: ${v.sourceChannel}`,
    isReverseCharge(v) ? "Omvendt avgiftsplikt - mva føres på begge sider i mva-meldingen" : null,
    `Motkonto ${v.direction === "expense" ? ACCOUNTS.accountsPayable : ACCOUNTS.accountsReceivable} er en antakelse - omkonter ved behov`,
  ]
    .filter(Boolean)
    .join(". ");

  return node("Transaction", [
    el("TransactionID", v.id),
    el("Period", String(Number(v.date.slice(5, 7)))),
    el("PeriodYear", v.date.slice(0, 4)),
    el("TransactionDate", v.date),
    el("Description", notes),
    el("SystemEntryDate", v.bookingDate ?? v.date),
    el("GLPostingDate", v.bookingDate ?? v.date),
    ...postings.map((p, i) =>
      node("Line", [
        el("RecordID", `${index + 1}-${i + 1}`),
        el("AccountID", p.accountId),
        el(v.direction === "expense" ? "SupplierID" : "CustomerID", counterpartyId(v.counterpartyName)),
        el("SourceDocumentID", v.externalRef ?? v.id),
        node(p.side === "debit" ? "DebitAmount" : "CreditAmount", [
          el("Amount", money(p.amount)),
          // Valuta lagres BÅDE i NOK og i originalvaluta med kursen som ble
          // brukt. Det er det som gjør tallet etterprøvbart om fem år.
          ...(v.currency !== "NOK"
            ? [
                el("CurrencyCode", v.currency),
                el("CurrencyAmount", money(Math.round(v.grossAmount * (p.amount / Math.max(v.amountNok, 1))))),
                el("ExchangeRate", v.exchangeRate),
              ]
            : []),
        ]),
        ...(p.vatCode
          ? [
              node("TaxInformation", [
                el("TaxType", "MVA"),
                el("TaxCode", SAFT_TAX_CODES[p.vatCode]),
                el("TaxPercentage", VAT_RATES[p.vatCode].toFixed(2)),
                el("TaxBase", money(p.amount)),
                node("TaxAmount", [el("Amount", money(p.vatAmount))]),
              ]),
            ]
          : []),
      ]),
    ),
  ]);
}

/* ------------------------------------------------------------------ bygg - */

export function buildSaftXml(input: SaftInput): string {
  // Duplikater skal ALDRI med i et regnskap: et bankbilag som er slått
  // sammen med en kvittering er allerede representert av kvitteringen.
  const vouchers = input.vouchers.filter((v) => v.amountNok > 0);

  const journal = node("Journal", [
    el("JournalID", "QBIKK"),
    el("Description", "Bilag samlet inn automatisk"),
    el("Type", "GL"),
    ...vouchers.map((v, i) => transaction(v, i)),
  ]);

  const totalDebit = vouchers.reduce(
    (a, v) => a + postingsFor(v).filter((p) => p.side === "debit").reduce((s, p) => s + p.amount, 0),
    0,
  );
  const totalCredit = vouchers.reduce(
    (a, v) => a + postingsFor(v).filter((p) => p.side === "credit").reduce((s, p) => s + p.amount, 0),
    0,
  );

  const root = node("AuditFile", [
    header(input),
    masterFiles({ ...input, vouchers }),
    node("GeneralLedgerEntries", [
      el("NumberOfEntries", String(vouchers.length)),
      el("TotalDebit", money(totalDebit)),
      el("TotalCredit", money(totalCredit)),
      journal,
    ]),
  ]);

  return document(root, { xmlns: SAFT_NAMESPACE });
}

/**
 * Kontrollsum: debet og kredit MÅ være like.
 *
 * Kalles av eksportruta før filen leveres. Er de ulike, er det en feil i
 * posteringslogikken vår, og da skal ingen sende filen videre til
 * regnskapsføreren sin.
 */
export function checkBalanced(vouchers: SaftVoucher[]): { balanced: boolean; debit: number; credit: number } {
  let debit = 0;
  let credit = 0;
  for (const v of vouchers) {
    for (const p of postingsFor(v)) {
      if (p.side === "debit") debit += p.amount;
      else credit += p.amount;
    }
  }
  return { balanced: debit === credit, debit, credit };
}

const ACCOUNT_NAMES: Record<string, string> = {
  "1500": "Kundefordringer",
  "1920": "Bankinnskudd",
  "2400": "Leverandørgjeld",
  "2700": "Utgående merverdiavgift",
  "2710": "Inngående merverdiavgift",
  "3000": "Salgsinntekt, avgiftspliktig",
  "3100": "Salgsinntekt, avgiftsfri",
  "3900": "Annen driftsinntekt",
  "4300": "Varekjøp",
  "6540": "Inventar og utstyr",
  "6560": "Rekvisita",
  "6790": "Annen fremmed tjeneste",
  "6800": "Kontorrekvisita",
  "6810": "Programvare og lisenser",
  "7140": "Reisekostnad",
  "7320": "Reklamekostnad",
  "7770": "Bank- og kortgebyr",
};

/** Grov klassifisering etter NS 4102 sin kontoklasse (første siffer). */
function accountTypeFor(code: string): string {
  const first = code[0];
  if (first === "1") return "Asset";
  if (first === "2") return "Liability";
  if (first === "3") return "Income";
  return "Expense";
}
