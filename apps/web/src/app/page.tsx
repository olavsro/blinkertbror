/**
 * Oversikt: inntekt vs. utgift over tid, per kategori, per kanal.
 *
 * Diagrammene er rene CSS-stolper, ikke et chart-bibliotek. Fem tall i en
 * kolonne trenger ikke 90 kB JavaScript, og en serverkomponent uten klientkode
 * laster øyeblikkelig.
 */
import Link from "next/link";
import { formatPlain } from "@qbikk/core/money";
import { currentUser, loadDashboard, countActionItems } from "@/lib/data";

export const dynamic = "force-dynamic";

const MONTHS = ["jan", "feb", "mar", "apr", "mai", "jun", "jul", "aug", "sep", "okt", "nov", "des"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ ar?: string }>;
}) {
  const user = await currentUser();
  if (!user) return <NoUser />;

  const params = await searchParams;
  const year = Number(params.ar) || new Date().getFullYear();
  const [data, pending] = await Promise.all([loadDashboard(user.id, year), countActionItems(user.id)]);

  const peak = Math.max(1, ...data.months.flatMap((m) => [m.income, m.expense]));

  return (
    <>
      <h1>Oversikt {year}</h1>
      <p className="lede">
        {data.totals.vouchers} bilag registrert.{" "}
        <Link href={`/?ar=${year - 1}`}>{year - 1}</Link> · <Link href={`/?ar=${year + 1}`}>{year + 1}</Link>
      </p>

      {pending > 0 ? (
        <div className="notice">
          {pending} {pending === 1 ? "sak venter" : "saker venter"} på deg.{" "}
          <Link href="/handling">Se hva det gjelder</Link>
        </div>
      ) : null}

      <div className="cards">
        <div className="card">
          <div className="label">Inntekt</div>
          <div className="value income">{formatPlain(data.totals.income)} kr</div>
        </div>
        <div className="card">
          <div className="label">Utgift</div>
          <div className="value expense">{formatPlain(data.totals.expense)} kr</div>
        </div>
        <div className="card">
          <div className="label">Resultat</div>
          <div className={`value ${data.totals.result >= 0 ? "income" : "expense"}`}>
            {formatPlain(data.totals.result)} kr
          </div>
        </div>
        <div className="card">
          <div className="label">Bilag</div>
          <div className="value">{data.totals.vouchers}</div>
        </div>
      </div>

      <h2>Måned for måned</h2>
      <div className="panel">
        {data.months.length === 0 ? (
          <div className="empty">Ingen bilag i {year} ennå.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>Måned</th>
                <th className="num" style={{ width: 120 }}>Inntekt</th>
                <th className="num" style={{ width: 120 }}>Utgift</th>
                <th>Fordeling</th>
                <th className="num" style={{ width: 120 }}>Resultat</th>
              </tr>
            </thead>
            <tbody>
              {data.months.map((m) => {
                const month = Number(m.month.slice(5, 7)) - 1;
                const result = m.income - m.expense;
                return (
                  <tr key={m.month}>
                    <td>{MONTHS[month] ?? m.month}</td>
                    <td className="num income">{m.income ? formatPlain(m.income) : "-"}</td>
                    <td className="num expense">{m.expense ? formatPlain(m.expense) : "-"}</td>
                    <td>
                      <div className="bar">
                        <span
                          style={{
                            width: `${(m.income / peak) * 100}%`,
                            background: "var(--income)",
                          }}
                        />
                      </div>
                      <div className="bar" style={{ marginTop: 3 }}>
                        <span
                          style={{
                            width: `${(m.expense / peak) * 100}%`,
                            background: "var(--expense)",
                          }}
                        />
                      </div>
                    </td>
                    <td className={`num ${result >= 0 ? "income" : "expense"}`}>{formatPlain(result)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <h2>Per kategori</h2>
      <div className="panel">
        {data.categories.length === 0 ? (
          <div className="empty">Ingenting å vise ennå.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kategori</th>
                <th>Retning</th>
                <th className="num">Bilag</th>
                <th className="num">Beløp</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={`${c.category}-${c.direction}`}>
                  <td>
                    <Link href={`/bilag?kategori=${encodeURIComponent(c.category)}`}>{c.category}</Link>
                  </td>
                  <td className={c.direction}>{c.direction === "income" ? "inntekt" : "utgift"}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{formatPlain(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Per kanal</h2>
      <div className="panel">
        {data.channels.length === 0 ? (
          <div className="empty">Ingen kanaler har levert noe ennå.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kanal</th>
                <th className="num">Bilag</th>
                <th className="num">Beløp</th>
              </tr>
            </thead>
            <tbody>
              {data.channels.map((c) => (
                <tr key={c.channel}>
                  <td>{CHANNEL_LABELS[c.channel] ?? c.channel}</td>
                  <td className="num">{c.count}</td>
                  <td className="num">{formatPlain(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  email_forward: "Videresendt e-post",
  inbox_scan: "Søk i innboks",
  bank: "Bank",
  file_upload: "Opplastet",
  folder_watch: "Overvåket mappe",
  browser: "Portalinnlogging",
  manual: "Manuelt",
};

function NoUser() {
  return (
    <>
      <h1>Ingen bruker ennå</h1>
      <p className="lede">Databasen er tom.</p>
      <div className="panel">
        <p>Kjør dette i prosjektmappa for å komme i gang:</p>
        <pre>
          <code>pnpm seed</code>
        </pre>
        <p className="small muted">
          Det oppretter én bruker med bransjeprofilen fra <code>DEFAULT_PROFILE</code>, en
          bilagsadresse og kategorireglene fra profilen.
        </p>
      </div>
    </>
  );
}
