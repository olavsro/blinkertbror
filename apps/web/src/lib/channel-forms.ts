import "server-only";
import type { ChannelType } from "@qbikk/ingestion";

/**
 * Skjemaene brukeren fyller ut for å koble til en kilde.
 *
 * HVORFOR DETTE IKKE UTLEDES AV `configSchema`:
 * zod-skjemaet vet at feltet heter `secretId` og er en streng. Det vet ikke at
 * det skal hete «Nøkkel-ID» i UI-et, at brukeren finner den i GoCardless sitt
 * kontrollpanel, eller at den er hemmelig og aldri skal vises igjen. Et
 * autogenerert skjema ville gitt en feltliste ingen forstår.
 *
 * Konsekvensen for konvensjonen «ny kanal = én fil»: kanalen VIRKER fullt ut
 * uten en oppføring her - den kan settes opp fra et script og kjører som alle
 * andre. Den kan bare ikke settes opp fra nettsida før noen har skrevet noen
 * linjer her. `formFor()` returnerer null i mellomtiden, og UI-et sier fra i
 * stedet for å vise et ødelagt skjema.
 */

export interface FieldSpec {
  name: string;
  label: string;
  /** Kort forklaring under feltet. Skal kunne leses av noen uten IT-bakgrunn. */
  help?: string;
  type: "text" | "password" | "number" | "email" | "url" | "checkbox";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  /** Sann for felter som må krypteres. Vises aldri tilbake til brukeren. */
  secret?: boolean;
}

export interface PresetSpec {
  key: string;
  label: string;
  /** Verdier som fylles inn automatisk når presettet velges. */
  values: Record<string, string>;
}

export interface ChannelForm {
  type: ChannelType;
  title: string;
  /** Én setning om hva brukeren får ut av å koble til dette. */
  promise: string;
  /** Det brukeren bør vite FØR de fyller ut noe. */
  before?: string[];
  presets?: { field: string; label: string; options: PresetSpec[] };
  fields: FieldSpec[];
  /** Sann når oppsettet ikke er ferdig etter innsending (banken, portaler). */
  twoStep?: boolean;
  /** Satt når kanalen ikke kan tas i bruk ennå, med en ærlig forklaring. */
  unavailable?: string;
}

const FORMS: Partial<Record<ChannelType, ChannelForm>> = {
  inbox_scan: {
    type: "inbox_scan",
    title: "Let i e-posten min",
    promise:
      "Vi finner gamle kvitteringer og fakturaer som allerede ligger i innboksen din, så du slipper å lete dem opp selv.",
    before: [
      "Vi søker bare etter e-post som inneholder ord som «kvittering», «faktura», «receipt» eller «invoice». Resten av innboksen din leser vi ikke.",
      "Bruk et app-passord, ikke hovedpassordet ditt. Da kan du trekke tilbake tilgangen vår uten å bytte passord.",
    ],
    presets: {
      field: "host",
      label: "Hvor har du e-posten din?",
      options: [
        { key: "gmail", label: "Gmail", values: { host: "imap.gmail.com", port: "993" } },
        { key: "outlook", label: "Outlook / Hotmail", values: { host: "outlook.office365.com", port: "993" } },
        { key: "icloud", label: "iCloud", values: { host: "imap.mail.me.com", port: "993" } },
        { key: "other", label: "Noe annet", values: { host: "", port: "993" } },
      ],
    },
    fields: [
      {
        name: "host",
        label: "Serveradresse",
        help: "Fylles ut automatisk hvis du velger over. Ellers finner du den hos e-postleverandøren din.",
        type: "text",
        required: true,
        placeholder: "imap.gmail.com",
      },
      { name: "port", label: "Port", type: "number", defaultValue: "993" },
      { name: "user", label: "E-postadressen din", type: "email", required: true, placeholder: "navn@gmail.com" },
      {
        name: "pass",
        label: "App-passord",
        help: "IKKE ditt vanlige passord. Lag et app-passord i innstillingene hos e-postleverandøren din. Vi lagrer det kryptert.",
        type: "password",
        required: true,
        secret: true,
      },
      {
        name: "backfillMonths",
        label: "Hvor langt tilbake skal vi lete?",
        help: "Antall måneder. 24 er som regel nok for regnskapet.",
        type: "number",
        defaultValue: "24",
      },
    ],
  },

  folder_watch: {
    type: "folder_watch",
    title: "Følg med på en mappe",
    promise: "Legger du kvitteringer i en mappe fra før, henter vi nye filer derfra automatisk.",
    before: [
      "Vi flytter og sletter aldri noe. Filene dine blir liggende der de er - vi tar bare en kopi til arkivet.",
      "Foreløpig virker dette bare for mapper på denne maskinen. Dropbox og Google Drive kommer.",
    ],
    fields: [
      {
        name: "path",
        label: "Hvilken mappe?",
        help: "Full sti til mappa, for eksempel /Users/deg/Documents/Kvitteringer",
        type: "text",
        required: true,
        placeholder: "/Users/deg/Documents/Kvitteringer",
      },
      {
        name: "maxDepth",
        label: "Skal vi se i undermapper?",
        help: "1 = bare mappa selv. 2 = også ett nivå ned. Maks 5.",
        type: "number",
        defaultValue: "2",
      },
    ],
  },

  bank: {
    type: "bank",
    title: "Koble til banken",
    promise:
      "Da ser du hva som faktisk er betalt, og vi sier fra når en kvittering mangler til en betaling.",
    before: [
      "Vi får BARE lese. Vi kan aldri flytte penger, opprette betalinger eller endre noe i kontoen din.",
      "Du logger inn i din egen nettbank for å godkjenne. Vi ser aldri passordet ditt.",
      "Godkjenningen varer i 90 dager. Det er en regel i loven (PSD2), ikke noe vi har funnet på. Vi sier fra når den går ut.",
      "Du trenger en konto hos GoCardless Bank Account Data. Den er gratis, men du må opprette den selv og hente to nøkler derfra.",
    ],
    twoStep: true,
    fields: [
      {
        name: "secretId",
        label: "Nøkkel-ID",
        help: "Fra GoCardless. Logg inn der, gå til «User secrets», og kopier «Secret ID».",
        type: "text",
        required: true,
        secret: true,
      },
      {
        name: "secretKey",
        label: "Hemmelig nøkkel",
        help: "Samme sted. «Secret Key». Denne vises bare én gang hos dem, så ta vare på den.",
        type: "password",
        required: true,
        secret: true,
      },
    ],
  },

  browser: {
    type: "browser",
    title: "Logg inn på en nettside for meg",
    promise:
      "Noen leverandører sender hverken e-post eller lar deg eksportere. Da kan vi hente fakturaen fra nettsida deres.",
    before: [
      "Dette er siste utvei. Prøv e-post, innbokssøk og bank først - de er mye mer pålitelige.",
      "Mange nettsider forbyr automatisk innlogging i vilkårene sine. Du må lese dem og godta selv, for hver enkelt side.",
      "Vi lagrer aldri passordet ditt. Du logger inn selv én gang, og vi bruker den innloggingen til den går ut.",
    ],
    // Skjemaet finnes, men det er ingen som kan utføre selve innloggingen ennå.
    // Å la brukeren fylle det ut og så oppdage at ingenting skjer, ville vært
    // verre enn å si det rett ut.
    unavailable:
      "Vi har ikke bygget ferdig denne ennå. Rammeverket er på plass, men det mangler en «sjåfør» som kan klikke seg gjennom hver enkelt nettside. Bruk e-post eller opplasting i mellomtiden.",
    fields: [
      { name: "portal", label: "Hva heter nettsida?", type: "text", required: true, placeholder: "Strømleverandøren" },
      { name: "loginUrl", label: "Innloggingsside", type: "url", required: true, placeholder: "https://..." },
    ],
  },

  file_upload: {
    type: "file_upload",
    title: "Last opp filer selv",
    promise:
      "Dra inn PDF-er, skjermbilder eller bilder av papirkvitteringer når du har dem. Ingen oppsett nødvendig.",
    fields: [],
  },
};

export function formFor(type: string): ChannelForm | null {
  return FORMS[type as ChannelType] ?? null;
}

/** Kanaltypene brukeren kan sette opp selv fra nettsida. */
export function setupableTypes(): ChannelType[] {
  return Object.keys(FORMS) as ChannelType[];
}
