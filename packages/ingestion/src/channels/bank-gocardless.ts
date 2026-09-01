/**
 * KANAL 3 - Bank via PSD2 (GoCardless Bank Account Data, tidligere Nordigen).
 *
 * Banken er den eneste kilden som er FULLSTENDIG. Et bilag kan mangle, men
 * pengene har alltid beveget seg. Derfor er denne kanalen fasit på hva som er
 * betalt og når - og alt den produserer som ikke har en kvittering, havner
 * synlig i «krever handling» i stedet for å bli glemt.
 *
 * Ingen SDK: hele API-et er fem REST-kall, og `fetch` finnes i Node 20.
 * En avhengighet til er en avhengighet som kan brekke.
 *
 * SAMTYKKET VARER 90 DAGER. Når det går ut, svarer API-et 401/403, og vi
 * kaster ChannelAuthError slik at UI-et ber brukeren godkjenne på nytt i
 * stedet for at jobbkøen prøver igjen i evighet.
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
  type TransactionItem,
} from "../types.js";

export const bankConfigSchema = z.object({
  secretId: z.string().min(1),
  secretKey: z.string().min(1),
  baseUrl: z.string().default("https://bankaccountdata.gocardless.com/api/v2"),
  /** Fylles ut når brukeren har fullført godkjenningen hos banken. */
  requisitionId: z.string().nullable().default(null),
  accountIds: z.array(z.string()).default([]),
  institutionId: z.string().nullable().default(null),
  /** Hvor langt tilbake første synk henter. PSD2 gir normalt maks 90 dager. */
  backfillDays: z.number().int().positive().default(90),
});

export type BankConfig = z.infer<typeof bankConfigSchema>;

interface BankCursor extends Cursor {
  lastBookingDate: string | null;
}

export class BankGoCardlessChannel implements IngestionChannel<BankConfig, never> {
  readonly type = "bank" as const;
  readonly label = "Bankkonto (PSD2)";
  readonly capabilities = {
    push: false,
    pull: true,
    backfill: true,
    producesDocuments: false,
    producesTransactions: true,
    requiresCredentials: true,
    fragile: false,
  };
  readonly configSchema = bankConfigSchema;

  /**
   * Oppsettet er to-trinns og kan ikke være annet.
   *
   * Første kall lager en requisition og returnerer en lenke brukeren MÅ åpne
   * for å logge inn i nettbanken sin. Derfor `pending: true` - kanalen er ikke
   * ferdig satt opp før brukeren har vært innom banken.
   */
  async setup(input: { userId: string; params: Record<string, unknown> }): Promise<SetupResult> {
    const config = bankConfigSchema.parse(input.params);
    const institutionId = String(input.params.institutionId ?? config.institutionId ?? "");
    const redirect = String(input.params.redirect ?? `${process.env.APP_URL ?? "http://localhost:3000"}/kanaler`);

    if (!institutionId) {
      // Trinn 0: brukeren har ikke valgt bank ennå. Gi dem lista.
      const institutions = await listInstitutions(config);
      return {
        config,
        meta: { institutions },
        instructions: [
          {
            title: "Velg banken din",
            body: `Vi fant ${institutions.length} norske banker. Velg din, så sender vi deg videre til nettbanken for godkjenning.`,
          },
        ],
        pending: true,
      };
    }

    const agreement = await api<{ id: string }>(config, "POST", "/agreements/enduser/", {
      institution_id: institutionId,
      // 90 dager er maks under PSD2. Etter det må brukeren godkjenne på nytt.
      max_historical_days: Math.min(config.backfillDays, 90),
      access_valid_for_days: 90,
      access_scope: ["balances", "details", "transactions"],
    });

    const requisition = await api<{ id: string; link: string }>(config, "POST", "/requisitions/", {
      redirect,
      institution_id: institutionId,
      agreement: agreement.id,
      user_language: "NO",
    });

    return {
      config: { ...config, institutionId, requisitionId: requisition.id },
      meta: { institutionId, requisitionId: requisition.id },
      instructions: [
        {
          title: "Godkjenn i nettbanken",
          body: "Du sendes til banken din for å godkjenne at vi får lese transaksjonene. Vi får kun LESETILGANG - vi kan ikke flytte penger.",
          actionUrl: requisition.link,
        },
        {
          title: "Godkjenningen varer i 90 dager",
          body: "PSD2 setter grensen, ikke vi. Når den går ut sier systemet fra, og du godkjenner på nytt med to klikk.",
        },
      ],
      pending: true,
    };
  }

  async healthCheck(ctx: ChannelContext<BankConfig>): Promise<ChannelHealth> {
    if (!ctx.config.requisitionId) {
      return {
        ok: false,
        message: "Banken er ikke godkjent ennå",
        needsUserAction: true,
        checkedAt: new Date(),
      };
    }
    try {
      const req = await api<{ status: string; accounts: string[] }>(
        ctx.config,
        "GET",
        `/requisitions/${ctx.config.requisitionId}/`,
      );
      // LN = "linked". Alt annet betyr at brukeren ikke er ferdig, eller at
      // samtykket er utløpt eller trukket tilbake.
      const linked = req.status === "LN";
      return {
        ok: linked,
        message: linked ? `${req.accounts.length} konto(er) tilkoblet` : `Status fra banken: ${req.status}`,
        needsUserAction: !linked,
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

  async *pull(
    ctx: ChannelContext<BankConfig>,
    options?: { since?: Date; full?: boolean },
  ): AsyncIterable<IngestionItem> {
    if (!ctx.config.requisitionId) {
      throw new ChannelAuthError("Banken er ikke godkjent ennå - fullfør oppsettet først");
    }

    const cursor = readCursor(ctx.cursor);
    const accountIds =
      ctx.config.accountIds.length > 0 ? ctx.config.accountIds : await accountsFor(ctx.config);

    const from = options?.full
      ? daysAgo(ctx.config.backfillDays)
      : (options?.since?.toISOString().slice(0, 10) ??
        // Ett døgn overlapp: banken etterjusterer bokføringsdatoer, og
        // dedupen tåler at vi ser den samme transaksjonen to ganger.
        (cursor.lastBookingDate ? shiftDate(cursor.lastBookingDate, -1) : daysAgo(ctx.config.backfillDays)));

    for (const accountId of accountIds) {
      if (ctx.signal.aborted) return;

      const response = await api<{
        transactions: { booked: RawTransaction[]; pending?: RawTransaction[] };
      }>(ctx.config, "GET", `/accounts/${accountId}/transactions/?date_from=${from}`);

      ctx.logger.info("Hentet transaksjoner", {
        accountId,
        from,
        booked: response.transactions.booked.length,
      });

      // Kun `booked`. Reserverte beløp endrer seg og forsvinner - de er ikke
      // et bilag før de faktisk er bokført.
      for (const tx of response.transactions.booked) {
        yield toTransactionItem(tx, accountId);
      }
    }
  }

  nextCursor(items: IngestionItem[], previous: Cursor | null): Cursor {
    const prev = readCursor(previous);
    let latest = prev.lastBookingDate;
    for (const item of items) {
      if (item.kind !== "transaction") continue;
      if (!latest || item.bookingDate > latest) latest = item.bookingDate;
    }
    return { lastBookingDate: latest };
  }
}

export const bankGoCardlessChannel = new BankGoCardlessChannel();

/* ------------------------------------------------------------ API-laget -- */

interface RawTransaction {
  transactionId?: string;
  internalTransactionId?: string;
  bookingDate?: string;
  valueDate?: string;
  transactionAmount: { amount: string; currency: string };
  creditorName?: string;
  debtorName?: string;
  creditorAccount?: { iban?: string };
  debtorAccount?: { iban?: string };
  remittanceInformationUnstructured?: string;
  remittanceInformationUnstructuredArray?: string[];
  additionalInformation?: string;
}

/**
 * Tokenet varer 24 timer og caches per secretId i prosessen. Å be om et nytt
 * for hvert kall ville både vært tregt og telt mot rate limiten.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(config: BankConfig): Promise<string> {
  const cached = tokenCache.get(config.secretId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`${config.baseUrl}/token/new/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ secret_id: config.secretId, secret_key: config.secretKey }),
  });

  if (res.status === 401 || res.status === 400) {
    throw new ChannelAuthError("GoCardless avviste nøklene. Sjekk SECRET_ID og SECRET_KEY.");
  }
  if (!res.ok) throw new ChannelTemporaryError(`Token-kall feilet (${res.status})`, 120);

  const body = (await res.json()) as { access: string; access_expires: number };
  tokenCache.set(config.secretId, {
    token: body.access,
    expiresAt: Date.now() + body.access_expires * 1000,
  });
  return body.access;
}

async function api<T>(config: BankConfig, method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken(config);
  const res = await fetch(`${config.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 401 || res.status === 403) {
    // Samtykket er utløpt eller trukket tilbake. Retry hjelper ikke -
    // brukeren må inn i nettbanken igjen.
    tokenCache.delete(config.secretId);
    throw new ChannelAuthError("Bankens godkjenning er utløpt eller trukket tilbake. Godkjenn på nytt.");
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "3600");
    throw new ChannelTemporaryError("Rate limit mot GoCardless", retryAfter);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChannelTemporaryError(`GoCardless ${method} ${path} svarte ${res.status}: ${text.slice(0, 200)}`, 300);
  }

  return (await res.json()) as T;
}

async function listInstitutions(config: BankConfig): Promise<Array<{ id: string; name: string; logo?: string }>> {
  return api<Array<{ id: string; name: string; logo?: string }>>(config, "GET", "/institutions/?country=no");
}

async function accountsFor(config: BankConfig): Promise<string[]> {
  const req = await api<{ accounts: string[] }>(config, "GET", `/requisitions/${config.requisitionId}/`);
  return req.accounts;
}

/**
 * Rå transaksjon -> TransactionItem.
 *
 * FORTEGNET BEHOLDES. Banken sier minus for utgående, og det er den eneste
 * pålitelige kilden til retning vi har her - motpartsnavnet sier ingenting.
 * Beløpet konverteres til minste enhet (øre) her, ikke lenger ned i systemet.
 */
function toTransactionItem(tx: RawTransaction, accountId: string): TransactionItem {
  const currency = tx.transactionAmount.currency.toUpperCase();
  const amount = toMinorUnits(tx.transactionAmount.amount, currency);
  const incoming = amount >= 0;

  const remittance =
    tx.remittanceInformationUnstructured ??
    tx.remittanceInformationUnstructuredArray?.join(" ") ??
    tx.additionalInformation ??
    null;

  return {
    kind: "transaction",
    // Uten en stabil id kan vi ikke synke inkrementelt. Faller banken tilbake
    // på ingenting, lager vi en deterministisk id av innholdet - da blir i det
    // minste den samme transaksjonen den samme raden ved neste synk.
    externalId:
      tx.transactionId ??
      tx.internalTransactionId ??
      `${tx.bookingDate ?? "?"}|${tx.transactionAmount.amount}|${(remittance ?? "").slice(0, 40)}`,
    accountId,
    bookingDate: tx.bookingDate ?? tx.valueDate ?? new Date().toISOString().slice(0, 10),
    valueDate: tx.valueDate ?? null,
    amount,
    currency,
    // Motparten er den ANDRE parten: får vi penger, er det debitor som betalte.
    counterpartyName: (incoming ? tx.debtorName : tx.creditorName) ?? null,
    counterpartyAccount: (incoming ? tx.debtorAccount?.iban : tx.creditorAccount?.iban) ?? null,
    remittanceInfo: remittance,
    rawPayload: tx as unknown as Record<string, unknown>,
  };
}

/**
 * "-1234.56" -> -123456.
 *
 * Vi går via streng og ikke via parseFloat på hele beløpet: 0.1 + 0.2 er ikke
 * 0.3 i flyttall, og et regnskap tåler ikke den slags. Se @qbikk/core/money
 * for den samme regelen.
 */
export function toMinorUnits(amount: string, currency: string): number {
  const zeroDecimal = new Set(["JPY", "KRW", "ISK", "CLP", "VND"]);
  const decimals = zeroDecimal.has(currency) ? 0 : 2;
  const negative = amount.trim().startsWith("-");
  const [whole = "0", fraction = ""] = amount.trim().replace(/^[+-]/, "").split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const value = Number(whole) * 10 ** decimals + (decimals > 0 ? Number(padded || "0") : 0);
  return negative ? -value : value;
}

function readCursor(cursor: Cursor | null): BankCursor {
  const value = cursor?.lastBookingDate;
  return { lastBookingDate: typeof value === "string" ? value : null };
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
