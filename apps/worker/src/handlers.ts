/**
 * Jobbhandlerne.
 *
 * Hver handler er tynn med vilje: den slår opp det den trenger og kaller en
 * pipeline-funksjon i @qbikk/core. Ingen forretningsregler her. Skulle en
 * regel snike seg inn i en handler, ville MCP-serveren og web-UI-et hatt en
 * annen oppførsel enn workeren - og da er det ikke lenger ett system.
 */
import { eq, getDb, rawDocuments, vouchers, and, isNull, desc } from "@qbikk/db";
import {
  getBlobStore,
  loadUserContext,
  proposeMatches,
  runExtraction,
  storeRawDocument,
  upsertVoucher,
} from "@qbikk/core";
import { getRate } from "@qbikk/core/fx";
import { getExtractor } from "@qbikk/extraction";
import { JOBS, sendJob, sendUnique, workJob, type PgBoss } from "@qbikk/jobs";
import { runChannelSync, scheduleChannelSyncs } from "./sync.js";

export async function registerHandlers(boss: PgBoss): Promise<void> {
  /**
   * Et rådokument er lagret og skal behandles.
   *
   * Handleren gjør bevisst lite: den sender dokumentet videre til ekstraksjon.
   * Den finnes likevel, fordi den er stedet nye pre-steg hører hjemme
   * (virussjekk, størrelsesgrense, klassifisering) uten at kanalene må vite
   * om dem.
   */
  await workJob(boss, JOBS.ingestDocument, async ({ userId, rawDocumentId }) => {
    const db = getDb();
    const [doc] = await db
      .select({ id: rawDocuments.id })
      .from(rawDocuments)
      .where(and(eq(rawDocuments.id, rawDocumentId), eq(rawDocuments.userId, userId)))
      .limit(1);
    if (!doc) throw new Error(`Ukjent rådokument: ${rawDocumentId}`);

    await sendJob(boss, JOBS.extractDocument, { userId, rawDocumentId });
  });

  /**
   * Tolk dokumentet og lag bilaget.
   *
   * Hele veien fra rådokument til bilag ligger her, fordi de tre stegene alltid
   * hører sammen: en ekstraksjon uten et bilag er ingenting verdt, og et bilag
   * uten et matchforsøk blir liggende i «krever handling» uten grunn.
   */
  await workJob(boss, JOBS.extractDocument, async ({ userId, rawDocumentId, force }) => {
    const db = getDb();

    const extraction = await runExtraction(db, getExtractor(), { userId, rawDocumentId, force });

    const [raw] = await db
      .select()
      .from(rawDocuments)
      .where(and(eq(rawDocuments.id, rawDocumentId), eq(rawDocuments.userId, userId)))
      .limit(1);
    if (!raw) throw new Error(`Rådokumentet forsvant: ${rawDocumentId}`);

    // Dokumenter modellen selv sier ikke er bilag, lages det ikke bilag av.
    // Rådokumentet og ekstraksjonen blir stående, så en feilvurdering kan
    // omgjøres ved å kjøre om - ingenting er tapt.
    if (extraction.document.documentType === "not_a_voucher") {
      console.log(`[info] [extract] hoppet over - ikke et bilag (${rawDocumentId})`);
      return;
    }

    const { profile, rules } = await loadUserContext(db, userId);
    const result = await upsertVoucher(db, {
      userId,
      profile,
      rules,
      extractionId: extraction.extractionId,
      document: extraction.document,
      rawDocument: raw,
    });

    // Kursen for en fremmed valuta varmes i cachen slik at neste bilag samme
    // dag slipper nettverkskallet. singletonKey hindrer at fem bilag utløser
    // fem identiske kall.
    const currency = extraction.document.currency;
    if (currency && currency !== "NOK" && extraction.document.issueDate) {
      await sendUnique(
        boss,
        JOBS.fetchFxRate,
        { currency, date: extraction.document.issueDate },
        `${currency}:${extraction.document.issueDate}`,
        3600,
      );
    }

    if (!result.isDuplicate) {
      await sendJob(boss, JOBS.matchVouchers, { userId, voucherId: result.voucherId });
    }
  });

  /** Robuste kanaler. */
  await workJob(boss, JOBS.syncChannel, async (payload) => {
    await runChannelSync(boss, payload);
  });

  /**
   * Skjøre kanaler - samme handler, egen kø.
   *
   * `batchSize: 1` sammen med `policy: singleton` på køen betyr at det aldri
   * kjører mer enn én browserøkt om gangen.
   */
  await workJob(
    boss,
    JOBS.syncChannelFragile,
    async (payload) => {
      await runChannelSync(boss, payload);
    },
    { batchSize: 1 },
  );

  /**
   * Match bank mot dokument.
   *
   * Uten voucherId går vi gjennom alt som fortsatt mangler dokumentasjon.
   * Det er den jobben som rydder opp etter en backfill der bankbilagene kom
   * inn før kvitteringene.
   */
  await workJob(boss, JOBS.matchVouchers, async ({ userId, voucherId }) => {
    const db = getDb();

    if (voucherId) {
      await proposeMatches(db, { userId, voucherId });
      return;
    }

    const pending = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.userId, userId),
          eq(vouchers.needsDocumentation, true),
          isNull(vouchers.supersedesVoucherId),
        ),
      )
      .orderBy(desc(vouchers.date))
      .limit(500);

    for (const row of pending) {
      // Én match som feiler skal ikke stoppe de andre.
      await proposeMatches(db, { userId, voucherId: row.id }).catch((err: unknown) => {
        console.error(`[error] [match] bilag ${row.id}:`, err instanceof Error ? err.message : err);
      });
    }
  });

  /** Varmer kurscachen. Feiler den, får bilaget kursen ved neste forsøk. */
  await workJob(boss, JOBS.fetchFxRate, async ({ currency, date }) => {
    await getRate(currency, date);
  });

  /** Cron-fordeleren. Se JOBS.scheduleSyncs. */
  await workJob(boss, JOBS.scheduleSyncs, async ({ userId }) => {
    const sent = await scheduleChannelSyncs(boss, userId);
    console.log(`[info] [schedule] sendte ${sent} synkjobb(er)`);
  });

  /**
   * Dead letter: jobber som har brukt opp alle forsøk.
   *
   * Vi logger dem høylytt i stedet for å la dem ligge stille. En jobb som
   * feilet fire ganger er noe brukeren eller utvikleren må vite om.
   */
  await workJob(boss, JOBS.deadLetter, async (data, job) => {
    console.error(`[error] [dead-letter] jobb ${job.id} ga opp:`, JSON.stringify(data));
  });
}

/**
 * Brukes av web-ruter og MCP for å legge et allerede mottatt dokument inn i
 * systemet uten å duplisere lagringslogikken.
 */
export { storeRawDocument, getBlobStore };
