/**
 * MVA-oppsummering per termin.
 *
 * Norske terminer er annenhver måned: jan-feb = 1, ... nov-des = 6.
 *
 * Omvendt avgiftsplikt har sin EGEN seksjon, ikke en rad blant de andre.
 * Grunnen: nettoeffekten er null for en fradragsberettiget virksomhet, så det
 * er fristende å tro at den ikke betyr noe. Men BEGGE beløpene skal føres -
 * som utgående og som inngående - og at de ikke blir det er en av de
 * vanligste feilene hos små selskaper med utenlandske abonnementer.
 */
import { formatPlain } from "@qbikk/core/money";
import { VAT_LABELS, type VatCode } from "@qbikk/core/vat";
import { currentUser, loadVatSummary } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function VatPage({
  searchParams,
}: {
  searchParams: Promise<{ ar?: string }>;
}) {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  const params = await searchParams;
  const year = Number(params.ar) || new Date().getFullYear();
  const terms = await loadVatSummary(user.id, year);

  const yearOut = terms.reduce((a, t) => a + t.outgoing.reduce((s, r) => s + r.vat, 0), 0);
  const yearIn = terms.reduce((a, t) => a + t.incoming.reduce((s, r) => s + r.vat, 0), 0);
  const yearReverse = terms.reduce((a, t) => a + t.reverseCharge.vat, 0);

  return (
    <>
      <h1>MVA {year}</h1>
      <p className="lede">
        {user.vatRegistered ? "Registrert i Merverdiavgiftsregisteret." : "Ikke MVA-registrert."} Tall
        i NOK, omregnet med kursen som ble lagret på hvert bilag.
      </p>

      <div className="panel">
        <strong>Eksport til regnskapsfører</strong>
        <div className="small muted" style={{ margin: "4px 0 8px" }}>
          SAF-T er standardformatet Skatteetaten og de fleste regnskapssystemer tar imot. CSV-en
          er for kontorer som heller vil ha en fil de kan åpne i Excel.
        </div>
        <a href={`/api/eksport/saft?ar=${year}`}>SAF-T (XML)</a>
        {" · "}
        <a href={`/api/eksport/csv?ar=${year}`}>CSV med debet/kredit</a>
        {" · "}
        <a href={`/api/eksport/enkel?ar=${year}`}>Enkel CSV (én linje per bilag)</a>
      </div>

      <div className="cards">
        <div className="card">
          <div className="label">Utgående MVA</div>
          <div className="value">{formatPlain(yearOut)} kr</div>
        </div>
        <div className="card">
          <div className="label">Inngående MVA</div>
          <div className="value">{formatPlain(yearIn)} kr</div>
        </div>
        <div className="card">
          <div className="label">Å betale i året</div>
          <div className={`value ${yearOut - yearIn >= 0 ? "expense" : "income"}`}>
            {formatPlain(yearOut - yearIn)} kr
          </div>
        </div>
        <div className="card">
          <div className="label">Omvendt avgiftsplikt</div>
          <div className="value">{formatPlain(yearReverse)} kr</div>
          <div className="small muted">føres på begge sider</div>
        </div>
      </div>

      {terms.map((term) => {
        const out = term.outgoing.reduce((a, r) => a + r.vat, 0);
        const inn = term.incoming.reduce((a, r) => a + r.vat, 0);
        const empty =
          term.outgoing.length === 0 && term.incoming.length === 0 && term.reverseCharge.count === 0;

        return (
          <div key={term.term}>
            <h2>
              Termin {term.term}{" "}
              <span className="small muted" style={{ fontWeight: 400 }}>
                {term.from} – {term.to}
              </span>
            </h2>
            <div className="panel" style={{ padding: 0 }}>
              {empty ? (
                <div className="empty">Ingen bilag i denne terminen.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Post</th>
                      <th>Sats</th>
                      <th className="num">Grunnlag</th>
                      <th className="num">MVA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {term.outgoing.map((r) => (
                      <tr key={`out-${r.code}`}>
                        <td>Utgående — {VAT_LABELS[r.code as VatCode]}</td>
                        <td className="small">{r.rate} %</td>
                        <td className="num">{formatPlain(r.base)}</td>
                        <td className="num">{formatPlain(r.vat)}</td>
                      </tr>
                    ))}
                    {term.incoming.map((r) => (
                      <tr key={`in-${r.code}`}>
                        <td>Inngående — {VAT_LABELS[r.code as VatCode]}</td>
                        <td className="small">{r.rate} %</td>
                        <td className="num">{formatPlain(r.base)}</td>
                        <td className="num">{formatPlain(r.vat)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>Å betale for terminen</strong>
                      </td>
                      <td />
                      <td />
                      <td className="num">
                        <strong>{formatPlain(out - inn)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>

            {term.reverseCharge.count > 0 ? (
              <div className="notice">
                <strong>Omvendt avgiftsplikt · {term.reverseCharge.count} bilag</strong>
                <div style={{ marginTop: 4 }}>
                  Grunnlag {formatPlain(term.reverseCharge.base)} kr. Du skal føre{" "}
                  {formatPlain(term.reverseCharge.vat)} kr som <em>utgående</em> MVA og det samme
                  beløpet som <em>inngående</em>. Netto blir null, men begge tallene skal stå i
                  meldingen.
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
