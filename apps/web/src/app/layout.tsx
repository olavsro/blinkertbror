import type { Metadata } from "next";
import Link from "next/link";
import { currentUser, countActionItems } from "@/lib/data";
import { readFlash } from "@/lib/flash";
import { loadOnboardingStatus, shouldShowWizard } from "@/lib/onboarding";
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
  // Banneret ligger i layouten slik at det følger brukeren uansett hvor de
  // klikker seg hen før de er ferdige med oppstarten.
  const onboarding = user ? await loadOnboardingStatus(user) : null;
  const showBanner = onboarding !== null && shouldShowWizard(onboarding);

  return (
    <html lang="nb">
      <body>
        <header className="top">
          <div className="inner">
            <span className="brand">Qbikk</span>
            <nav>
              {showBanner ? <Link href="/kom-i-gang">Kom i gang</Link> : null}
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
          {showBanner ? (
            <div className="banner">
              <span>
                <strong>Du er nesten i gang.</strong> Det tar to minutter å sette opp, og du trenger
                ikke kunne noe om regnskap.
              </span>
              <Link href="/kom-i-gang">Fortsett →</Link>
            </div>
          ) : null}
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
