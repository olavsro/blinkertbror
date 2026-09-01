/**
 * Kanalabstraksjonen og verifiseringen av innkommende e-post.
 *
 * Signaturtesten er sikkerhetskritisk: uten den kan hvem som helst POSTe
 * falske bilag inn i regnskapet. Resten slår fast at registret faktisk holder
 * løftet om at «legg til en kanal = skriv én fil».
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  emailForwardChannel,
  normalizeMailgun,
  slugFromRecipient,
  extractAddress,
  verifyMailgunSignature,
  verifySharedSecret,
} from "@qbikk/ingestion/channels/email-forward";
import { getChannel, listChannels, pullableChannels, hasChannel } from "@qbikk/ingestion/registry";
import { toMinorUnits } from "@qbikk/ingestion/channels/bank-gocardless";
import { pickPrimaryAttachment } from "@qbikk/core/pipeline";

const SECRET = "test-hemmelighet";

describe("verifisering av webhook", () => {
  it("godtar en korrekt Mailgun-signatur", () => {
    const timestamp = "1772000000";
    const token = "abc123";
    const signature = createHmac("sha256", SECRET).update(timestamp + token).digest("hex");

    expect(verifyMailgunSignature({ timestamp, token, signature }, SECRET)).toBe(true);
  });

  it("avviser feil signatur, feil hemmelighet og tuklet timestamp", () => {
    const timestamp = "1772000000";
    const token = "abc123";
    const signature = createHmac("sha256", SECRET).update(timestamp + token).digest("hex");

    expect(verifyMailgunSignature({ timestamp, token, signature: "0".repeat(64) }, SECRET)).toBe(false);
    expect(verifyMailgunSignature({ timestamp, token, signature }, "feil-hemmelighet")).toBe(false);
    expect(verifyMailgunSignature({ timestamp: "1772000001", token, signature }, SECRET)).toBe(false);
  });

  it("avviser manglende delt hemmelighet uten å kræsje", () => {
    expect(verifySharedSecret(SECRET, SECRET)).toBe(true);
    expect(verifySharedSecret("feil", SECRET)).toBe(false);
    expect(verifySharedSecret(null, SECRET)).toBe(false);
    // Ulik lengde skal returnere false, ikke kaste fra timingSafeEqual.
    expect(verifySharedSecret("kort", SECRET)).toBe(false);
  });
});

describe("mottakeradressen identifiserer brukeren", () => {
  it("henter lokaldelen", () => {
    expect(slugFromRecipient("ola-4f9c@bilag.minapp.no")).toBe("ola-4f9c");
    expect(slugFromRecipient("Ola <ola-4f9c@bilag.minapp.no>")).toBe("ola-4f9c");
  });

  it("stripper Gmail-stil +-suffiks", () => {
    expect(slugFromRecipient("ola-4f9c+beatport@bilag.minapp.no")).toBe("ola-4f9c");
  });

  it("returnerer null på søppel i stedet for å gjette", () => {
    expect(slugFromRecipient("ikke en adresse")).toBeNull();
    expect(slugFromRecipient(null)).toBeNull();
    expect(extractAddress("<>")).toBeNull();
  });
});

describe("leverandørnormalisering", () => {
  it("gjør Mailgun-felter om til den felles formen", () => {
    const email = normalizeMailgun(
      {
        from: "Beatport <noreply@beatport.com>",
        recipient: "ola-4f9c@bilag.minapp.no",
        subject: "Your receipt",
        "stripped-text": "Total USD 14.94",
        "message-headers": JSON.stringify([["X-Test", "1"]]),
      },
      [],
    );

    expect(email.From).toBe("Beatport <noreply@beatport.com>");
    expect(email.To).toBe("ola-4f9c@bilag.minapp.no");
    expect(email.TextBody).toBe("Total USD 14.94");
    expect(email.Headers).toEqual({ "X-Test": "1" });
  });

  it("tåler ugyldig header-JSON uten å velte importen", () => {
    expect(normalizeMailgun({ "message-headers": "{ikke json" }, []).Headers).toEqual({});
  });
});

describe("e-postkanalen produserer DocumentItem", () => {
  const ctx = {
    userId: "u1",
    channelId: "c1",
    config: { slug: "ola-4f9c", allowedSenders: [] },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };

  it("leser brødtekst og vedlegg", async () => {
    const items = await emailForwardChannel.receive(ctx, {
      From: "faktura@leverandor.no",
      To: "ola-4f9c@bilag.minapp.no",
      Subject: "Faktura 123",
      TextBody: "Å betale kr 1 250,00",
      HtmlBody: null,
      MessageID: "<123@leverandor.no>",
      Date: "2026-03-12T10:00:00Z",
      Attachments: [
        { Name: "faktura.pdf", Content: Buffer.from("%PDF-1.4").toString("base64"), ContentType: "application/pdf" },
      ],
    });

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe("document");
    expect(item.sender).toBe("faktura@leverandor.no");
    expect(item.externalRef).toBe("<123@leverandor.no>");
    expect(item.attachments).toHaveLength(1);
  });

  it("faller tilbake på HTML når det ikke finnes brødtekst", async () => {
    const items = await emailForwardChannel.receive(ctx, {
      From: "a@b.no", To: "ola-4f9c@bilag.minapp.no", Subject: null,
      TextBody: null, HtmlBody: "<p>Sum: <b>kr 100</b></p>",
      MessageID: null, Date: null, Attachments: [],
    });

    expect(items[0]!.text).toContain("Sum:");
    expect(items[0]!.text).toContain("kr 100");
  });

  it("avviser avsendere utenfor en satt hviteliste", async () => {
    const items = await emailForwardChannel.receive(
      { ...ctx, config: { slug: "ola-4f9c", allowedSenders: ["ok@bra.no"] } },
      {
        From: "fremmed@ukjent.no", To: "ola-4f9c@bilag.minapp.no", Subject: null,
        TextBody: "x", HtmlBody: null, MessageID: null, Date: null, Attachments: [],
      },
    );

    expect(items).toHaveLength(0);
  });
});

describe("valg av hovedvedlegg", () => {
  const file = (mime: string, bytes: number, over = {}) => ({
    filename: "f", mime, data: Buffer.alloc(bytes), inline: false, contentId: null, ...over,
  });

  it("velger PDF framfor bilde", () => {
    expect(pickPrimaryAttachment([file("image/png", 50_000), file("application/pdf", 1000)])).toBe(1);
  });

  it("hopper over innebygde logoer", () => {
    // Logoen i signaturen har Content-ID og er ikke bilaget.
    expect(pickPrimaryAttachment([file("image/png", 50_000, { contentId: "logo@x" })])).toBe(-1);
  });

  it("hopper over små bilder", () => {
    // 4 kB er en logo, ikke et kvitteringsfoto.
    expect(pickPrimaryAttachment([file("image/jpeg", 4000)])).toBe(-1);
    expect(pickPrimaryAttachment([file("image/jpeg", 400_000)])).toBe(0);
  });

  it("returnerer -1 når brødteksten selv er bilaget", () => {
    expect(pickPrimaryAttachment([])).toBe(-1);
  });
});

describe("kanalregisteret", () => {
  it("kjenner alle seks kanalene", () => {
    const types = listChannels().map((c) => c.type);
    expect(types).toEqual([
      "email_forward", "inbox_scan", "bank", "file_upload", "folder_watch", "browser",
    ]);
  });

  it("gir hver kanal et navn og et konfigskjema", () => {
    for (const channel of listChannels()) {
      expect(channel.label).toBeTruthy();
      expect(channel.configSchema).toBeTruthy();
      // Push-kanaler må ha receive(), pull-kanaler må ha pull().
      if (channel.capabilities.push) expect(typeof channel.receive).toBe("function");
      if (channel.capabilities.pull) expect(typeof channel.pull).toBe("function");
    }
  });

  it("markerer BARE browserkanalen som skjør", () => {
    const fragile = listChannels().filter((c) => c.capabilities.fragile).map((c) => c.type);
    expect(fragile).toEqual(["browser"]);
  });

  it("lar seg slå opp på type og kaster på ukjent", () => {
    expect(getChannel("bank").type).toBe("bank");
    expect(hasChannel("bank")).toBe(true);
    expect(hasChannel("tullekanal")).toBe(false);
    // @ts-expect-error - ukjent type skal ikke kompilere, og skal kaste i drift
    expect(() => getChannel("tullekanal")).toThrow();
  });

  it("har fire kanaler som kan hentes fra på timeplan", () => {
    expect(pullableChannels().map((c) => c.type)).toEqual([
      "inbox_scan", "bank", "folder_watch", "browser",
    ]);
  });
});

describe("bankbeløp går aldri via flyttall", () => {
  it("gjør desimalstreng om til minste enhet", () => {
    expect(toMinorUnits("-1234.56", "NOK")).toBe(-123_456);
    expect(toMinorUnits("1234.56", "NOK")).toBe(123_456);
    expect(toMinorUnits("0.10", "NOK")).toBe(10);
    expect(toMinorUnits("1234", "NOK")).toBe(123_400);
    expect(toMinorUnits("1000", "JPY")).toBe(1000);
  });

  it("treffer beløp som ville flyttet seg med parseFloat", () => {
    // 0.1 + 0.2 !== 0.3 i flyttall. Et regnskap tåler ikke den slags.
    expect(toMinorUnits("0.29", "NOK") + toMinorUnits("0.01", "NOK")).toBe(30);
    expect(toMinorUnits("8.20", "NOK")).toBe(820);
  });
});
