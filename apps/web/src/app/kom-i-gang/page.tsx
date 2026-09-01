/**
 * «Kom i gang» - veiviseren brukeren møter før det finnes data.
 *
 * SPRÅKREGELEN FOR DENNE SIDA: ingen fagord. Ikke «bilag», ikke «kanal»,
 * ikke «synkronisering», ikke «inngående merverdiavgift». Brukeren er en
 * frisør eller en DJ, ikke en regnskapsfører - de vet hva en kvittering er,
 * og det holder. Fagordene finnes i resten av appen, der de trengs for å
 * snakke med en regnskapsfører. Her er de bare i veien.
 *
 * Ett steg av gangen: de ferdige er sammenklappet med en hake, det man står
 * på er åpent, og de som kommer er nedtonet. Det gjør det umulig å lure på
 * hva man skal gjøre nå.
 */
import Link from "next/link";
import { inboundAddress } from "@qbikk/core/config";
import { chooseTrade, finishOnboarding } from "@/lib/actions";
import { currentUser } from "@/lib/data";
import { currentStep, loadOnboardingStatus, TRADES, tradeTitle } from "@/lib/onboarding";
import { AddressCard } from "./address-card";

export const dynamic = "force-dynamic";

export default async function GetStartedPage() {
  const user = await currentUser();
  if (!user) return <NoUser />;

  const status = await loadOnboardingStatus(user);
  const step = currentStep(status);
  const address = inboundAddress(user.inboundSlug);

  return (
    <>
      <h1>Kom i gang</h1>
      <p className="lede">
        Fire korte steg, så samler vi kvitteringene dine av seg selv. Du trenger ikke kunne noe om
        regnskap.
      </p>

      <ProgressBar step={step} />

      {/* ---------------------------------------------------------- steg 1 */}
      <Step
        number={1}
        title="Hva slags arbeid gjør du?"
        done={status.choseTrade}
        active={step === 1}
        summary={status.choseTrade ? tradeTitle(user.profile) : undefined}
      >
        <p>
          Vi bruker svaret til å gjette riktig når vi skal sortere kjøpene dine. En DJ kjøper andre
          ting enn en frisør. Du kan bytte når som helst, og ingenting går tapt.
        </p>
        <div className="trade-grid">
          {TRADES.map((trade) => (
            <form action={chooseTrade} key={trade.key}>
              <input type="hidden" name="trade" value={trade.key} />
              <button
                type="submit"
                // `generic` er BÅDE et gyldig valg og standardverdien for
                // «har ikke svart ennå». Uten choseTrade-sjekken ser
                // «Noe helt annet» ut som allerede valgt for en fersk bruker.
                className={`trade-card${
                  status.choseTrade && user.profile === trade.key ? " chosen" : ""
                }`}
              >
                <span className="trade-emoji">{trade.emoji}</span>
                <span className="trade-title">{trade.title}</span>
                <span className="trade-blurb">{trade.blurb}</span>
              </button>
            </form>
          ))}
        </div>
      </Step>

      {/* ---------------------------------------------------------- steg 2 */}
      <Step
        number={2}
        title={status.receivedFirst ? "E-postadressen din virker" : "Her er din egen e-postadresse"}
        done={status.receivedFirst}
        active={step === 2 || step === 3}
        summary={status.receivedFirst ? address : undefined}
      >
        <p>
          Alt du sender hit blir lest og lagt inn for deg. Adressen er din alene - du trenger ikke
          logge inn noe sted, og du trenger ikke gjøre noe mer enn å sende.
        </p>

        <AddressCard address={address} waiting={!status.receivedFirst} />

        <h3>Slik bruker du den</h3>
        <ol className="how-to">
          <li>
            <strong>Videresend kvitteringer du får på e-post.</strong> Får du en kvittering fra en
            nettbutikk, trykk «videresend» og send den hit. Det er alt.
          </li>
          <li>
            <strong>La e-posten din gjøre det automatisk.</strong> I Gmail eller Outlook kan du lage
            én regel: «send alt som inneholder ordet kvittering eller faktura videre til denne
            adressen». Da slipper du å tenke på det igjen.
          </li>
          <li>
            <strong>Oppgi adressen der du handler fast.</strong> Betaler du for strøm, programvare
            eller varer hver måned, kan du skrive denne adressen som fakturamottaker. Da kommer
            regningen rett inn.
          </li>
        </ol>

        <p className="small muted">
          Har du en kvittering på papir? Ta et bilde av den og send bildet til samme adresse. Vi
          leser bilder like godt som tekst.
        </p>
      </Step>

      {/* ---------------------------------------------------------- steg 3 */}
      <Step
        number={3}
        title={
          // Tittelen må skifte når steget er ferdig. «Vi venter...» med en
          // hake ved siden av er selvmotsigende og får folk til å lure på om
          // noe henger.
          status.receivedFirst ? "Den første kvitteringen kom fram" : "Vi venter på den første kvitteringen"
        }
        done={status.receivedFirst}
        active={step === 3}
        summary={
          status.receivedFirst
            ? `${status.documentCount} ${status.documentCount === 1 ? "kvittering" : "kvitteringer"} kommet inn`
            : undefined
        }
      >
        {status.receivedFirst ? (
          <p>
            Den kom fram. Vi har lest {status.documentCount === 1 ? "den" : "dem"} og laget{" "}
            {status.voucherCount} {status.voucherCount === 1 ? "oppføring" : "oppføringer"} du kan se
            under <Link href="/bilag">Bilag</Link>.
          </p>
        ) : (
          <>
            <p className="waiting">
              <span className="pulse" /> Venter... Send en kvittering til adressen over, så dukker
              den opp her av seg selv. Du trenger ikke oppdatere siden.
            </p>
            <p className="small muted">
              Det tar vanligvis noen sekunder. Har du ikke en kvittering for hånd? Send en helt
              vanlig e-post til deg selv med et beløp i, og videresend den hit - så ser du hvordan
              det virker.
            </p>
          </>
        )}
      </Step>

      {/* ---------------------------------------------------------- steg 4 */}
      <Step
        number={4}
        title="Vil du ha med det gamle også?"
        done={status.addedMoreSources}
        active={step === 4}
        optional
      >
        <p>
          Dette er frivillig, og du kan gjøre det senere. Fra nå av fanger vi opp alt du sender inn.
          Men det ligger som regel mye i innboksen fra før, og pengene som allerede har gått ut av
          kontoen din finnes bare i banken.
        </p>

        <div className="source-grid">
          <div className="source-card">
            <div className="source-title">📬 Let i e-posten min</div>
            <p className="small">
              Vi ser gjennom innboksen din etter gamle kvitteringer og fakturaer, og henter bare
              dem. Resten av e-posten din rører vi ikke.
            </p>
            <Link href="/kanaler">Sett opp</Link>
          </div>
          <div className="source-card">
            <div className="source-title">🏦 Koble til banken</div>
            <p className="small">
              Da ser du hva som faktisk er betalt, og vi sier fra når en kvittering mangler. Vi får
              bare lese - vi kan aldri flytte penger.
            </p>
            <Link href="/kanaler">Sett opp</Link>
          </div>
          <div className="source-card">
            <div className="source-title">📁 Følg med på en mappe</div>
            <p className="small">
              Legger du kvitteringer i en mappe fra før, kan vi hente nye filer derfra automatisk.
            </p>
            <Link href="/kanaler">Sett opp</Link>
          </div>
        </div>
      </Step>

      {/* ------------------------------------------------------------ slutt */}
      <div className="panel finish">
        <div>
          <strong>{status.receivedFirst ? "Du er i gang." : "Du kan avslutte når som helst."}</strong>
          <div className="small muted">
            {status.receivedFirst
              ? "Alt som kommer inn fra nå av havner under «Bilag». Er vi usikre på noe, sier vi fra under «Krever handling» - vi gjetter aldri på tall."
              : "Veiviseren blir liggende her til du er ferdig. Du finner den igjen øverst på forsiden."}
          </div>
        </div>
        <form action={finishOnboarding}>
          <button type="submit" className="primary">
            {status.receivedFirst ? "Ta meg til oversikten" : "Hopp over for nå"}
          </button>
        </form>
      </div>
    </>
  );
}

/* ------------------------------------------------------------ byggeklosser */

function ProgressBar({ step }: { step: number }) {
  const labels = ["Om deg", "Adressen din", "Første kvittering", "Mer å hente"];
  return (
    <ol className="progress">
      {labels.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "active" : "todo";
        return (
          <li key={label} className={state}>
            <span className="dot">{state === "done" ? "✓" : n}</span>
            <span className="label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Step({
  number,
  title,
  done,
  active,
  optional,
  summary,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  active: boolean;
  optional?: boolean;
  summary?: string;
  children: React.ReactNode;
}) {
  // Ferdige steg klappes sammen til én linje. Da ser brukeren hva som er
  // gjort uten at det stjeler plass fra det de skal gjøre nå.
  const collapsed = done && !active;

  return (
    <section className={`step${active ? " active" : ""}${done ? " done" : ""}`}>
      <div className="step-head">
        <span className="step-num">{done ? "✓" : number}</span>
        <h2>{title}</h2>
        {optional ? <span className="pill">frivillig</span> : null}
      </div>
      {collapsed ? (
        summary ? (
          <div className="step-summary">{summary}</div>
        ) : null
      ) : (
        <div className="step-body">{children}</div>
      )}
    </section>
  );
}

function NoUser() {
  return (
    <>
      <h1>Nesten klar</h1>
      <p className="lede">Det mangler en konto å legge kvitteringene på.</p>
      <div className="panel">
        <p>Kjør denne kommandoen i prosjektmappa, så er alt på plass:</p>
        <pre>
          <code>pnpm seed</code>
        </pre>
      </div>
    </>
  );
}
