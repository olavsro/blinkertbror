import "server-only";
import { cookies } from "next/headers";

/**
 * Tilbakemelding fra en server action til neste render.
 *
 * Hvorfor ikke `useActionState`: da måtte hver eneste knapp i UI-et vært en
 * klientkomponent. Hele dette grensesnittet er serverrendret uten en linje
 * klient-JavaScript, og det er verdt å beholde - sidene laster øyeblikkelig
 * og kan aldri vise noe annet enn det som faktisk står i databasen.
 *
 * En serverkomponent kan ikke slette en cookie under rendering, så meldingen
 * rydder opp etter seg selv med kort levetid i stedet. Den skal uansett bare
 * overleve én navigasjon.
 */
const COOKIE = "qbikk_flash";
const MAX_AGE_SECONDS = 10;

export interface Flash {
  ok: boolean;
  message: string;
}

export async function setFlash(flash: Flash): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, JSON.stringify(flash), {
    maxAge: MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}

export async function readFlash(): Promise<Flash | null> {
  const store = await cookies();
  const raw = store.get(COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Flash;
  } catch {
    return null;
  }
}
