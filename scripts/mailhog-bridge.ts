/**
 * MailHog-bro: SMTP i utvikling -> den samme webhooken produksjonen bruker.
 *
 * Poenget er ÉN kodevei. I produksjon POSTer Mailgun eller Postmark til
 * `/api/inbound/email`. Lokalt tar MailHog imot på SMTP 1025, og denne broen
 * poller det, parser MIME-en og POSTer NØYAKTIG samme `InboundEmail`-form til
 * det samme endepunktet, med den samme delte hemmeligheten. Ingenting i
 * applikasjonen vet forskjell - og det som virker lokalt, virker i drift.
 *
 * Kjør: pnpm mailhog:bridge
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { simpleParser } from "mailparser";

const MAILHOG = process.env.MAILHOG_API_URL ?? "http://localhost:8025";
const TARGET = `${process.env.APP_URL ?? "http://localhost:3000"}/api/inbound/email`;
const SECRET = process.env.INBOUND_WEBHOOK_SECRET ?? "dev-secret";
const INTERVAL_MS = Number(process.env.BRIDGE_INTERVAL_MS ?? 3000);

/**
 * Hvilke meldinger vi allerede har sendt, lagret på disk.
 *
 * I minnet ville holdt til broen restartes - og da ville hele innboksen blitt
 * sendt inn på nytt. Dedupen i pipeline ville tatt det, men da tester vi
 * dedupen i stedet for det vi faktisk holder på med.
 */
const STATE_FILE = new URL("../.mailhog-bridge-state.json", import.meta.url);

interface MailHogMessage {
  ID: string;
  Raw: { Data: string; From: string; To: string[] };
}

async function loadSeen(): Promise<Set<string>> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

async function saveSeen(seen: Set<string>): Promise<void> {
  await mkdir(dirname(STATE_FILE.pathname), { recursive: true }).catch(() => undefined);
  // Bare de siste 500 - fila skal ikke vokse i det uendelige.
  await writeFile(STATE_FILE, JSON.stringify([...seen].slice(-500), null, 0), "utf8");
}

async function poll(seen: Set<string>): Promise<void> {
  const res = await fetch(`${MAILHOG}/api/v2/messages?limit=50`);
  if (!res.ok) throw new Error(`MailHog svarte ${res.status}`);

  const body = (await res.json()) as { items: MailHogMessage[] };

  // Eldste først, så bilagene kommer inn i den rekkefølgen de ble sendt.
  for (const message of [...body.items].reverse()) {
    if (seen.has(message.ID)) continue;

    const parsed = await simpleParser(message.Raw.Data);
    const html = typeof parsed.html === "string" ? parsed.html : null;

    const payload = {
      From: parsed.from?.text ?? message.Raw.From,
      // Mottakeren avgjør hvilken bruker bilaget havner hos, så den tas fra
      // SMTP-konvolutten hvis headeren mangler.
      To: Array.isArray(parsed.to) ? (parsed.to[0]?.text ?? "") : (parsed.to?.text ?? message.Raw.To[0] ?? ""),
      Subject: parsed.subject ?? null,
      TextBody: parsed.text ?? null,
      HtmlBody: html,
      MessageID: parsed.messageId ?? message.ID,
      Date: parsed.date?.toISOString() ?? null,
      Attachments: (parsed.attachments ?? []).map((a) => ({
        Name: a.filename ?? "vedlegg",
        Content: a.content.toString("base64"),
        ContentType: a.contentType,
        ContentLength: a.size,
        ContentID: a.contentId ?? null,
      })),
      // Hele MIME-meldingen følger med, slik Mailgun gjør det. Da er det den
      // som arkiveres, ikke vår rekonstruksjon av den.
      RawEmail: message.Raw.Data,
      Headers: Object.fromEntries([...parsed.headers.entries()].map(([k, v]) => [k, String(v)])),
    };

    const post = await fetch(TARGET, {
      method: "POST",
      headers: { "content-type": "application/json", "x-qbikk-secret": SECRET },
      body: JSON.stringify(payload),
    });

    const text = await post.text();
    console.log(`  ${post.status}  ${payload.Subject ?? "(uten emne)"}  ->  ${text.slice(0, 120)}`);

    // Markeres som sett uansett svar. En 401 fikser seg ikke av å prøve igjen
    // hvert tredje sekund; da er hemmeligheten feil og det skal du få se.
    seen.add(message.ID);
  }

  await saveSeen(seen);
}

async function main(): Promise<void> {
  const seen = await loadSeen();
  console.log("");
  console.log(`  MailHog-bro kjører`);
  console.log(`  leser   ${MAILHOG}/api/v2/messages`);
  console.log(`  POSTer  ${TARGET}`);
  console.log(`  kjenner ${seen.size} melding(er) fra før`);
  console.log("");

  for (;;) {
    await poll(seen).catch((err: unknown) => {
      console.error("  feil:", err instanceof Error ? err.message : err);
    });
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((err: unknown) => {
  console.error("Broen stoppet:", err);
  process.exit(1);
});
