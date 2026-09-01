/**
 * KANAL 5 - Browserautomatisering. BYGG DENNE SIST, OG BRUK DEN MINST.
 *
 * Noen leverandører har hverken API, e-postkvittering eller eksport. Da er
 * eneste vei å logge inn i portalen og laste ned PDF-en. Det virker, og det er
 * skjørt på en måte de andre kanalene ikke er.
 *
 * RISIKOENE, EKSPLISITT - de står her fordi de må stå et sted koden tvinger
 * deg til å lese:
 *
 *  1. LAGRING AV INNLOGGING. Vi lagrer ALDRI passord. Kanalen tar imot
 *     sesjonscookies fra en innlogging brukeren gjorde selv, de krypteres med
 *     encryptJson() av kalleren, og de har utløpstid. Se `sessionSchema`.
 *  2. MFA. Kan ikke automatiseres forsvarlig, og skal ikke forsøkes. Designet
 *     er at brukeren logger inn interaktivt ÉN gang og at vi gjenbruker
 *     sesjonen til den utløper - så ber vi om en ny.
 *  3. BRUDD PÅ VILKÅR. Mange portaler forbyr automatisert innlogging.
 *     `consentedAt` er påkrevd i konfigurasjonen: uten et aktivt samtykke per
 *     portal nekter kanalen å kjøre. UI-et må si dette rett ut.
 *  4. MINIMERING. Kjør bare når de andre kanalene ikke dekker leverandøren,
 *     kjør sjelden (`minHoursBetweenRuns`), hent kun dokumenter, og logg hvert
 *     eneste kall.
 *
 * `fragile: true` gjør at orkestratoren gir kanalen egen kø og mildere
 * retry-policy. Den skal aldri kunne blokkere bank- eller e-postsynken.
 *
 * SELVE BROWSEREN LIGGER IKKE HER. Kanalen definerer et `PortalDriver`-
 * grensesnitt og ingenting annet. Driveren kjører i sin egen prosess - en
 * MCP-server med browserverktøy passer godt, nettopp fordi den da er isolert
 * på samme måte som kanalen er det.
 */
import { z } from "zod";
import {
  ChannelAuthError,
  ChannelTemporaryError,
  type ChannelContext,
  type ChannelHealth,
  type Cursor,
  type IngestionChannel,
  type IngestionItem,
  type SetupResult,
} from "../types.js";

/** Én cookie fra en innlogging brukeren gjorde selv. Aldri et passord. */
const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().default("/"),
  expires: z.number().nullable().default(null),
  httpOnly: z.boolean().default(true),
  secure: z.boolean().default(true),
});

export const browserConfigSchema = z.object({
  /** Hvilken portal. Identifiserer driveren, ikke en URL vi navigerer fritt til. */
  portal: z.string().min(1),
  loginUrl: z.string().url(),
  /**
   * Sesjonen fra brukerens egen innlogging. Krypteres av kalleren.
   * Ingen `password`-felt her, og det skal aldri legges til et.
   */
  session: z
    .object({
      cookies: z.array(cookieSchema).default([]),
      /** ISO-tidspunkt. Etter dette må brukeren logge inn på nytt. */
      expiresAt: z.string().nullable().default(null),
    })
    .default({ cookies: [], expiresAt: null }),
  /**
   * Når brukeren aktivt godtok at vi automatiserer akkurat denne portalen.
   * Null = ikke godtatt = kanalen kjører ikke. Dette er en bryter, ikke en
   * kommentar.
   */
  consentedAt: z.string().nullable().default(null),
  /** Minimering: hvor sjelden vi tillater oss å kjøre. */
  minHoursBetweenRuns: z.number().int().positive().default(24),
  maxDocumentsPerRun: z.number().int().positive().max(100).default(20),
});

export type BrowserConfig = z.infer<typeof browserConfigSchema>;

interface BrowserCursor extends Cursor {
  lastRunAt: string | null;
  lastDocumentRef: string | null;
}

/** Ett dokument driveren fant i portalen. */
export interface PortalDocument {
  /** Portalens egen id for dokumentet - fakturanummer eller URL-fragment. */
  ref: string;
  filename: string;
  mime: string;
  data: Buffer;
  issuedAt: Date | null;
}

/**
 * Det en portaldriver må kunne, og ikke noe mer.
 *
 * Merk hva som IKKE er her: ingen `login(username, password)`, ingen
 * `navigate(url)`, ingen `click(selector)`. Driveren får en ferdig sesjon og
 * skal hente dokumenter. Et bredere grensesnitt ville invitert til bredere
 * bruk, og bredere bruk er nettopp det risikolista over advarer mot.
 */
export interface PortalDriver {
  readonly portal: string;
  /** Er sesjonen fortsatt gyldig? Kastes ChannelAuthError hvis ikke. */
  verifySession(config: BrowserConfig, signal: AbortSignal): Promise<boolean>;
  /** Hent dokumenter nyere enn `since`. Skal aldri hente mer enn `limit`. */
  fetchDocuments(
    config: BrowserConfig,
    options: { since: Date | null; limit: number; signal: AbortSignal },
  ): Promise<PortalDocument[]>;
}

const drivers = new Map<string, PortalDriver>();

/** Registrer en driver. Uten en registrert driver gjør kanalen ingenting. */
export function registerPortalDriver(driver: PortalDriver): void {
  drivers.set(driver.portal, driver);
}

export function listPortalDrivers(): string[] {
  return [...drivers.keys()];
}

export class BrowserChannel implements IngestionChannel<BrowserConfig, never> {
  readonly type = "browser" as const;
  readonly label = "Portalinnlogging (skjør)";
  readonly capabilities = {
    push: false,
    pull: true,
    backfill: true,
    producesDocuments: true,
    producesTransactions: false,
    requiresCredentials: true,
    /** Se filhodet. Dette flagget er grunnen til at kanalen har egen jobbkø. */
    fragile: true,
  };
  readonly configSchema = browserConfigSchema;

  async setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult> {
    const config = browserConfigSchema.parse(input.params);

    return {
      config,
      // Cookies er hemmeligheter. Bare portalnavnet er trygt å vise.
      meta: { portal: config.portal, consented: config.consentedAt !== null },
      instructions: [
        {
          title: "Bruk dette bare når ingenting annet virker",
          body: "Videresending, innbokssøk og bank dekker de aller fleste leverandører, og de er robuste. Portalinnlogging er siste utvei.",
        },
        {
          title: "Mange portaler forbyr dette i vilkårene sine",
          body: `Les vilkårene til ${config.portal} før du slår på dette. Du må godta per portal, og du kan skru det av når som helst.`,
          actionUrl: config.loginUrl,
        },
        {
          title: "Du logger inn selv - vi lagrer aldri passordet ditt",
          body: "Du logger inn i et vindu vi åpner, inkludert eventuell tofaktor. Vi tar vare på sesjonen din, kryptert, til den utløper - og ber deg logge inn igjen når den gjør det.",
        },
        {
          title: "Vi henter bare dokumenter",
          body: `Maks ${config.maxDocumentsPerRun} dokumenter, maks én kjøring hver ${config.minHoursBetweenRuns}. time. Hvert kall logges.`,
        },
      ],
      // Ikke ferdig før brukeren har logget inn og samtykket.
      pending: config.consentedAt === null || config.session.cookies.length === 0,
    };
  }

  async healthCheck(ctx: ChannelContext<BrowserConfig>): Promise<ChannelHealth> {
    const blocked = this.blockedReason(ctx.config);
    if (blocked) {
      return { ok: false, message: blocked, needsUserAction: true, checkedAt: new Date() };
    }

    const driver = drivers.get(ctx.config.portal);
    if (!driver) {
      return {
        ok: false,
        message: `Ingen driver registrert for «${ctx.config.portal}»`,
        needsUserAction: false,
        checkedAt: new Date(),
      };
    }

    try {
      const valid = await driver.verifySession(ctx.config, ctx.signal);
      return {
        ok: valid,
        message: valid ? "Sesjonen er gyldig" : "Sesjonen er utløpt - logg inn på nytt",
        needsUserAction: !valid,
        checkedAt: new Date(),
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        needsUserAction: err instanceof ChannelAuthError,
        checkedAt: new Date(),
      };
    }
  }

  /**
   * Grunnen til at kanalen ikke får kjøre, eller null hvis den får.
   *
   * Rekkefølgen er bevisst: samtykke først. Har brukeren ikke sagt ja til
   * denne portalen, er det uinteressant om sesjonen er gyldig.
   */
  private blockedReason(config: BrowserConfig): string | null {
    if (!config.consentedAt) {
      return `Du har ikke godtatt automatisk innlogging for ${config.portal}. Kanalen kjører ikke før du gjør det.`;
    }
    if (config.session.cookies.length === 0) {
      return "Ingen lagret sesjon. Logg inn i portalen én gang for å komme i gang.";
    }
    if (config.session.expiresAt && new Date(config.session.expiresAt) <= new Date()) {
      return "Sesjonen er utløpt. Logg inn på nytt.";
    }
    return null;
  }

  async *pull(
    ctx: ChannelContext<BrowserConfig>,
    options?: { since?: Date; full?: boolean },
  ): AsyncIterable<IngestionItem> {
    const blocked = this.blockedReason(ctx.config);
    // ChannelAuthError, ikke TemporaryError: dette fikser seg ikke av retry,
    // det fikser seg av at brukeren gjør noe.
    if (blocked) throw new ChannelAuthError(blocked);

    const driver = drivers.get(ctx.config.portal);
    if (!driver) {
      throw new ChannelTemporaryError(
        `Ingen portaldriver for «${ctx.config.portal}». Registrer en med registerPortalDriver().`,
      );
    }

    const cursor = readCursor(ctx.cursor);

    // Minimering, håndhevet: for hyppige kjøringer er både unødvendig og
    // nettopp det som får en portal til å blokkere kontoen.
    if (!options?.full && cursor.lastRunAt) {
      const hoursSince = (Date.now() - new Date(cursor.lastRunAt).getTime()) / 3_600_000;
      if (hoursSince < ctx.config.minHoursBetweenRuns) {
        ctx.logger.info("Hopper over kjøring - for kort tid siden sist", {
          portal: ctx.config.portal,
          hoursSince: Math.round(hoursSince),
        });
        return;
      }
    }

    ctx.logger.warn("Starter browserkjøring", {
      portal: ctx.config.portal,
      consentedAt: ctx.config.consentedAt,
      limit: ctx.config.maxDocumentsPerRun,
    });

    const since = options?.full ? null : (options?.since ?? null);
    const documents = await driver.fetchDocuments(ctx.config, {
      since,
      limit: ctx.config.maxDocumentsPerRun,
      signal: ctx.signal,
    });

    for (const doc of documents.slice(0, ctx.config.maxDocumentsPerRun)) {
      if (ctx.signal.aborted) return;

      // Hvert dokument logges. Er det tvil om hva kanalen har gjort, skal
      // loggen kunne svare på det.
      ctx.logger.info("Hentet dokument fra portal", {
        portal: ctx.config.portal,
        ref: doc.ref,
        bytes: doc.data.byteLength,
      });

      yield {
        kind: "document",
        externalRef: `${ctx.config.portal}:${doc.ref}`,
        receivedAt: doc.issuedAt ?? new Date(),
        subject: doc.filename,
        sender: ctx.config.portal,
        recipient: null,
        text: null,
        html: null,
        raw: doc.data,
        rawMime: doc.mime,
        attachments: [{ filename: doc.filename, mime: doc.mime, data: doc.data, inline: false }],
        rawPayload: { portal: ctx.config.portal, ref: doc.ref },
      };
    }
  }

  nextCursor(items: IngestionItem[], previous: Cursor | null): Cursor {
    const prev = readCursor(previous);
    let lastRef = prev.lastDocumentRef;
    for (const item of items) {
      if (item.kind === "document" && item.externalRef) lastRef = item.externalRef;
    }
    // lastRunAt settes uansett om vi fant noe: den styrer minimeringen, og en
    // tom kjøring er også en kjøring portalen har sett.
    return { lastRunAt: new Date().toISOString(), lastDocumentRef: lastRef };
  }

  /** Sletter sesjonen. Kalles når brukeren skrur av kanalen. */
  async teardown(ctx: ChannelContext<BrowserConfig>): Promise<void> {
    ctx.logger.info("Nullstiller portalsesjon", { portal: ctx.config.portal });
    ctx.config.session.cookies.length = 0;
    ctx.config.session.expiresAt = null;
  }
}

export const browserChannel = new BrowserChannel();

function readCursor(cursor: Cursor | null): BrowserCursor {
  const lastRunAt = cursor?.lastRunAt;
  const lastDocumentRef = cursor?.lastDocumentRef;
  return {
    lastRunAt: typeof lastRunAt === "string" ? lastRunAt : null,
    lastDocumentRef: typeof lastDocumentRef === "string" ? lastDocumentRef : null,
  };
}
