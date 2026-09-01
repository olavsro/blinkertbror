"use server";

/**
 * Server actions - alle skriveveier fra UI-et.
 *
 * Hver eneste av dem kaller en pipeline-funksjon i @qbikk/core. Ingen av dem
 * skriver til `vouchers` direkte. Grunnen: korreksjonshistorikk, dedup og
 * matchereglene håndheves der, og en «rask» direkte oppdatering herfra ville
 * gått utenom revisjonssporet uten at noen merket det før om fem år.
 */
import { revalidatePath } from "next/cache";
import { and, eq, getDb, ingestionChannels } from "@qbikk/db";
import {
  applyCorrection,
  mergeMatched,
  proposeMatches,
  rejectMatch,
  type CorrectableField,
} from "@qbikk/core";
import { decryptJson } from "@qbikk/core/crypto";
import { getChannel } from "@qbikk/ingestion";
import { JOBS, sendJob } from "@qbikk/jobs";
import { getQueue } from "./queue";
import { requireUser } from "./data";
import { setFlash } from "./flash";

/**
 * Actions returnerer `void`, ikke et resultatobjekt.
 *
 * `<form action={fn}>` i en serverkomponent krever det: en action som
 * returnerer noe, kan bare brukes fra en klientkomponent via
 * `useActionState`. Tilbakemeldingen til brukeren går derfor gjennom
 * `setFlash()`, og hele UI-et slipper å bli klientkode. Se lib/flash.ts.
 */
type Action = Promise<void>;

/** Retter ett felt. Skriver til `corrections` og lærer en regel der det gir mening. */
export async function correctVoucher(formData: FormData): Action {
  const user = await requireUser();
  const voucherId = String(formData.get("voucherId") ?? "");
  const field = String(formData.get("field") ?? "") as CorrectableField;
  const raw = formData.get("value");

  if (!voucherId || !field) return setFlash({ ok: false, message: "Mangler bilag eller felt" });

  // Beløp skrives inn i kroner i UI, men lagres i øre. Konverteringen hører
  // hjemme her, på grensa mellom menneske og database.
  let value: unknown = typeof raw === "string" ? raw : null;
  if (field === "grossAmount" && typeof raw === "string") {
    const { parseAmount } = await import("@qbikk/core/money");
    value = parseAmount(raw);
    if (value === null) return setFlash({ ok: false, message: `«${raw}» er ikke et gyldig beløp` });
  }

  const result = await applyCorrection(getDb(), {
    userId: user.id,
    voucherId,
    field,
    value,
    reason: (formData.get("reason") as string | null) ?? null,
    actor: "user",
  });

  revalidatePath("/bilag");
  revalidatePath("/handling");
  revalidatePath("/");

  return setFlash({
    ok: true,
    message: result.learnedRuleId
      ? "Rettet - og lært. Neste bilag fra samme leverandør havner riktig."
      : "Rettet.",
  });
}

/** Godkjenner et bilag. Går via samme korreksjonsvei som alt annet. */
export async function confirmVoucher(formData: FormData): Action {
  const user = await requireUser();
  const voucherId = String(formData.get("voucherId") ?? "");
  if (!voucherId) return setFlash({ ok: false, message: "Mangler bilag" });

  await applyCorrection(getDb(), {
    userId: user.id,
    voucherId,
    field: "status",
    value: "confirmed",
    reason: "Godkjent av bruker",
    actor: "user",
  });

  revalidatePath("/bilag");
  revalidatePath("/handling");
  return setFlash({ ok: true, message: "Bilaget er godkjent." });
}

/**
 * Bekrefter en foreslått match og slår bilagene sammen.
 *
 * Dette er handlingen systemet med vilje IKKE gjør selv når matchen er
 * tvetydig. Her sier brukeren ja, og da - og bare da - blir de to til ett.
 */
export async function confirmMatch(formData: FormData): Action {
  const user = await requireUser();
  const bankVoucherId = String(formData.get("bankVoucherId") ?? "");
  const documentVoucherId = String(formData.get("documentVoucherId") ?? "");
  if (!bankVoucherId || !documentVoucherId) return setFlash({ ok: false, message: "Mangler bilag" });

  await mergeMatched(getDb(), {
    userId: user.id,
    bankVoucherId,
    documentVoucherId,
    actor: "user",
  });

  revalidatePath("/handling");
  revalidatePath("/bilag");
  return setFlash({ ok: true, message: "Bank og kvittering er slått sammen til ett bilag." });
}

export async function dismissMatch(formData: FormData): Action {
  const user = await requireUser();
  const bankVoucherId = String(formData.get("bankVoucherId") ?? "");
  const documentVoucherId = String(formData.get("documentVoucherId") ?? "");
  if (!bankVoucherId || !documentVoucherId) return setFlash({ ok: false, message: "Mangler bilag" });

  await rejectMatch(getDb(), { userId: user.id, bankVoucherId, documentVoucherId, actor: "user" });

  revalidatePath("/handling");
  return setFlash({ ok: true, message: "Forslaget er avvist. Bilagene er urørt." });
}

/** Leter etter matcher på nytt for ett bilag. */
export async function rematchVoucher(formData: FormData): Action {
  const user = await requireUser();
  const voucherId = String(formData.get("voucherId") ?? "");
  if (!voucherId) return setFlash({ ok: false, message: "Mangler bilag" });

  const result = await proposeMatches(getDb(), { userId: user.id, voucherId });

  revalidatePath("/handling");
  return setFlash({
    ok: true,
    message:
      result.linked.length > 0
        ? "Fant en sikker match og koblet den."
        : result.proposals.length > 0
          ? "Fant et forslag - se «krever handling»."
          : "Fant ingen match.",
  });
}

/** Kjører ekstraksjonen på nytt. Rådokumentet er urørt, så dette er trygt. */
export async function reextractVoucher(formData: FormData): Action {
  const user = await requireUser();
  const rawDocumentId = String(formData.get("rawDocumentId") ?? "");
  if (!rawDocumentId) return setFlash({ ok: false, message: "Bilaget har ikke noe rådokument" });

  const boss = await getQueue();
  await sendJob(boss, JOBS.extractDocument, { userId: user.id, rawDocumentId, force: true });

  revalidatePath("/bilag");
  return setFlash({ ok: true, message: "Tolker dokumentet på nytt. Oppdater om litt." });
}

/** Ber om en synk nå. Skjøre kanaler går i sin egen kø. */
export async function syncChannelNow(formData: FormData): Action {
  const user = await requireUser();
  const channelId = String(formData.get("channelId") ?? "");
  const full = formData.get("full") === "1";
  if (!channelId) return setFlash({ ok: false, message: "Mangler kanal" });

  const db = getDb();
  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, channelId), eq(ingestionChannels.userId, user.id)))
    .limit(1);
  if (!row) return setFlash({ ok: false, message: "Ukjent kanal" });

  const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
  if (!channel.capabilities.pull) {
    return setFlash({ ok: false, message: `${channel.label} tar imot data selv - den kan ikke hentes fra.` });
  }

  const boss = await getQueue();
  await sendJob(
    boss,
    channel.capabilities.fragile ? JOBS.syncChannelFragile : JOBS.syncChannel,
    { userId: user.id, channelId, full, trigger: "manual" },
    { singletonKey: channelId, singletonSeconds: 60 },
  );

  revalidatePath("/kanaler");
  return setFlash({ ok: true, message: full ? "Full backfill lagt i kø." : "Synk lagt i kø." });
}

/** Tester en kanal her og nå, uten å gå veien om jobbkøen. */
export async function checkChannelHealth(formData: FormData): Action {
  const user = await requireUser();
  const channelId = String(formData.get("channelId") ?? "");
  if (!channelId) return setFlash({ ok: false, message: "Mangler kanal" });

  const db = getDb();
  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, channelId), eq(ingestionChannels.userId, user.id)))
    .limit(1);
  if (!row) return setFlash({ ok: false, message: "Ukjent kanal" });

  const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const config = channel.configSchema.parse(row.configEncrypted ? decryptJson(row.configEncrypted) : {});
    const health = await channel.healthCheck({
      userId: user.id,
      channelId: row.id,
      config: config as never,
      cursor: null,
      logger: console,
      signal: controller.signal,
    });

    await db
      .update(ingestionChannels)
      .set({
        status: health.ok ? "active" : health.needsUserAction ? "needs_auth" : "error",
        lastError: health.ok ? null : health.message,
        updatedAt: new Date(),
      })
      .where(eq(ingestionChannels.id, row.id));

    revalidatePath("/kanaler");
    return setFlash({ ok: health.ok, message: health.message });
  } catch (err) {
    return setFlash({ ok: false, message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}

/** Pause/gjenoppta. En pauset kanal hoppes over av cron-fordeleren. */
export async function toggleChannel(formData: FormData): Action {
  const user = await requireUser();
  const channelId = String(formData.get("channelId") ?? "");
  const paused = formData.get("paused") === "1";
  if (!channelId) return setFlash({ ok: false, message: "Mangler kanal" });

  await getDb()
    .update(ingestionChannels)
    .set({ status: paused ? "paused" : "active", updatedAt: new Date() })
    .where(and(eq(ingestionChannels.id, channelId), eq(ingestionChannels.userId, user.id)));

  revalidatePath("/kanaler");
  return setFlash({ ok: true, message: paused ? "Kanalen er satt på pause." : "Kanalen er aktiv igjen." });
}
