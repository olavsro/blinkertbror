/**
 * Ett bilag: felter, varelinjer, korreksjonshistorikk og lenke til
 * rådokumentet.
 *
 * Korreksjonshistorikken vises fordi den ER produktet her. Et regnskap som
 * ikke kan forklare hvorfor et tall står som det gjør, er ikke et regnskap -
 * og bokføringsloven krever at sporet finnes i fem år.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPlain } from "@qbikk/core/money";
import { VAT_LABELS, type VatCode } from "@qbikk/core/vat";
import { getProfile } from "@qbikk/core/profiles/index";
import { correctVoucher, confirmVoucher, reextractVoucher, rematchVoucher } from "@/lib/actions";
import { currentUser, getVoucherDetail } from "@/lib/data";

export const dynamic = "force-dynamic";

export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker.</p>;

  const { id } = await params;
  const detail = await getVoucherDetail(user.id, id);
  if (!detail) notFound();

  const { voucher: v, lines, corrections, rawDocument } = detail;
  const profile = getProfile(user.profile);

  return (
    <>
      <p className="small muted">
        <Link href="/bilag">← Alle bilag</Link>
      </p>
      <h1>{v.counterpartyName ?? "Ukjent motpart"}</h1>
      <p className="lede">
        {v.description ?? "Ingen beskrivelse"} · {v.date} ·{" "}
        <span className={`pill ${v.status}`}>{v.status}</span>
      </p>

      {v.reverseCharge ? (
        <div className="notice">
          Omvendt avgiftsplikt. Du skal beregne 25 % utgående MVA av
          {" "}{formatPlain(v.netAmount ?? v.grossAmount, v.currency)} {v.currency} og føre det samme
          beløpet som inngående. Begge tallene skal med i MVA-meldingen.
        </div>
      ) : null}

      <div className="cards">
        <div className="card">
          <div className="label">Bruttobeløp</div>
          <div className={`value ${v.direction}`}>
            {formatPlain(v.grossAmount, v.currency)} {v.currency}
          </div>
          {v.currency !== "NOK" ? (
            <div className="small muted">
              {formatPlain(v.amountNok)} kr · kurs {v.exchangeRate} pr. {v.rateDate}
            </div>
          ) : null}
        </div>
        <div className="card">
          <div className="label">Netto</div>
          <div className="value">{v.netAmount !== null ? formatPlain(v.netAmount, v.currency) : "-"}</div>
        </div>
        <div className="card">
          <div className="label">MVA</div>
          <div className="value">{v.vatAmount !== null ? formatPlain(v.vatAmount, v.currency) : "-"}</div>
          <div className="small muted">{v.vatCode ? VAT_LABELS[v.vatCode as VatCode] : "ikke satt"}</div>
        </div>
        <div className="card">
          <div className="label">Sikkerhet</div>
          <div className="value">{v.confidence ? `${Math.round(Number(v.confidence) * 100)} %` : "-"}</div>
          <div className="small muted">konto {v.accountCode ?? "-"}</div>
        </div>
      </div>

      <h2>Rett opp</h2>
      <div className="panel">
        <div style={{ display: "grid", gap: 10 }}>
          <Field label="Dato" voucherId={v.id} field="date" value={v.date} type="date" />
          <Field
            label="Motpart"
            voucherId={v.id}
            field="counterpartyName"
            value={v.counterpartyName ?? ""}
          />
          <Field
            label="Beskrivelse"
            voucherId={v.id}
            field="description"
            value={v.description ?? ""}
          />
          <form action={correctVoucher} className="inline">
            <input type="hidden" name="voucherId" value={v.id} />
            <input type="hidden" name="field" value="direction" />
            <span style={{ width: 120 }} className="small muted">
              Retning
            </span>
            <select name="value" defaultValue={v.direction}>
              <option value="expense">utgift</option>
              <option value="income">inntekt</option>
            </select>
            <button type="submit">Lagre</button>
            <span className="small muted">
              Retningen kommer fra dokumentet. Rett den bare hvis dokumentet ble lest feil.
            </span>
          </form>
          <form action={correctVoucher} className="inline">
            <input type="hidden" name="voucherId" value={v.id} />
            <input type="hidden" name="field" value="category" />
            <span style={{ width: 120 }} className="small muted">
              Kategori
            </span>
            <select name="value" defaultValue={v.category ?? ""}>
              {profile.categories
                .filter((c) => c.direction === null || c.direction === v.direction)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label} ({c.accountCode})
                  </option>
                ))}
            </select>
            <button type="submit">Lagre</button>
            <span className="small muted">Rettes dette, lærer systemet regelen til neste gang.</span>
          </form>
          <form action={correctVoucher} className="inline">
            <input type="hidden" name="voucherId" value={v.id} />
            <input type="hidden" name="field" value="vatCode" />
            <span style={{ width: 120 }} className="small muted">
              MVA-kode
            </span>
            <select name="value" defaultValue={v.vatCode ?? ""}>
              {Object.entries(VAT_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
            <button type="submit">Lagre</button>
          </form>
          <Field
            label="Bruttobeløp"
            voucherId={v.id}
            field="grossAmount"
            value={(v.grossAmount / 100).toFixed(2)}
            hint={`i ${v.currency}, f.eks. 1234,50`}
          />
        </div>
      </div>

      <div className="panel">
        <form action={confirmVoucher} className="inline">
          <input type="hidden" name="voucherId" value={v.id} />
          <button type="submit" className="primary" disabled={v.status === "confirmed"}>
            {v.status === "confirmed" ? "Godkjent" : "Godkjenn bilaget"}
          </button>
        </form>{" "}
        <form action={rematchVoucher} className="inline">
          <input type="hidden" name="voucherId" value={v.id} />
          <button type="submit">Let etter match</button>
        </form>{" "}
        {rawDocument ? (
          <form action={reextractVoucher} className="inline">
            <input type="hidden" name="rawDocumentId" value={rawDocument.id} />
            <button type="submit">Tolk dokumentet på nytt</button>
          </form>
        ) : null}
      </div>

      {lines.length > 0 ? (
        <>
          <h2>Varelinjer</h2>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Beskrivelse</th>
                  <th className="num">Netto</th>
                  <th>MVA</th>
                  <th className="num">MVA-beløp</th>
                  <th className="num">Brutto</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td>{l.description ?? "-"}</td>
                    <td className="num">{formatPlain(l.netAmount, v.currency)}</td>
                    <td className="small">{l.vatRate} %</td>
                    <td className="num">{formatPlain(l.vatAmount, v.currency)}</td>
                    <td className="num">{formatPlain(l.grossAmount, v.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2>Historikk</h2>
      <div className="panel" style={{ padding: 0 }}>
        {corrections.length === 0 ? (
          <div className="empty">Ingen endringer. Bilaget står som det ble tolket.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 160 }}>Tidspunkt</th>
                <th style={{ width: 130 }}>Felt</th>
                <th>Fra</th>
                <th>Til</th>
                <th style={{ width: 90 }}>Av</th>
              </tr>
            </thead>
            <tbody>
              {corrections.map((c) => (
                <tr key={c.id}>
                  <td className="small">{c.createdAt.toLocaleString("nb-NO")}</td>
                  <td className="small">{c.field}</td>
                  <td className="small muted">{JSON.stringify(c.oldValue) ?? "-"}</td>
                  <td className="small">{JSON.stringify(c.newValue) ?? "-"}</td>
                  <td className="small muted">
                    {c.actor}
                    {c.learnedRuleId ? " · lærte regel" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {rawDocument ? (
        <>
          <h2>Rådokument</h2>
          <div className="panel">
            <p className="small muted">
              {rawDocument.kind} · mottatt {rawDocument.receivedAt.toLocaleString("nb-NO")} · fra{" "}
              {rawDocument.sender ?? "ukjent"}
            </p>
            <p className="small muted">
              sha256 <code>{rawDocument.contentSha256.slice(0, 16)}…</code> · arkivnøkkel{" "}
              <code>{rawDocument.storageKey ?? "-"}</code>
            </p>
            {rawDocument.textBody ? (
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 320,
                  overflow: "auto",
                  fontSize: 12,
                  background: "#fafaf9",
                  padding: 12,
                  borderRadius: 6,
                  margin: 0,
                }}
              >
                {rawDocument.textBody}
              </pre>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function Field({
  label,
  voucherId,
  field,
  value,
  type = "text",
  hint,
}: {
  label: string;
  voucherId: string;
  field: string;
  value: string;
  type?: string;
  hint?: string;
}) {
  return (
    <form action={correctVoucher} className="inline">
      <input type="hidden" name="voucherId" value={voucherId} />
      <input type="hidden" name="field" value={field} />
      <span style={{ width: 120 }} className="small muted">
        {label}
      </span>
      <input type={type} name="value" defaultValue={value} style={{ minWidth: 240 }} />
      <button type="submit">Lagre</button>
      {hint ? <span className="small muted">{hint}</span> : null}
    </form>
  );
}
