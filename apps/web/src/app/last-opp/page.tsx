/**
 * Opplasting av filer.
 *
 * Veiviseren lover at du kan ta bilde av en papirkvittering og sende den inn.
 * `/api/upload` har tatt imot filer hele tiden, men det fantes ikke et sted å
 * slippe dem - løftet var altså ikke innfridd noe sted i UI-et.
 */
import Link from "next/link";
import { currentUser } from "@/lib/data";
import { UploadBox } from "./upload-box";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  const user = await currentUser();
  if (!user) return <p className="lede">Ingen bruker. Kjør `pnpm seed`.</p>;

  return (
    <>
      <h1>Last opp kvitteringer</h1>
      <p className="lede">
        Dra filene inn i ruta, eller trykk for å velge. Én fil blir til ett bilag.
      </p>

      <UploadBox />

      <div className="panel">
        <strong>Hva kan du sende inn?</strong>
        <ul className="before-list">
          <li>
            <strong>Bilde av en papirkvittering.</strong> Ta bildet rett ovenfra, med beløp, dato og
            butikknavn synlig. Du trenger ikke skanne noe.
          </li>
          <li>
            <strong>PDF-faktura</strong> fra en leverandør.
          </li>
          <li>
            <strong>Skjermbilde</strong> av en kvittering du fikk i en app.
          </li>
        </ul>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Er noe uleselig, gjetter vi ikke - da havner bilaget under{" "}
          <Link href="/handling">Krever handling</Link> så du kan se på det selv.
        </p>
      </div>

      <div className="panel">
        <strong>Slipper du å gjøre dette hver gang?</strong>
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          Ja. Videresend kvitteringer på e-post til adressen din i stedet, så går det av seg selv.{" "}
          <Link href="/kanaler">Se kildene dine</Link>
        </p>
      </div>
    </>
  );
}
