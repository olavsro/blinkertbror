# Qbikk — automatisk bilagsinnsamling for norske selvstendig næringsdrivende

Dette dokumentet er **overleveringen**. Det beskriver hva systemet er, hvilke valg som er
tatt og hvorfor, nøyaktig hva som er bygget, og nøyaktig hva som gjenstår. En agent som
leser dette skal kunne fortsette uten å stille spørsmål.

Originaloppdraget ligger i [init prompt.txt](init%20prompt.txt). Les det først hvis noe
her er uklart — dette dokumentet utdyper, det erstatter ikke.

---

## 1. Premisset som styrer alt

**Ikke bygg integrasjoner per tjeneste.** De fleste leverandører har ikke API, og en DJ,
en frisør og en dagligvarebutikk har helt ulike leverandører. Fellesnevneren er at bilag
kommer som **dokumenter** (e-postkvitteringer, PDF-fakturaer, papirkvitteringer) og at
pengene alltid vises i **banken**.

Konsekvenser som må holdes i hevd gjennom hele kodebasen:

1. Systemet er **dokument- og transaksjonsdrevet**, ikke API-drevet.
2. Én LLM-basert ekstraktor håndterer alle bransjer. Bransje er **data**, ikke kodevei.
3. Alle inntakskanaler implementerer **samme grensesnitt** (`IngestionChannel`). Alt bak
   det punktet vet ikke hvor et bilag kom fra.
4. Rådokumentet lagres **uendret** og endres aldri. All tolkning er avledet og kan kjøres
   på nytt uten tap.
5. Ingen destruktiv redigering. Korreksjoner er append-only i `corrections`.

---

## 2. Beslutninger som er tatt (ikke omgjør uten å spørre brukeren)

Brukeren fikk fire spørsmål og valgte anbefalt alternativ på alle fire:

| Område | Valg | Begrunnelse |
|---|---|---|
| **E-postinntak** | Managed inbound (Mailgun Routes / Postmark Inbound) som POSTer til webhook. MailHog + bro lokalt. | Slipper å drifte MX, SPF/DKIM, spam og TLS. Samme webhook-kontrakt lokalt og i prod. |
| **Orkestrering** | `pg-boss` i applikasjonen, **ikke n8n** | Jobbkø rett på PostgreSQL vi allerede har. Ingen ekstra container, jobber i samme transaksjon som dataene, typet TypeScript i git, ordentlige stacktraces. n8n gir ingenting her fordi brukeren aldri skal se en flow. |
| **LLM** | Claude via API. `messages.parse()` med zod-skjema. | Leser tekst, PDF **og** bilder i samme kall — ingen separat OCR-pipeline. Strukturert output garanterer skjemaform. |
| **App-arkitektur** | `apps/web` (Next.js App Router) + `apps/worker` (jobbkonsument), delte `packages/*` | Én UI-stack, tunge jobber utenfor request-syklusen. |

Ytterligere forutsetninger som ble kommunisert og godtatt:

- **Domene:** `bilag.minapp.no` som placeholder, konfigurerbart via `INBOUND_EMAIL_DOMAIN`.
- **Beløp:** heltall i øre (`bigint`), aldri float. Egen `Money`-helper i core.
- **ORM:** Drizzle (bedre TS-inferens enn Prisma, SQL-nær, ingen runtime-kodegenerering).
- **Kontoplan:** NS 4102-baserte kontokoder i bransjeprofilene.
- **Auth i v1:** ingen innlogging (én bruker per installasjon), men `user_id` i hele
  skjemaet fra dag én.
- **Valuta:** Norges Banks åpne API, kurs cachet per dato i `fx_rates`.

### Modellvalg — les dette før du endrer det

`EXTRACTION_MODEL` skal stå til **`claude-opus-5`** som standard. Dette er rettet både i
`.env.example` og som default i `config.ts`. Ikke nedgrader modell for å spare penger uten
at brukeren ber om det; kostnadskontroll gjøres via `effort` (står på `"medium"` i
`ClaudeExtractor`) og prompt-caching, ikke via svakere modell.

---

## 3. Stack

| Lag | Valg |
|---|---|
| Språk | TypeScript, ESM (`"type": "module"` overalt), Node ≥ 20.11 |
| Pakkemanager | pnpm workspaces (`pnpm-workspace.yaml`) |
| Database | PostgreSQL 16 (docker-compose, port **5433** på host for å ikke kollidere med lokal Postgres) |
| ORM | Drizzle ORM + drizzle-kit |
| Jobbkø | pg-boss (samme Postgres) |
| LLM | `@anthropic-ai/sdk`, `client.messages.parse()` + `zodOutputFormat` |
| Web | Next.js 15 App Router + React 19 |
| Validering | zod 3 |
| Test | vitest |
| Lokal e-post | MailHog (SMTP 1025, UI 8025) |

---

## 4. Mappestruktur

```
qbikk/
├─ docker-compose.yml          # postgres:5433 + mailhog:1025/8025
├─ .env.example                # alle env-variabler, dokumentert
├─ vitest.config.ts            # tester ligger i tests/, oppsett i tests/setup.ts
│
├─ packages/
│  ├─ db/                      # Drizzle-skjema + klient. Ingen forretningslogikk.
│  ├─ core/                    # Domenet + pipeline. Penger, MVA, valuta, dedup,
│  │                           # matching, kategorisering, normalisering, profiler.
│  ├─ extraction/              # LLM-laget. Claude + regelbasert fallback.
│  ├─ ingestion/               # IngestionChannel + alle seks kanalene + registry.
│  ├─ jobs/                    # pg-boss: jobbnavn, payload-typer, køer, retry.
│  └─ export/                  # SAF-T Financial (XML) + CSV til regnskapsfører.
│
├─ apps/
│  ├─ web/                     # Next.js: dashboard, bilag, handling, kanaler, mva,
│  │                           # webhooks (/api/inbound/email, /api/upload) og eksport.
│  ├─ worker/                  # pg-boss-konsument: ekstraksjon, synk, matching, cron.
│  └─ mcp/                     # MCP-server, 10 verktøy over stdio.
│
├─ scripts/                    # seed, mailhog-bro, demo-e-post, demo-bank, smoke
├─ fixtures/emails/            # fem eksempelbilag (DJ, frisør, dagligvare)
├─ tests/                      # vitest, 112 tester
└─ storage/blobs/              # lokalt blob-lager (gitignored)
```

Avhengighetsretning (**bryt aldri denne**):

```
db  ←  core  ←  extraction
        ↑  ↖
        │    ingestion,  export
        │        ↑
       jobs ─────┘
        ↑
    web / worker / mcp
```

`core` importerer `db` (for typer, `fx.ts`-cachen og pipeline). `extraction`,
`ingestion` og `export` importerer `core`. Ingenting i `packages/` importerer fra
`apps/`.

**`core` importerer ikke `ingestion`.** Pipeline definerer sin egen
`PipelineDocument`, strukturelt lik `DocumentItem`. En kanal produserer noe som
passer; core vet ikke at kanaler finnes. Samme grep for `ExtractorLike`.

---

## 5. Hva som ER bygget

Alt under er skrevet, typesjekket og **kjørt mot en ekte database**. `pnpm
typecheck` er grønn for alle ni pakker, og `pnpm test` gir 112 grønne tester.
Hele veien fra en videresendt e-post til et bilag i UI-et er verifisert
ende-til-ende.

### `packages/db` — komplett

15 tabeller, 7 enums, relasjoner og inferte typer i `src/schema.ts` (599 linjer).
`createDb()` / `getDb()` med globalThis-cache for Next.js hot reload.
Skjemaet er pushet med `drizzle-kit push` og verifisert i Postgres.

**Fem invarianter som er kodet inn — ikke bryt dem:**

1. `raw_documents` og `attachments` er append-only. Unique index på
   `(user_id, content_sha256)` er første forsvarslinje mot dubletter.
2. `extractions` er versjonert. Ny kjøring = ny rad; gammel får `superseded_at`.
   Aldri UPDATE på en ekstraksjon.
3. `vouchers.dedup_hash` har unique index på `(user_id, dedup_hash)`. Hashen
   inneholder `origin` (`"bank"` / `"document"`) **med vilje**, slik at bankbilag
   og dokumentbilag for samme kjøp kan eksistere samtidig og bli matchet.
4. Alle beløp er `bigint` i **øre**. Aldri numeric, aldri float.
5. `corrections` er revisjonssporet. Ingen rad slettes eller oppdateres.

### `packages/core` — komplett

`money`, `vat`, `text`, `dedup`, `matching`, `fx`, `crypto`, `storage`,
`contract`, `categorize`, `normalize`, `config`, `profiles/` — som før.

**Nytt: `env.ts`** — laster `.env` fra roten av monorepoet. `dotenv/config`
leser fra `process.cwd()`, og både worker og web starter i sin egen katalog.
Eksporteres bevisst **ikke** fra `index.ts`; den leser filsystemet.

**Nytt: `pipeline.ts` — limet.** Alle skriveveier i systemet går gjennom disse:

| Funksjon | Ansvar |
|---|---|
| `storeRawDocument()` | Lagre uendret. Idempotent på sha256, håndterer skrivekappløp. |
| `runExtraction()` | Tolk med LLM. Ny rad, forrige får `superseded_at`. Mislykkede forsøk lagres, men merkes superseded med en gang. |
| `upsertVoucher()` | Normaliser til bilag. Hard dedup på `dedup_hash`; konflikt er et normalt utfall, ikke en feil. |
| `upsertBankTransaction()` | Banktransaksjon → bilag uten dokumentasjon. Gjetter aldri MVA. |
| `proposeMatches()` | Foreslå kobling. Fungerer fra begge sider. Auto-kobler bare det utvilsomme. |
| `mergeMatched()` | Slå bank + dokument til ett. Dokumentet overlever, bankbilaget merkes `duplicate`. Ingenting slettes. |
| `rejectMatch()` | Avvis et forslag. Bilagene røres ikke. |
| `applyCorrection()` | Rett ett felt. Skriver til `corrections` og lærer en regel der det gir mening. |
| `createManualVoucher()` | Manuelt bilag gjennom **samme** `normalizeDocument()` — samme dedup, samme kategorisering. |
| `attachDocumentToVoucher()` | Legg dokumentasjon på et bankbilag. |
| `loadUserContext()` / `loadRules()` | Profil + regler i ett oppslag. |

### `packages/extraction` — komplett

Som før. **Merk:** `contract.ts` i core importerer fra `zod/v4`, ikke `zod` —
`zodOutputFormat()` i SDK-en krever et v4-skjema. zod 3.25 leverer begge API-ene
side om side, så resten av kodebasen står på det klassiske. Flytter du importen
tilbake, slutter `messages.parse()` å typesjekke.

### `packages/ingestion` — komplett, alle seks kanaler

| Fil | Innhold |
|---|---|
| `types.ts` | `IngestionChannel`-grensesnittet. `configSchema` har input-type `unknown`, slik at kanaler kan bruke `.default()`. |
| `registry.ts` | **Det eneste stedet som vet hvilke kanaler som finnes.** |
| `channels/email-forward.ts` | Kanal 1. Push. Mailgun/Postmark/MailHog normaliseres til `InboundEmail`. HMAC- og delt-hemmelighet-verifisering. |
| `channels/inbox-scan.ts` | Kanal 2. IMAP/Gmail bakoversøk. Cursor `(uidValidity, lastUid)` — endres UIDVALIDITY, tas full backfill. `imapflow`/`mailparser` importeres dynamisk. |
| `channels/bank-gocardless.ts` | Kanal 3. PSD2, bare `fetch`. Token caches 24 t. 401/403 → `ChannelAuthError`. Kun `booked`-transaksjoner. Beløp via streng, aldri `parseFloat`. |
| `channels/file-upload.ts` | Kanal 4a. Push. Én fil = ett bilag. |
| `channels/folder-watch.ts` | Kanal 4b. Lokal driver ferdig; Dropbox/Drive er samme `FolderDriver`-grensesnitt og kaster eksplisitt til de er skrevet. |
| `channels/browser.ts` | Kanal 5. `fragile: true`. **Samtykke per portal er en bryter i koden**, ikke en kommentar: uten `consentedAt` kaster `pull()`. Lagrer aldri passord — bare sesjonscookies med utløp. `minHoursBetweenRuns` håndheves. Selve browseren ligger bak `PortalDriver` og er ikke implementert. |

### `packages/jobs` — komplett

`JOBS`-navn bundet til `JobPayloads` via typede `sendJob()`/`workJob()`, så feil
payload er en kompileringsfeil. Retry-policy per kø i `QUEUE_DEFS`.
Skjøre kanaler har **egen kø** (`channel.sync.fragile`, `policy: singleton`,
ett forsøk, 15 min pause) og kan aldri blokkere bank- og e-postsynken.
`channel.schedule` er cron-fordeleren: pg-boss sin cron kan bare sende én fast
payload, så den jobben slår opp aktive kanaler og sender én synkjobb per kanal.

> **Rekkefølgen på kø-opprettelsen betyr noe.** pg-boss har en fremmednøkkel fra
> `queue.dead_letter` til `queue.name`. `createQueue()` oppretter derfor alle
> dead letter-mål først. Fjerner du den sorteringen, feiler oppstarten.

### `packages/export` — komplett

SAF-T Financial (XML) + to CSV-varianter. Begge formatene bygger på **samme**
`postingsFor()`, så de kan ikke regne ulikt. `checkBalanced()` er kontrollsummen;
eksportruta nekter å levere en SAF-T-fil som ikke går i null.

Motkontoen (2400 leverandørgjeld / 1500 kundefordringer) er en **antakelse**, og
den står skrevet i `<Description>` på hver transaksjon slik at regnskapsføreren
ser den. **Filen er ikke validert mot den offisielle XSD-en** — gjør det før
noen sender den inn på ekte.

### `apps/worker` — komplett

pg-boss-konsument. Eneste prosess med `supervise` og `schedule` på.
`runChannelSync()` dekrypterer konfig, kjører `pull()`, lagrer, flytter cursor og
skriver `sync_runs`. Skillet mellom feiltypene er poenget:

- `ChannelAuthError` → kanalen merkes `needs_auth`, og **jobben anses som
  fullført**. Å retrye hver time i tre uker hjelper ikke når brukeren må logge
  inn, og det ville fylt dead letter-køen med støy som skjuler ekte feil.
- alt annet → kastes videre, pg-boss retryer med backoff.

### `apps/web` — komplett

| Rute | Innhold |
|---|---|
| `/` | Inntekt vs. utgift per måned, per kategori, per kanal. CSS-stolper, ingen chart-bibliotek. |
| `/bilag` | Filter, fritekstsøk, kategori endres inline. |
| `/bilag/[id]` | Alle felter redigerbare, varelinjer, **korreksjonshistorikk**, rådokument. |
| `/handling` | Foreslåtte koblinger, bank uten kvittering, lav confidence, kanaler som har stoppet. |
| `/kanaler` | Status, test, synk, backfill, pause. Leser registret — en ny kanal dukker opp uten at fila endres. |
| `/mva` | Per termin, med **egen seksjon** for omvendt avgiftsplikt + eksportlenker. |
| `/api/inbound/email` | Webhooken. Signatur → normaliser → slå opp slug → kanal → lagre → køe → 200. |
| `/api/upload` | Kanal 4a. Samme form som e-postruta under overflaten. |
| `/api/eksport/[format]` | `saft`, `csv`, `enkel`. |

Tre ting det er lett å tråkke i:

1. **Alt er serverkomponenter uten en linje klient-JavaScript.** Server actions
   må derfor returnere `void` — `<form action={fn}>` godtar ikke annet.
   Tilbakemelding går via `lib/flash.ts` (kortlevd cookie), ikke `useActionState`.
2. **`next.config.ts` setter `resolve.extensionAlias`.** Workspace-pakkene bruker
   `.js`-endelser i importene sine (som ESM krever) mens filene er `.ts`. Uten
   dette feiler bygget på «Can't resolve ./vat.js».
3. **Klientkomponenter må importere fra undermoduler** (`@qbikk/core/money`),
   ikke fra `@qbikk/core` — hovedindeksen drar inn `fx.ts` og `pipeline.ts`,
   som importerer `postgres`.

### `apps/mcp` — komplett

Ti verktøy over stdio: `search_vouchers`, `get_voucher`, `list_action_items`,
`vat_summary`, `channel_status`, `create_voucher`, `attach_document`,
`correct_voucher`, `propose_match`, `confirm_match`.

**Ingen av dem skriver til databasen selv** — alle kaller pipeline-funksjonene.
Derfor *kan* de ikke omgå dedup, korreksjonshistorikk eller matchereglene.
Verifisert: `create_voucher` to ganger med samme data returnerer det
eksisterende bilaget. Legger noen inn et `db.insert(vouchers)` her, er det den
endringen som skal stoppes i review.

`propose_match` og `confirm_match` er bevisst adskilt: en agent kan foreslå,
men å slå to bilag sammen krever et eget, eksplisitt kall.

### Tester — 112, alle grønne

`tests/setup.ts` mocker bort `fx.ts`, så ingen test rører nett eller database.

| Fil | Dekker |
|---|---|
| `profiles.test.ts` | **Kravet fra oppdraget:** DJ og frisør gjennom nøyaktig samme `normalizeDocument()`-kall, med assert på at det eneste som skiller er kategori og kontokode. |
| `direction.test.ts` | Beatport som utgift og som inntekt. Retning fra dokumentet, ikke navnet. |
| `dedup.test.ts` | Samme kvittering fra to kanaler → ett bilag. Bank + kvittering → to bilag. |
| `matching.test.ts` | Tvetydig match blir foreslått, ikke utført. |
| `money` / `vat` / `fx` | Beløpsformater, MVA-satser og terminer, `UNIT_MULT=2`. |
| `channels.test.ts` | Signaturverifisering, registret, valg av hovedvedlegg. |
| `export.test.ts` | Debet = kredit, XML-escaping, CSV-formatering. |

---

## 6. Hva som GJENSTÅR

Alt fra den opprinnelige lista er bygget. Det som står igjen er reelt nytt arbeid:

### 6.1 Ekte kjøring med `ANTHROPIC_API_KEY`

Systemet er kjørt ende-til-ende på `HeuristicExtractor`. `ClaudeExtractor` er
skrevet og typesjekket, men **aldri kalt mot API-et**. Sett nøkkelen og kjør
`pnpm demo:email alle` — forvent at kvaliteten hopper (heuristikken bommer bl.a.
på totalen i frisørfakturaen og finner ikke selgers land, som er det som utløser
omvendt avgiftsplikt). Ikke «fiks» heuristikken ved å gjette bedre; det er
meningen at den skal sende alt til gjennomgang.

### 6.2 Kanaler som trenger ekte legitimasjon for å testes

`inbox-scan` (IMAP) og `bank-gocardless` (PSD2) er skrevet mot dokumentasjonen,
men aldri kjørt mot en ekte server. Første kjøring vil sannsynligvis avdekke
detaljer i `imapflow`-søkesyntaksen og i GoCardless sitt transaksjonsformat.
`pnpm demo:bank` går inn på `upsertBankTransaction` og dekker alt *etter*
kanalen, så matchingen er verifisert uansett.

### 6.3 Portaldrivere til kanal 5

`BrowserChannel` har grensesnittet, samtykkesperren og minimeringen. Selve
`PortalDriver` er ikke skrevet for noen portal. En MCP-server med browserverktøy
i egen prosess passer godt — da er skjørheten isolert to ganger.

### 6.4 Dropbox- og Drive-drivere

`FolderDriver`-grensesnittet finnes, `localFolderDriver` er ferdig.
`driverFor()` kaster eksplisitt for de to andre, i stedet for å late som
kanalen virker.

### 6.5 SAF-T mot offisiell XSD

Filen er velformet og går i null, men er ikke validert mot Skatteetatens skjema.
Gjør det før noen bruker den på ekte.

### 6.6 Auth og flere brukere

`user_id` er i hele skjemaet og i alle spørringer. `currentUser()` i
`apps/web/src/lib/data.ts` og `requireUserId()` i `apps/mcp/src/index.ts` er de
**to** stedene som slår fast hvem «vi» er. Når auth skal inn, byttes de ut.
Det finnes fortsatt ingen RLS i databasen.

---

## 7. Konvensjoner en agent må følge

- **Norsk i kommentarer, brukertekst og UI. Engelsk i kode-identifikatorer.**
- Kommentarer forklarer **hvorfor**, ikke hva. Se eksisterende filer for tonen.
- Ingen `any`. `tsconfig.base.json` har `strict` og `noUncheckedIndexedAccess`.
- Beløp: bruk `@qbikk/core/money`. Aldri `parseFloat` på et beløp.
- Datoer: ISO `YYYY-MM-DD` som string for bilagsdatoer, `Date` kun for tidspunkter.
- Nye kanaler: én fil i `packages/ingestion/src/channels/`, registrer i et registry.
  **Ingen andre filer skal endres.** Hvis du må endre noe annet, er abstraksjonen feil —
  fiks abstraksjonen.
- Nye bransjer: én fil i `packages/core/src/profiles/`. Ren data. Ingen kodevei.
- Hemmeligheter: alltid gjennom `encryptJson()`. Aldri klartekst i `config_meta`.

### Praktisk om verktøybruk i dette repoet

Å skrive store TypeScript-filer via bash-heredoc feiler i dette miljøet (Git Bash på
Windows kveler på enkelte unicode-sekvenser). **Bruk Write-verktøyet for kildefiler.**
Kombinerende diakritiske tegn i regex maa skrives som escape-sekvenser
(`̀-ͯ`), ikke som literale tegn - det er allerede rettet i `text.ts` og
`config.ts`, ikke gjor det om.
---

---

## 8. Kjør lokalt

```bash
cp .env.example .env
# generer ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# valgfritt, men anbefalt: sett ANTHROPIC_API_KEY

docker compose up -d          # postgres:5433, mailhog:1025/8025
pnpm install
pnpm db:push
pnpm seed                     # én bruker + bilagsadresse + kategoriregler
pnpm dev                      # web på :3000, worker parallelt

# i et eget vindu - broen som gjør MailHog om til produksjonswebhooken:
pnpm mailhog:bridge

# og så, i et tredje:
pnpm demo:email alle          # sender de fem fixturene inn via SMTP
pnpm demo:bank                # syntetiske banktrekk -> viser matching
```

Andre nyttige kommandoer:

```bash
pnpm test                     # 112 tester, ingen nett- eller databasekall
pnpm typecheck                # alle ni pakker
pnpm smoke <fixture>          # kjører én fixture gjennom pipeline og skriver ut bilaget
pnpm mcp                      # MCP-serveren på stdio
pnpm db:studio                # Drizzle Studio mot databasen
```

Uten `ANTHROPIC_API_KEY` kjører systemet på `HeuristicExtractor`, og alle bilag
havner i gjennomgangskøen. **Det er riktig oppførsel — ikke «fiks» det ved å
gjette bedre.**

---

## 9. Åpne spørsmål til brukeren

Ikke blokkerende, men bør avklares før produksjon:

1. **Domene for bilagsadressene** — `bilag.minapp.no` er fortsatt en placeholder.
   Hvilket domene skal brukes, og er det tilgjengelig for MX-oppsett hos
   Mailgun/Postmark?
2. **GoCardless-konto** — er den opprettet? Secret ID/key trengs før kanal 3 kan
   testes mot en ekte bank.
3. **Oppbevaring av rådokumenter** — lokalt filsystem holder i utvikling. I
   produksjon må bilag ligge trygt i fem år: S3 med versjonering og object lock,
   eller tilsvarende. `BlobStore`-grensesnittet er klart; `getBlobStore()` kaster
   eksplisitt for `BLOB_DRIVER=s3` til noen implementerer den.
4. **Flere brukere** — se punkt 6.6.
5. **Kostnadstak på ekstraksjon** — det finnes ingen grense i dag. En backfill
   over fem år kan bli mange tusen LLM-kall. Bør det være et tak per døgn, eller
   en bekreftelse før en stor backfill settes i gang?
