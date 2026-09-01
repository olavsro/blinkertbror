"use client";

/**
 * Slippsone for filer.
 *
 * Klientkomponent fordi drag-and-drop og en fremdriftsindikator ikke finnes
 * uten JavaScript. Den faller tilbake på et helt vanlig `<input type="file">`
 * med en submit-knapp hvis JS er av, så opplasting virker uansett.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Result {
  ok: boolean;
  created?: number;
  duplicates?: number;
  rejected?: number;
  error?: string;
}

export function UploadBox() {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  async function send(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;

    setBusy(true);
    setResult(null);

    const body = new FormData();
    for (const file of Array.from(files)) body.append("files", file);

    try {
      const res = await fetch("/api/upload", { method: "POST", body });
      setResult((await res.json()) as Result);
      // Tallene i menyen og på forsiden endrer seg av dette.
      router.refresh();
    } catch {
      setResult({ ok: false, error: "Fikk ikke sendt filene. Sjekk nettforbindelsen og prøv igjen." });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <div
        className={`dropzone${dragging ? " dragging" : ""}${busy ? " busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <div className="dropzone-icon">{busy ? "⏳" : "📄"}</div>
        <div className="dropzone-title">
          {busy ? "Leser filene..." : dragging ? "Slipp her" : "Dra filer hit"}
        </div>
        <div className="small muted">
          eller trykk for å velge · PDF, JPG, PNG, HEIC · maks 25 MB per fil
        </div>
        <input
          ref={inputRef}
          type="file"
          name="files"
          multiple
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          hidden
          onChange={(e) => void send(e.target.files)}
        />
      </div>

      {result ? (
        <div className="notice" style={result.ok ? okStyle : undefined}>
          {result.ok ? (
            <>
              <strong>
                {result.created === 0
                  ? "Ingen nye filer"
                  : `${result.created} ${result.created === 1 ? "fil" : "filer"} lest inn`}
              </strong>
              <div style={{ marginTop: 4 }}>
                {result.created ? (
                  <>
                    Vi tolker dem nå - det tar noen sekunder. De dukker opp under{" "}
                    <a href="/bilag">Bilag</a>.
                  </>
                ) : null}
                {result.duplicates ? (
                  <div>
                    {result.duplicates}{" "}
                    {result.duplicates === 1 ? "fil hadde du sendt inn før" : "filer hadde du sendt inn før"} -
                    de ble ikke lagt inn på nytt.
                  </div>
                ) : null}
                {result.rejected ? (
                  <div>
                    {result.rejected}{" "}
                    {result.rejected === 1 ? "fil" : "filer"} kunne vi ikke lese. Vi tar imot PDF og
                    bilder.
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <strong>{result.error ?? "Noe gikk galt."}</strong>
          )}
        </div>
      ) : null}
    </>
  );
}

const okStyle = { background: "#ecfdf5", borderColor: "#a7f3d0", color: "var(--income)" } as const;
