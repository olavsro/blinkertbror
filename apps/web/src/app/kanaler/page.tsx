/**
 * Kanalstatus og oppsett.
 *
 * Siden leser registret i @qbikk/ingestion, ikke en liste den holder selv.
 * Det er det som gjør at «legg til en kanal = skriv én fil» faktisk stemmer:
 * en ny kanal dukker opp her uten at denne fila endres.
 */
import Link from "next/link";
import { formatDistanceish } from "@/lib/format";
import { inboundAddress } from "@qbikk/core/config";
import { listChannels } from "@qbikk/ingestion";
import { checkChannelHealth, reopenOnboarding, syncChannelNow, toggleChannel } from "@/lib/actions";
import { currentUser, listChannelRows } from "@/lib/data";
import { loadOnboardingStatus } from "@/lib/onboarding";
import { formFor } from "@/lib/channel-forms";

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  const rows = await listChannelRows(user.id);
  const onboarding = await loadOnboardingStatus(user);
  const available = listChannels();
  const configured = new Set(rows.map((r) => r.type));

  return (
    <>
      <h1>Kanaler</h1>
      <p className="lede">Hvor bilagene kommer fra, og om de fungerer.</p>

      <div className="panel">
        <div className="label small muted">DIN BILAGSADRESSE</div>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 17, margin: "6px 0" }}>
          {inboundAddress(user.inboundSlug)}
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Alt som sendes hit blir lest og lagt inn som bilag. Sett opp én videresendingsregel i
          e-posten din, eller oppgi adressen som fakturamottaker hos leverandørene dine.
        </p>
      </div>

      <h2>Aktive kanaler</h2>
      <div className="panel" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="empty">Ingen kanaler satt opp ennå.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kanal</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 130 }}>Sist synk</th>
                <th>Siste feil</th>
                <th style={{ width: 260 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const channel = available.find((c) => c.type === row.type);
                return (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/kanaler/${row.id}`}>{row.name}</Link>
                      <div className="small muted">
                        {channel?.label ?? row.type}
                        {channel?.capabilities.fragile ? " · skjør" : ""}
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${row.status === "active" ? "matched" : "needs_review"}`}>
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="small muted">{formatDistanceish(row.lastSyncAt)}</td>
                    <td className="small muted">
                      {row.lastError ?? "-"}
                      {row.consecutiveFailures > 0 ? (
                        <div className="small">{row.consecutiveFailures} feil på rad</div>
                      ) : null}
                    </td>
                    <td>
                      <form action={checkChannelHealth} className="inline">
                        <input type="hidden" name="channelId" value={row.id} />
                        <button type="submit">Test</button>
                      </form>{" "}
                      {channel?.capabilities.pull ? (
                        <>
                          <form action={syncChannelNow} className="inline">
                            <input type="hidden" name="channelId" value={row.id} />
                            <button type="submit">Synk nå</button>
                          </form>{" "}
                          {channel.capabilities.backfill ? (
                            <form action={syncChannelNow} className="inline">
                              <input type="hidden" name="channelId" value={row.id} />
                              <input type="hidden" name="full" value="1" />
                              <button type="submit" title="Hent alt bakover i tid">
                                Backfill
                              </button>
                            </form>
                          ) : null}{" "}
                        </>
                      ) : null}
                      <form action={toggleChannel} className="inline">
                        <input type="hidden" name="channelId" value={row.id} />
                        <input type="hidden" name="paused" value={row.status === "paused" ? "0" : "1"} />
                        <button type="submit">{row.status === "paused" ? "Start" : "Pause"}</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <strong>Har du en kvittering akkurat nå?</strong>
        <div className="small muted" style={{ margin: "4px 0 8px" }}>
          Du trenger ikke sette opp noe for å legge inn en enkelt fil eller et bilde.
        </div>
        <Link href="/last-opp">
          <button type="button">Last opp en fil</button>
        </Link>
      </div>

      {onboarding.finished ? (
        <div className="panel">
          <strong>Usikker på hvor du skal begynne?</strong>
          <div className="small muted" style={{ margin: "4px 0 8px" }}>
            Den korte innføringen tar to minutter og forklarer alt uten fagord.
          </div>
          <form action={reopenOnboarding}>
            <button type="submit">Åpne «Kom i gang» igjen</button>
          </form>
        </div>
      ) : null}

      <h2>Kan legges til</h2>
      <p className="small muted" style={{ marginTop: -6 }}>
        Rekkefølgen er anbefalt: de robuste først. Portalinnlogging nederst er skjør og bør bare
        brukes til leverandører ingen av de andre kanalene dekker.
      </p>
      <div className="cards">
        {available
          .filter((c) => !configured.has(c.type))
          .map((c) => {
            // Uten et skjema kan kilden fortsatt kjøre, men ikke settes opp
            // herfra. Da sier vi det, i stedet for å lenke til en blindvei.
            const form = formFor(c.type);
            return (
              <div className="card" key={c.type}>
                <div style={{ fontSize: 15, marginBottom: 4 }}>{form?.title ?? c.label}</div>
                <div className="small muted" style={{ minHeight: 46 }}>
                  {form?.promise ?? "Kan settes opp fra kommandolinjen."}
                </div>
                {form ? (
                  <Link href={`/kanaler/ny/${c.type}`}>
                    <button type="button" style={{ marginTop: 8 }}>
                      {form.unavailable ? "Les mer" : "Sett opp"}
                    </button>
                  </Link>
                ) : null}
              </div>
            );
          })}
      </div>
    </>
  );
}

const STATUS_LABELS: Record<string, string> = {
  active: "aktiv",
  paused: "pauset",
  needs_auth: "må godkjennes",
  error: "feil",
};
