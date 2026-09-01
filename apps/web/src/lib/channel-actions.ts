"use server";

/**
 * Oppsett av inntakskilder.
 *
 * Alt går gjennom kanalens egen `setup()`. Den er den eneste som vet hva
 * konfigurasjonen skal inneholde, og - viktigere - hvordan den skal DELES:
 * `config` krypteres, `meta` er trygt å vise i UI og logge. Bygger vi raden
 * selv her, er det bare et tidsspørsmål før et passord havner i `config_meta`
 * og blir stående i klartekst i databasen.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, getDb, ingestionChannels } from "@qbikk/db";
import { decryptJson, encryptJson } from "@qbikk/core/crypto";
import { getChannel, type ChannelType } from "@qbikk/ingestion";
import { setFlash } from "./flash";
import { requireUser } from "./data";
import { formFor } from "./channel-forms";

type Action = Promise<void>;

/**
 * Leser inn skjemafeltene og typekonverterer dem.
 *
 * `<input type="number">` gir fortsatt en STRENG i FormData, og kanalens
 * zod-skjema forventer et tall. Uten denne konverteringen feiler `setup()`
 * med «expected number, received string» på et felt brukeren fylte ut riktig.
 */
function collectParams(form: ChannelForm, formData: FormData): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (const field of form.fields) {
    const raw = formData.get(field.name);

    if (field.type === "checkbox") {
      params[field.name] = raw === "on" || raw === "1";
      continue;
    }

    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") continue; // la zod fylle inn standardverdien

    params[field.name] = field.type === "number" ? Number(value) : value;
  }

  return params;
}

type ChannelForm = NonNullable<ReturnType<typeof formFor>>;

/** Oppretter en kilde. Kaster brukeren videre til detaljsida ved suksess. */
export async function createChannel(formData: FormData): Action {
  const user = await requireUser();
  const type = String(formData.get("type") ?? "") as ChannelType;

  const form = formFor(type);
  if (!form) return setFlash({ ok: false, message: "Denne kilden kan ikke settes opp herfra ennå." });
  if (form.unavailable) return setFlash({ ok: false, message: form.unavailable });

  const channel = getChannel(type);
  const params = collectParams(form, formData);

  let result;
  try {
    result = await channel.setup({ userId: user.id, params });
  } catch (err) {
    // Feil her er nesten alltid at brukeren skrev noe feil, eller at
    // leverandøren avviste nøklene. Begge deler skal de få vite om.
    return setFlash({ ok: false, message: friendlyError(err) });
  }

  const name = String(formData.get("name") ?? "").trim() || form.title;

  const [row] = await getDb()
    .insert(ingestionChannels)
    .values({
      userId: user.id,
      type,
      name,
      // Hemmeligheter krypteres. `meta` er kanalens eget utvalg av det som er
      // trygt å vise - vi legger aldri noe til her på egen hånd.
      configEncrypted: encryptJson(result.config),
      configMeta: (result.meta ?? {}) as Record<string, unknown>,
      status: result.pending ? "needs_auth" : "active",
    })
    .returning({ id: ingestionChannels.id });

  if (!row) return setFlash({ ok: false, message: "Klarte ikke å lagre kilden." });

  revalidatePath("/kanaler");
  revalidatePath("/kom-i-gang");
  await setFlash({
    ok: true,
    message: result.pending ? "Nesten der - det er ett steg igjen." : `${form.title} er koblet til.`,
  });

  redirect(`/kanaler/${row.id}`);
}

/**
 * Trinn to for banken: brukeren har valgt bank, og vi ber om en lenke de kan
 * godkjenne i.
 *
 * Nøklene hentes fra den KRYPTERTE raden, ikke fra skjulte felter i skjemaet.
 * Ellers ville de ligget i HTML-kilden på sida.
 */
export async function connectBankInstitution(formData: FormData): Action {
  const user = await requireUser();
  const channelId = String(formData.get("channelId") ?? "");
  const institutionId = String(formData.get("institutionId") ?? "");
  if (!channelId || !institutionId) return setFlash({ ok: false, message: "Velg en bank først." });

  const db = getDb();
  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, channelId), eq(ingestionChannels.userId, user.id)))
    .limit(1);
  if (!row) return setFlash({ ok: false, message: "Fant ikke kilden." });

  const stored = row.configEncrypted ? decryptJson<Record<string, unknown>>(row.configEncrypted) : {};

  try {
    const result = await getChannel("bank").setup({
      userId: user.id,
      params: { ...stored, institutionId },
    });

    await db
      .update(ingestionChannels)
      .set({
        configEncrypted: encryptJson(result.config),
        configMeta: (result.meta ?? {}) as Record<string, unknown>,
        status: "needs_auth",
        updatedAt: new Date(),
      })
      .where(eq(ingestionChannels.id, channelId));

    revalidatePath(`/kanaler/${channelId}`);
    return setFlash({ ok: true, message: "Klar. Følg lenka for å godkjenne i nettbanken din." });
  } catch (err) {
    return setFlash({ ok: false, message: friendlyError(err) });
  }
}

/**
 * Fjerner en kilde.
 *
 * Bilagene som allerede er hentet inn blir stående - de er en del av
 * regnskapet, og har ingenting med kilden å gjøre lenger. Skjemaet setter
 * `source_channel_id` til null i stedet for å slette dem.
 */
export async function removeChannel(formData: FormData): Action {
  const user = await requireUser();
  const channelId = String(formData.get("channelId") ?? "");
  if (!channelId) return setFlash({ ok: false, message: "Mangler kilde." });

  const db = getDb();
  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, channelId), eq(ingestionChannels.userId, user.id)))
    .limit(1);
  if (!row) return setFlash({ ok: false, message: "Fant ikke kilden." });

  if (row.type === "email_forward") {
    return setFlash({
      ok: false,
      message: "E-postadressen din kan ikke fjernes - den er inngangen til alt annet.",
    });
  }

  // Gi kanalen sjansen til å rydde opp etter seg (lukke sesjoner, glemme
  // innlogginger) før raden forsvinner.
  const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
  if (channel.teardown && row.configEncrypted) {
    await channel
      .teardown({
        userId: user.id,
        channelId: row.id,
        config: channel.configSchema.parse(decryptJson(row.configEncrypted)) as never,
        cursor: null,
        logger: console,
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => undefined);
  }

  await db.delete(ingestionChannels).where(eq(ingestionChannels.id, channelId));

  revalidatePath("/kanaler");
  await setFlash({ ok: true, message: "Kilden er fjernet. Bilagene du allerede har fått inn er urørt." });
  redirect("/kanaler");
}

/**
 * Oversetter tekniske feil til noe en frisør kan handle på.
 *
 * Den rå meldingen tas med til slutt - den hjelper når noe uventet skjer -
 * men den skal ikke være det første brukeren møter.
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Fant ikke serveren. Sjekk at adressen er skrevet riktig.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) {
    return "Fikk ikke kontakt. Serveren svarte ikke - prøv igjen om litt.";
  }
  if (/auth|credential|login|invalid|401|403/i.test(raw)) {
    return "Innloggingen ble avvist. Dobbeltsjekk brukernavn og app-passord.";
  }
  if (/Invalid|expected|required/i.test(raw)) {
    return `Noe manglet eller var feil utfylt: ${raw}`;
  }
  return raw;
}
