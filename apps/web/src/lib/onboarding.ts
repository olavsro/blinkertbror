import "server-only";
import { and, count, eq, getDb, ingestionChannels, rawDocuments, users, vouchers } from "@qbikk/db";
import type { User } from "@qbikk/db";

/**
 * Tilstanden til «Kom i gang».
 *
 * Hvor langt brukeren er kommet UTLEDES av hva som faktisk finnes i
 * databasen - ikke av et lagret stegnummer. Har det kommet inn en kvittering,
 * er det steget ferdig, punktum. Et lagret stegnummer ville før eller siden
 * kommet i utakt med virkeligheten: brukeren sletter noe, en synk feiler,
 * eller de gjør stegene i en annen rekkefølge enn vi tenkte.
 *
 * Det eneste som lagres er `onboardingCompletedAt` - at brukeren selv sa
 * «ferdig».
 */
export interface OnboardingStatus {
  /** Har brukeren sagt hva slags arbeid de gjør? */
  choseTrade: boolean;
  /** Har de sett og kopiert adressen sin? (utledes av at kanalen finnes) */
  hasAddress: boolean;
  /** Har det kommet inn minst én kvittering? */
  receivedFirst: boolean;
  /** Har systemet klart å lese den? */
  readFirst: boolean;
  /** Har de koblet på flere kilder enn e-postadressen? */
  addedMoreSources: boolean;
  /** Har de trykket «ferdig»? */
  finished: boolean;

  documentCount: number;
  voucherCount: number;
  extraSourceCount: number;
}

export async function loadOnboardingStatus(user: User): Promise<OnboardingStatus> {
  const db = getDb();

  const [docs, vouch, channels] = await Promise.all([
    db
      .select({ n: count() })
      .from(rawDocuments)
      .where(eq(rawDocuments.userId, user.id)),
    db.select({ n: count() }).from(vouchers).where(eq(vouchers.userId, user.id)),
    db.select({ type: ingestionChannels.type }).from(ingestionChannels).where(eq(ingestionChannels.userId, user.id)),
  ]);

  const documentCount = Number(docs[0]?.n ?? 0);
  const voucherCount = Number(vouch[0]?.n ?? 0);
  const extraSourceCount = channels.filter((c) => c.type !== "email_forward").length;

  return {
    // `generic` er standardverdien ingen velger aktivt - den betyr «ikke svart».
    choseTrade: user.profile !== "generic",
    hasAddress: channels.some((c) => c.type === "email_forward"),
    receivedFirst: documentCount > 0,
    readFirst: voucherCount > 0,
    addedMoreSources: extraSourceCount > 0,
    finished: user.onboardingCompletedAt !== null,
    documentCount,
    voucherCount,
    extraSourceCount,
  };
}

/** Steget brukeren skal stå på nå. 1-indeksert; 0 = alt er gjort. */
export function currentStep(status: OnboardingStatus): number {
  if (!status.choseTrade) return 1;
  if (!status.hasAddress) return 2;
  if (!status.receivedFirst) return 3;
  return 4;
}

/**
 * Skal vi dytte brukeren til «Kom i gang»?
 *
 * Bare før de har sagt seg ferdig OG før det har kommet inn noe. En bruker
 * med bilag i systemet skal aldri møte en oppstartsveiviser igjen - da har
 * de tydeligvis kommet i gang.
 */
export function shouldShowWizard(status: OnboardingStatus): boolean {
  return !status.finished && !status.readFirst;
}

/** Bransjevalgene, i ord folk faktisk bruker om seg selv. */
export const TRADES = [
  {
    key: "dj",
    title: "Jeg spiller eller lager musikk",
    blurb: "DJ, artist, produsent. Spillejobber, utstyr, musikk du kjøper og penger du får utbetalt.",
    emoji: "🎧",
  },
  {
    key: "frisor",
    title: "Jeg jobber med hår og skjønnhet",
    blurb: "Frisør, barberer, negl og hud. Varer du kjøper inn, leie av stol, produkter du selger videre.",
    emoji: "✂️",
  },
  {
    key: "dagligvare",
    title: "Jeg driver butikk eller serverer mat",
    blurb: "Butikk, kiosk, kafé. Varer inn og varer ut, med ulike avgiftssatser på mat og annet.",
    emoji: "🛒",
  },
  {
    key: "generic",
    title: "Noe helt annet",
    blurb: "Vi bruker et nøytralt oppsett som passer de fleste. Du kan endre det når som helst.",
    emoji: "💼",
  },
] as const;

export function tradeTitle(key: string): string {
  return TRADES.find((t) => t.key === key)?.title ?? "Noe helt annet";
}

export { users };
