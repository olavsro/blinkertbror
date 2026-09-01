import type { Metadata } from "next";
import Link from "next/link";
import { currentUser, countActionItems } from "@/lib/data";
import { readFlash } from "@/lib/flash";
import { inboundAddress } from "@qbikk/core/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Qbikk - bilag",
  description: "Automatisk bilagsinnsamling for norske selvstendig næringsdrivende",
};

// Alt her leser databasen. Ingenting skal caches mellom forespørsler.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  // Tallet i menyen er hele poenget med «krever handling»: brukeren skal se
  // at det finnes noe å gjøre uten å måtte lete etter det.
  const pending = user ? await countActionItems(user.id) : 0;
  const flash = await readFlash();

  return (
    <html lang="nb">
      <body>
        <header className="top">
          <div className="inner">
            <span className="brand">Qbikk</span>
            <nav>
              <Link href="/">Oversikt</Link>
              <Link href="/bilag">Bilag</Link>
              <Link href="/handling">Krever handling{pending > 0 ? ` (${pending})` : ""}</Link>
              <Link href="/kanaler">Kanaler</Link>
              <Link href="/mva">MVA</Link>
            </nav>
            {user ? <span className="addr">{inboundAddress(user.inboundSlug)}</span> : null}
          </div>
        </header>
        <main className="shell">
          {flash ? (
            <div
              className="notice"
              style={
                flash.ok
                  ? { background: "#ecfdf5", borderColor: "#a7f3d0", color: "var(--income)" }
                  : undefined
              }
            >
              {flash.message}
            </div>
          ) : null}
          {children}
        </main>
      </body>
    </html>
  );
}
