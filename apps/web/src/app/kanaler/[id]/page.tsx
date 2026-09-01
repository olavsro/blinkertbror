/**
 * Detaljer om én kilde: status, siste henting, og det som gjenstår.
 *
 * Det er her banken fullfører oppsettet sitt. `setup()` er to-trinns fordi den
 * MÅ være det - brukeren må innom sin egen nettbank for å godkjenne, og det
 * kan ingen gjøre for dem.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, getDb, ingestionChannels, syncRuns } from "@qbikk/db";
import { decryptJson } from "@qbikk/core/crypto";
import { getChannel } from "@qbikk/ingestion";
import { checkChannelHealth, syncChannelNow, toggleChannel } from "@/lib/actions";
import { connectBankInstitution, removeChannel } from "@/lib/channel-actions";
import { currentUser } from "@/lib/data";
import { formatDistanceish } from "@/lib/format";

export const dynamic = "force-dynamic";

interface Institution {
  id: string;
  name: string;
  logo?: string;
}

export default async function ChannelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker.</p>;

  const { id } = await params;
  const db = getDb();

  const [row] = await db
    .select()
    .from(ingestionChannels)
    .where(and(eq(ingestionChannels.id, id), eq(ingestionChannels.userId, user.id)))
    .limit(1);
  if (!row) notFound();

  const channel = getChannel(row.type as Exclude<typeof row.type, "manual">);
  const meta = row.configMeta;
  const runs = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.channelId, row.id))
    .orderBy(desc(syncRuns.startedAt))
    .limit(5);

  // Banken lagrer listen over banker i meta ved trinn 1, og en godkjenningslenke
  // ved trinn 2. Hvilken av dem som finnes forteller oss hvor brukeren er.
  const institutions = Array.isArray(meta.institutions) ? (meta.institutions as Institution[]) : null;
  const requisitionId = typeof meta.requisitionId === "string" ? meta.requisitionId : null;
  const bankLink = await bankApprovalLink(row.configEncrypted, requisitionId);

  return (
    <>
      <p className="small muted">
        <Link href="/kanaler">← Alle kilder</Link>
      </p>
      <h1>{row.name}</h1>
      <p className="lede">
        {channel.label} ·{" "}
        <span className={`pill ${row.status === "active" ? "matched" : "needs_review"}`}>
          {STATUS_LABELS[row.status] ?? row.status}
        </span>
      </p>

      {/* ------------------------------------------------ banken, trinn 2 */}
      {row.type === "bank" && !requisitionId && institutions ? (
        <div className="panel">
          <strong>Velg banken din</strong>
          <p className="small muted" style={{ marginTop: 4 }}>
            Vi fant {institutions.length} banker i Norge. Etter at du velger, sender vi deg til din
            egen nettbank for å godkjenne.
          </p>
          <div className="bank-grid">
            {institutions.map((bank) => (
              <form action={connectBankInstitution} key={bank.id}>
                <input type="hidden" name="channelId" value={row.id} />
                <input type="hidden" name="institutionId" value={bank.id} />
                <button type="submit" className="bank-card">
                  {bank.name}
                </button>
              </form>
            ))}
          </div>
        </div>
      ) : null}

      {row.type === "bank" && bankLink ? (
        <div className="notice">
          <strong>Ett steg igjen: godkjenn i nettbanken din</strong>
          <div style={{ margin: "6px 0 10px" }}>
            Du sendes til banken for å si ja til at vi får LESE transaksjonene. Vi kan aldri flytte
            penger. Når du er ferdig, kom tilbake hit og trykk «Sjekk tilkoblingen».
          </div>
          <a href={bankLink} target="_blank" rel="noopener noreferrer">
            <button type="button" className="primary">
              Åpne nettbanken →
            </button>
          </a>
        </div>
      ) : null}

      {/* ------------------------------------------------------ instruksjoner */}
      {row.status === "needs_auth" && row.type !== "bank" ? (
        <div className="notice">
          <strong>Venter på deg</strong>
          <div style={{ marginTop: 4 }}>{row.lastError ?? "Oppsettet er ikke fullført ennå."}</div>
        </div>
      ) : null}

      {/* --------------------------------------------------------- status */}
      <div className="cards">
        <div className="card">
          <div className="label">Sist hentet</div>
          <div className="value" style={{ fontSize: 15 }}>
            {formatDistanceish(row.lastSyncAt)}
          </div>
        </div>
        <div className="card">
          <div className="label">Feil på rad</div>
          <div className="value" style={{ fontSize: 15 }}>
            {row.consecutiveFailures}
          </div>
        </div>
        <div className="card">
          <div className="label">Henter selv</div>
          <div className="value" style={{ fontSize: 15 }}>
            {channel.capabilities.pull ? "ja, automatisk" : "nei, tar imot"}
          </div>
        </div>
      </div>

      {row.lastError ? (
        <div className="panel">
          <strong>Siste feil</strong>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            {row.lastError}
          </p>
        </div>
      ) : null}

      {/* -------------------------------------------------------- handlinger */}
      <div className="panel setup-actions">
        <form action={checkChannelHealth} className="inline">
          <input type="hidden" name="channelId" value={row.id} />
          <button type="submit" className="primary">
            Sjekk tilkoblingen
          </button>
        </form>
        {channel.capabilities.pull ? (
          <>
            <form action={syncChannelNow} className="inline">
              <input type="hidden" name="channelId" value={row.id} />
              <button type="submit">Hent nye nå</button>
            </form>
            {channel.capabilities.backfill ? (
              <form action={syncChannelNow} className="inline">
                <input type="hidden" name="channelId" value={row.id} />
                <input type="hidden" name="full" value="1" />
                <button type="submit">Hent alt gammelt</button>
              </form>
            ) : null}
          </>
        ) : null}
        <form action={toggleChannel} className="inline">
          <input type="hidden" name="channelId" value={row.id} />
          <input type="hidden" name="paused" value={row.status === "paused" ? "0" : "1"} />
          <button type="submit">{row.status === "paused" ? "Start igjen" : "Sett på pause"}</button>
        </form>
        {row.type !== "email_forward" ? (
          <form action={removeChannel} className="inline">
            <input type="hidden" name="channelId" value={row.id} />
            <button type="submit">Fjern</button>
          </form>
        ) : null}
      </div>

      {/* ------------------------------------------------------------ logg */}
      <h2>Siste hentinger</h2>
      <div className="panel" style={{ padding: 0 }}>
        {runs.length === 0 ? (
          <div className="empty">Ingen hentinger ennå.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>Når</th>
                <th style={{ width: 100 }}>Resultat</th>
                <th className="num">Sett</th>
                <th className="num">Nye</th>
                <th className="num">Fantes</th>
                <th>Feil</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="small">{formatDistanceish(run.startedAt)}</td>
                  <td className="small">{RUN_LABELS[run.status] ?? run.status}</td>
                  <td className="num">{run.itemsSeen}</td>
                  <td className="num">{run.itemsNew}</td>
                  <td className="num">{run.itemsDuplicate}</td>
                  <td className="small muted">{run.error ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * Godkjenningslenka fra banken.
 *
 * Den hentes ved oppslag i stedet for å lagres, fordi den utløper. En lagret
 * lenke ville sendt brukeren til en side som sier «denne er ikke gyldig
 * lenger», uten å forklare hvorfor.
 */
async function bankApprovalLink(configEncrypted: string | null, requisitionId: string | null): Promise<string | null> {
  if (!configEncrypted || !requisitionId) return null;

  try {
    const config = decryptJson<{ secretId: string; secretKey: string; baseUrl: string }>(configEncrypted);

    const tokenRes = await fetch(`${config.baseUrl}/token/new/`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ secret_id: config.secretId, secret_key: config.secretKey }),
    });
    if (!tokenRes.ok) return null;
    const { access } = (await tokenRes.json()) as { access: string };

    const reqRes = await fetch(`${config.baseUrl}/requisitions/${requisitionId}/`, {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
    });
    if (!reqRes.ok) return null;

    const requisition = (await reqRes.json()) as { link?: string; status?: string };
    // LN = linked. Da er brukeren ferdig og skal ikke se lenka igjen.
    return requisition.status === "LN" ? null : (requisition.link ?? null);
  } catch {
    // Nettverksfeil skal ikke velte hele sida - resten av statusen er
    // fortsatt verdt å vise.
    return null;
  }
}

const STATUS_LABELS: Record<string, string> = {
  active: "virker",
  paused: "på pause",
  needs_auth: "venter på deg",
  error: "feil",
};

const RUN_LABELS: Record<string, string> = {
  running: "pågår",
  success: "ok",
  partial: "delvis",
  failed: "feilet",
};
