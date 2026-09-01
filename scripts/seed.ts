/**
 * Seeder én bruker med bransjeprofil, videresendingsadresse og kategoriregler.
 *
 * Kjør: pnpm seed
 *
 * Idempotent: kjører du den to ganger, får du den samme brukeren tilbake i
 * stedet for en til. Reglene fra profilen legges bare inn hvis de ikke
 * allerede finnes, slik at dine egne rettinger overlever en ny seeding.
 */
import "dotenv/config";
import { and, eq, getDb, categoryRules, ingestionChannels, users } from "@qbikk/db";
import { config, generateInboundSlug, inboundAddress } from "@qbikk/core/config";
import { encryptJson } from "@qbikk/core/crypto";
import { getProfile } from "@qbikk/core/profiles/index";
import { categoryByKey, type IndustryProfile } from "@qbikk/core/profiles/types";

const EMAIL = process.env.SEED_EMAIL ?? "ola@example.no";
const NAME = process.env.SEED_NAME ?? "Ola Nordmann";

async function main(): Promise<void> {
  const cfg = config();
  const db = getDb();
  const profile = getProfile(cfg.DEFAULT_PROFILE);

  const [existing] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);

  const user =
    existing ??
    (
      await db
        .insert(users)
        .values({
          email: EMAIL,
          name: NAME,
          profile: profile.key,
          inboundSlug: generateInboundSlug(NAME),
          vatRegistered: true,
          baseCurrency: "NOK",
        })
        .returning()
    )[0];

  if (!user) throw new Error("Klarte ikke å opprette bruker");

  const [channel] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.userId, user.id), eq(ingestionChannels.type, "email_forward")))
    .limit(1);

  if (!channel) {
    await db.insert(ingestionChannels).values({
      userId: user.id,
      type: "email_forward",
      name: "Videresendingsadresse",
      // Selv en konfig uten hemmeligheter går gjennom encryptJson. Da finnes
      // det bare én lesevei for kanalkonfig, og ingen fristelse til å lagre
      // den neste kanalens passord i klartekst «bare denne ene gangen».
      configEncrypted: encryptJson({ slug: user.inboundSlug, allowedSenders: [] }),
      configMeta: { address: inboundAddress(user.inboundSlug) },
      status: "active",
    });
  }

  const seeded = await seedProfileRules(db, user.id, profile);

  console.log("");
  console.log("  Bruker:      ", user.name, `<${user.email}>`);
  console.log("  Profil:      ", `${profile.label} (${profile.key})`);
  console.log("  Bilagsadresse:", inboundAddress(user.inboundSlug));
  console.log("  Kanal:       ", channel ? "fantes fra før" : "opprettet");
  console.log("  Regler:      ", seeded === 0 ? "fantes fra før" : `${seeded} lagt inn fra profilen`);
  console.log("");
  console.log("  Send et testbilag:  pnpm demo:email");
  console.log("");
}

/**
 * Leverandørhintene i profilen legges inn som rader i `category_rules`.
 *
 * Hvorfor duplisere det som allerede står i koden: reglene i databasen er de
 * brukeren kan se, skru av og endre. Profilen i koden er startpunktet, ikke
 * fasiten. Prioritet 100 gjør at alt brukeren lærer systemet senere
 * (prioritet 10) vinner over dette.
 *
 * Hintet blir til ÉN regel per retning det er definert for. Beatport får
 * dermed to rader - én for kjøp og én for utbetaling - og ingen av dem sier
 * noe om hvilken retning et gitt bilag har. Det avgjør dokumentet.
 */
async function seedProfileRules(
  db: ReturnType<typeof getDb>,
  userId: string,
  profile: IndustryProfile,
): Promise<number> {
  const existing = await db
    .select({ matchValue: categoryRules.matchValue, direction: categoryRules.direction })
    .from(categoryRules)
    .where(and(eq(categoryRules.userId, userId), eq(categoryRules.origin, "profile")));
  const seen = new Set(existing.map((r) => `${r.matchValue}|${r.direction}`));

  const rows = [];
  for (const hint of profile.vendors) {
    for (const direction of ["expense", "income"] as const) {
      const key = direction === "expense" ? hint.expenseCategory : hint.incomeCategory;
      if (!key) continue;
      if (seen.has(`${hint.match}|${direction}`)) continue;
      const category = categoryByKey(profile, key);
      rows.push({
        userId,
        priority: 100,
        matchType: hint.matchType,
        matchValue: hint.match,
        direction,
        setCategory: key,
        setAccountCode: category?.accountCode ?? null,
        setVatCode: category?.defaultVatCode ?? null,
        origin: "profile" as const,
      });
    }
  }

  if (rows.length === 0) return 0;
  await db.insert(categoryRules).values(rows);
  return rows.length;
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("Seeding feilet:", err);
    process.exit(1);
  });
