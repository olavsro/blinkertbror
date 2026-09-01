/** Tekstnormalisering og fuzzy sammenligning. Ingen eksterne avhengigheter. */

const LEGAL_SUFFIXES = [
  "as", "asa", "ans", "da", "ba", "sa", "nuf", "enk",
  "ab", "aps", "oy", "ltd", "limited", "llc", "inc", "corp", "corporation",
  "gmbh", "ug", "bv", "nv", "sarl", "sas", "sa", "srl", "spa", "plc", "kg", "ohg",
];

/** Fjerner betalingsstøy bankene legger på motpartsnavn. */
const BANK_NOISE = [
  /^(vipps|klarna|paypal|stripe|nets|adyen|swish)\s*[*:/-]?\s*/i,
  /^(kjop|kjøp|varekjop|varekjøp|betaling|overforing|overføring|debet|kredit)\s+/i,
  /\b(pos|atm|nok|kortkjop|kortkjøp)\b/gi,
  /\*+\d{2,}/g, // maskerte kortnummer
  /\b\d{2}\.\d{2}\.\d{2,4}\b/g, // datoer i teksten
];

/**
 * Kanonisk nøkkel for en motpart. Samme nøkkel = samme leverandør.
 * "Beatport, LLC" og "BEATPORT LLC*US" -> "beatport"
 */
export function normalizeCounterparty(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toLowerCase();
  for (const re of BANK_NOISE) s = s.replace(re, " ");
  s = s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // aksenter
    .replace(/[æ]/g, "ae")
    .replace(/[ø]/g, "o")
    .replace(/[å]/g, "a")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = s.split(" ").filter((w) => w.length > 0);
  while (words.length > 1 && LEGAL_SUFFIXES.includes(words[words.length - 1]!)) {
    words.pop();
  }
  return words.join(" ");
}

/** Domenet i en e-postadresse, uten subdomener som "mail." og "no-reply.". */
export function emailDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const m = address.match(/@([^\s>]+)/);
  if (!m) return null;
  return m[1]!.toLowerCase().replace(/^(mail|email|no-reply|noreply|mg|smtp)\./, "");
}

/** Sørensen-Dice på bokstavpar. Robust for stavefeil og forkortelser. */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };

  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  let aTotal = 0;
  let bTotal = 0;
  for (const n of aMap.values()) aTotal += n;
  for (const n of bMap.values()) bTotal += n;
  for (const [g, n] of aMap) {
    const m = bMap.get(g);
    if (m) intersection += Math.min(n, m);
  }
  return (2 * intersection) / (aTotal + bTotal);
}

/**
 * Likhet mellom to motpartsnavn, 0-1.
 * Normaliserer først, og gir full score når det ene navnet inneholder det
 * andre som helt ord ("beatport" i "beatport com purchase").
 */
export function counterpartySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const na = normalizeCounterparty(a);
  const nb = normalizeCounterparty(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const aWords = new Set(na.split(" "));
  const bWords = new Set(nb.split(" "));
  const shorter = aWords.size <= bWords.size ? aWords : bWords;
  const longer = aWords.size <= bWords.size ? bWords : aWords;
  let contained = 0;
  for (const w of shorter) if (longer.has(w)) contained++;
  const containment = contained / shorter.size;
  if (containment === 1) return 0.95;

  return Math.max(diceCoefficient(na, nb), containment * 0.9);
}

/** Kutter lange dokumenttekster før de sendes til LLM-en. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.25));
  return `${head}\n\n[... ${text.length - maxChars} tegn utelatt ...]\n\n${tail}`;
}

/** Strip HTML til lesbar tekst. Nok for e-postkvitteringer; ingen DOM-avhengighet. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<td[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
