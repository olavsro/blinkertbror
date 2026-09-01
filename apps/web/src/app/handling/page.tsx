/**
 * «Krever handling» - køen som er hele forskjellen på et system som samler
 * bilag og et system som gir deg et regnskap.
 *
 * Fire bunker, i den rekkefølgen de koster brukeren mest:
 *   1. Foreslåtte matcher - ett klikk, og to rader blir til ett riktig bilag.
 *   2. Bank uten kvittering - pengene er borte, dokumentasjonen mangler.
 *      Dette er posten en revisor faktisk spør om.
 *   3. Lav sikkerhet - systemet gjettet ikke, og sier fra i stedet.
 *   4. Kanaler som har stoppet opp.
 *
 * Ingenting her løses automatisk. Det er poenget: usikre ting foreslås,
 * de utføres ikke.
 */
import Link from "next/link";
import { formatPlain } from "@qbikk/core/money";
import { confirmMatch, dismissMatch, confirmVoucher, checkChannelHealth } from "@/lib/actions";
import { currentUser, loadActionItems } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function ActionPage() {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  const items = await loadActionItems(user.id);
  const total =
    items.proposedMatches.length +
    items.missingDocumentation.length +
    items.needsReview.length +
    items.channelsNeedingAuth.length;

  return (
    <>
      <h1>Krever handling</h1>
      <p className="lede">
        {total === 0
          ? "Ingenting venter på deg akkurat nå."
          : `${total} ${total === 1 ? "sak" : "saker"} som systemet ikke vil avgjøre på egen hånd.`}
      </p>

      {items.channelsNeedingAuth.length > 0 ? (
        <>
          <h2>Kanaler som har stoppet</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Kanal</th>
                  <th>Problem</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {items.channelsNeedingAuth.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href="/kanaler">{c.name}</Link>
                      <div className="small muted">{c.type}</div>
                    </td>
                    <td className="small">{c.lastError ?? "Trenger ny godkjenning"}</td>
                    <td>
                      <form action={checkChannelHealth} className="inline">
                        <input type="hidden" name="channelId" value={c.id} />
                        <button type="submit">Test på nytt</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {items.proposedMatches.length > 0 ? (
        <>
          <h2>Foreslåtte koblinger</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            Systemet fant en sannsynlig kvittering til en betaling, men var ikke sikkert nok til å
            koble dem selv. Godkjenner du, blir de ett bilag - dokumentet beholdes med MVA og
            varelinjer, og bokføringsdatoen hentes fra banken.
          </p>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Banktransaksjon</th>
                  <th>Kvittering</th>
                  <th className="num" style={{ width: 80 }}>Treff</th>
                  <th style={{ width: 200 }} />
                </tr>
              </thead>
              <tbody>
                {items.proposedMatches.map(({ match, bank, document }) => (
                  <tr key={match.id}>
                    <td>
                      {bank ? (
                        <>
                          <Link href={`/bilag/${bank.id}`}>{bank.counterpartyName ?? "ukjent"}</Link>
                          <div className="small muted">
                            {bank.date} · {formatPlain(bank.amountNok)} kr
                          </div>
                        </>
                      ) : (
                        <span className="muted">borte</span>
                      )}
                    </td>
                    <td>
                      {document ? (
                        <>
                          <Link href={`/bilag/${document.id}`}>
                            {document.counterpartyName ?? "ukjent"}
                          </Link>
                          <div className="small muted">
                            {document.date} · {formatPlain(document.amountNok)} kr ·{" "}
                            {document.description ?? ""}
                          </div>
                        </>
                      ) : (
                        <span className="muted">borte</span>
                      )}
                    </td>
                    <td className="num">{Math.round(Number(match.score) * 100)} %</td>
                    <td>
                      <form action={confirmMatch} className="inline">
                        <input type="hidden" name="bankVoucherId" value={match.bankVoucherId} />
                        <input type="hidden" name="documentVoucherId" value={match.documentVoucherId} />
                        <button type="submit" className="primary">
                          Koble
                        </button>
                      </form>{" "}
                      <form action={dismissMatch} className="inline">
                        <input type="hidden" name="bankVoucherId" value={match.bankVoucherId} />
                        <input type="hidden" name="documentVoucherId" value={match.documentVoucherId} />
                        <button type="submit">Ikke samme</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {items.missingDocumentation.length > 0 ? (
        <>
          <h2>Betalinger uten kvittering</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            Pengene har gått ut av konto, men vi har ikke funnet dokumentasjonen. Videresend
            kvitteringen til bilagsadressen din, eller last den opp.
          </p>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Dato</th>
                  <th>Motpart</th>
                  <th>Tekst fra banken</th>
                  <th className="num" style={{ width: 110 }}>Beløp</th>
                </tr>
              </thead>
              <tbody>
                {items.missingDocumentation.map((v) => (
                  <tr key={v.id}>
                    <td className="small">{v.date}</td>
                    <td>
                      <Link href={`/bilag/${v.id}`}>{v.counterpartyName ?? "ukjent"}</Link>
                    </td>
                    <td className="small muted">{v.description ?? "-"}</td>
                    <td className={`num ${v.direction}`}>{formatPlain(v.amountNok)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {items.needsReview.length > 0 ? (
        <>
          <h2>Til gjennomgang</h2>
          <p className="small muted" style={{ marginTop: -6 }}>
            Her var systemet usikkert på noe det ikke ville gjette på. Sjekk beløp, dato og
            retning, og godkjenn.
          </p>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 92 }}>Dato</th>
                  <th>Motpart</th>
                  <th>Beskrivelse</th>
                  <th className="num" style={{ width: 110 }}>Beløp</th>
                  <th className="num" style={{ width: 70 }}>Sikker</th>
                  <th style={{ width: 190 }} />
                </tr>
              </thead>
              <tbody>
                {items.needsReview.map((v) => (
                  <tr key={v.id}>
                    <td className="small">{v.date}</td>
                    <td>
                      <Link href={`/bilag/${v.id}`}>{v.counterpartyName ?? "ukjent"}</Link>
                    </td>
                    <td className="small muted">{v.description ?? "-"}</td>
                    <td className={`num ${v.direction}`}>
                      {formatPlain(v.grossAmount, v.currency)} {v.currency !== "NOK" ? v.currency : ""}
                    </td>
                    <td className="num small">
                      {v.confidence ? `${Math.round(Number(v.confidence) * 100)} %` : "-"}
                    </td>
                    <td>
                      <Link href={`/bilag/${v.id}`} className="small">
                        Se og rett
                      </Link>{" "}
                      <form action={confirmVoucher} className="inline">
                        <input type="hidden" name="voucherId" value={v.id} />
                        <button type="submit">Godkjenn</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {total === 0 ? (
        <div className="panel">
          <div className="empty">
            Alt er avstemt. Nye bilag dukker opp her hvis systemet blir usikkert på noe.
          </div>
        </div>
      ) : null}
    </>
  );
}
