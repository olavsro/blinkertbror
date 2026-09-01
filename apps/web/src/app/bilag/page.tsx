/**
 * Bilagslista med filter, fritekstsøk og korrigering rett i tabellen.
 *
 * Korrigeringen er en helt vanlig `<form action={serverAction}>`. Ingen
 * klientkomponent, ingen state, ingen fetch - og dermed heller ingen
 * mulighet for at UI-et viser noe annet enn det som står i databasen.
 * Hver lagring går gjennom `applyCorrection`, som skriver revisjonssporet.
 */
import Link from "next/link";
import { formatPlain } from "@qbikk/core/money";
import { VAT_LABELS } from "@qbikk/core/vat";
import { getProfile } from "@qbikk/core/profiles/index";
import { correctVoucher, confirmVoucher } from "@/lib/actions";
import { currentUser, listVouchers, listUsedCategories, type VoucherFilter } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function VoucherListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  const params = await searchParams;
  const filter: VoucherFilter = {
    from: params.fra || undefined,
    to: params.til || undefined,
    direction: params.retning === "income" || params.retning === "expense" ? params.retning : undefined,
    status: (params.status as VoucherFilter["status"]) || undefined,
    category: params.kategori || undefined,
    channel: (params.kanal as VoucherFilter["channel"]) || undefined,
    q: params.q || undefined,
  };

  const [rows, categories] = await Promise.all([
    listVouchers(user.id, filter),
    listUsedCategories(user.id),
  ]);

  const profile = getProfile(user.profile);
  const sum = rows.reduce((a, r) => a + (r.direction === "income" ? r.amountNok : -r.amountNok), 0);

  return (
    <>
      <h1>Bilag</h1>
      <p className="lede">
        {rows.length} bilag · netto {formatPlain(sum)} kr
      </p>

      <form className="filters" method="get">
        <label>
          Fra
          <input type="date" name="fra" defaultValue={params.fra ?? ""} />
        </label>
        <label>
          Til
          <input type="date" name="til" defaultValue={params.til ?? ""} />
        </label>
        <label>
          Retning
          <select name="retning" defaultValue={params.retning ?? ""}>
            <option value="">alle</option>
            <option value="income">inntekt</option>
            <option value="expense">utgift</option>
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue={params.status ?? ""}>
            <option value="">alle</option>
            <option value="needs_review">krever gjennomgang</option>
            <option value="matched">klar</option>
            <option value="confirmed">godkjent</option>
            <option value="duplicate">dublett</option>
          </select>
        </label>
        <label>
          Kategori
          <select name="kategori" defaultValue={params.kategori ?? ""}>
            <option value="">alle</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kanal
          <select name="kanal" defaultValue={params.kanal ?? ""}>
            <option value="">alle</option>
            <option value="email_forward">videresendt e-post</option>
            <option value="inbox_scan">søk i innboks</option>
            <option value="bank">bank</option>
            <option value="file_upload">opplastet</option>
            <option value="folder_watch">mappe</option>
            <option value="browser">portal</option>
          </select>
        </label>
        <label>
          Søk
          <input type="search" name="q" placeholder="motpart, tekst, ref" defaultValue={params.q ?? ""} />
        </label>
        <button type="submit">Filtrer</button>
        <Link href="/bilag" className="small muted" style={{ paddingBottom: 6 }}>
          nullstill
        </Link>
      </form>

      <div className="panel" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="empty">Ingen bilag matcher filteret.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 92 }}>Dato</th>
                <th>Motpart</th>
                <th>Beskrivelse</th>
                <th style={{ width: 190 }}>Kategori</th>
                <th style={{ width: 130 }}>MVA</th>
                <th className="num" style={{ width: 120 }}>Beløp</th>
                <th style={{ width: 150 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id}>
                  <td className="small">{v.date}</td>
                  <td>
                    <Link href={`/bilag/${v.id}`}>{v.counterpartyName ?? "ukjent"}</Link>
                    {v.counterpartyCountry && v.counterpartyCountry !== "NO" ? (
                      <span className="muted small"> {v.counterpartyCountry}</span>
                    ) : null}
                  </td>
                  <td className="small muted">{v.description ?? "-"}</td>
                  <td>
                    {/* Endring lagres ved valg - ett klikk, ingen lagre-knapp. */}
                    <form action={correctVoucher} className="inline">
                      <input type="hidden" name="voucherId" value={v.id} />
                      <input type="hidden" name="field" value="category" />
                      <select name="value" defaultValue={v.category ?? ""} style={{ width: "100%" }}>
                        {profile.categories
                          .filter((c) => c.direction === null || c.direction === v.direction)
                          .map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                        {v.category && !profile.categories.some((c) => c.key === v.category) ? (
                          <option value={v.category}>{v.category}</option>
                        ) : null}
                      </select>
                      <button type="submit" title="Lagre kategori">
                        ✓
                      </button>
                    </form>
                  </td>
                  <td className="small">
                    {v.reverseCharge ? (
                      <span className="pill needs_review">omvendt</span>
                    ) : (
                      (v.vatCode ? VAT_LABELS[v.vatCode] : "-")
                    )}
                  </td>
                  <td className={`num ${v.direction}`}>
                    {v.direction === "expense" ? "-" : ""}
                    {formatPlain(v.grossAmount, v.currency)}
                    {v.currency !== "NOK" ? (
                      <div className="small muted">{formatPlain(v.amountNok)} kr</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`pill ${v.status}`}>{STATUS_LABELS[v.status]}</span>
                    {v.status !== "confirmed" && v.status !== "duplicate" ? (
                      <form action={confirmVoucher} className="inline" style={{ marginTop: 4 }}>
                        <input type="hidden" name="voucherId" value={v.id} />
                        <button type="submit" className="small">
                          Godkjenn
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const STATUS_LABELS: Record<string, string> = {
  needs_review: "gjennomgang",
  matched: "klar",
  confirmed: "godkjent",
  duplicate: "dublett",
};
