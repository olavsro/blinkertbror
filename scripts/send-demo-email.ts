/**
 * Sender en fixture inn i systemet via SMTP, akkurat som en videresendt
 * e-post ville kommet.
 *
 * Kjør: pnpm demo:email [fixture-navn|alle]
 *
 * Ingen nodemailer: å bygge en MIME-melding og snakke SMTP med MailHog er
 * under hundre linjer, og MailHog krever hverken TLS eller autentisering.
 * En avhengighet mindre i et prosjekt som allerede har mange.
 */
import "dotenv/config";
import { createConnection, type Socket } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { getDb, users } from "@qbikk/db";
import { inboundAddress } from "@qbikk/core/config";

const HOST = process.env.SMTP_HOST ?? "localhost";
const PORT = Number(process.env.SMTP_PORT ?? 1025);

interface Fixture {
  From: string;
  To: string;
  Subject: string | null;
  TextBody: string | null;
  HtmlBody: string | null;
  MessageID: string | null;
  Date: string | null;
  Attachments: Array<{ Name: string; Content: string; ContentType: string }>;
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? "beatport-purchase";
  const dir = new URL("../fixtures/emails/", import.meta.url);

  const names =
    which === "alle"
      ? (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
      : [which];

  const db = getDb();
  const [user] = await db.select().from(users).limit(1);
  if (!user) throw new Error("Ingen bruker. Kjør `pnpm seed` først.");

  const recipient = inboundAddress(user.inboundSlug);

  for (const name of names) {
    const fixture = JSON.parse(await readFile(new URL(`${name}.json`, dir), "utf8")) as Fixture;
    await sendMail(buildMime(fixture, recipient), addressOf(fixture.From), recipient);
    console.log(`  sendt  ${name}  ->  ${recipient}`);
  }

  console.log("");
  console.log("  Broen plukker dem opp innen få sekunder:  pnpm mailhog:bridge");
  console.log(`  Se dem i MailHog:                         ${process.env.MAILHOG_API_URL ?? "http://localhost:8025"}`);
  console.log("");
}

function addressOf(value: string): string {
  return value.match(/<([^>]+)>/)?.[1] ?? value.trim();
}

/** Minimal MIME. multipart/mixed bare når det faktisk finnes vedlegg. */
function buildMime(fixture: Fixture, recipient: string): string {
  const boundary = `qbikk-${Math.random().toString(36).slice(2)}`;
  const date = fixture.Date ? new Date(fixture.Date).toUTCString() : new Date().toUTCString();

  const headers = [
    `From: ${fixture.From}`,
    `To: ${recipient}`,
    `Subject: ${encodeHeader(fixture.Subject ?? "(uten emne)")}`,
    `Date: ${date}`,
    `Message-ID: ${fixture.MessageID ?? `<${boundary}@qbikk.local>`}`,
    "MIME-Version: 1.0",
  ];

  const attachments = fixture.Attachments ?? [];
  const body = fixture.TextBody ?? "";

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64");
    return `${headers.join("\r\n")}\r\n\r\n${wrap(Buffer.from(body, "utf8").toString("base64"))}`;
  }

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(body, "utf8").toString("base64")),
  ];

  for (const att of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.ContentType}; name="${att.Name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${att.Name}"`,
      "",
      wrap(att.Content),
    );
  }
  parts.push(`--${boundary}--`, "");

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

/** RFC 2047 for emner med æ, ø og å. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function wrap(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * SMTP-dialogen, håndskrevet.
 *
 * Hvert steg venter på svarkoden før neste sendes - det er hele protokollen.
 * Punktum alene på en linje avslutter DATA, så en linje i meldingen som
 * begynner med punktum må dobles («dot stuffing»), ellers kuttes e-posten der.
 */
function sendMail(mime: string, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host: HOST, port: PORT });
    const steps = [
      `EHLO qbikk.local`,
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      `DATA`,
      `${mime.replace(/\r?\n\./g, "\r\n..")}\r\n.`,
      `QUIT`,
    ];
    let step = -1;

    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error(`Tidsavbrudd mot SMTP ${HOST}:${PORT}. Kjører docker compose?`));
    });

    socket.on("data", (chunk: string) => {
      const code = Number(chunk.slice(0, 3));
      if (code >= 400) {
        socket.destroy();
        reject(new Error(`SMTP-feil: ${chunk.trim()}`));
        return;
      }
      step++;
      const next = steps[step];
      if (next === undefined) return;
      socket.write(`${next}\r\n`);
    });

    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Klarte ikke å sende:", err);
    process.exit(1);
  });
