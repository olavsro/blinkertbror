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

`EXTRACTION_MODEL` skal stå til **`claude-opus-5`** som standard. `.env.example` sier
per nå `claude-sonnet-5` — **det er en rest fra før modellvalget ble avklart og skal
rettes** (se punkt 6.0). Ikke nedgrader modell for å spare penger uten at brukeren ber om
det; kostnadskontroll gjøres via `effort` (står på `"medium"` i `ClaudeExtractor`) og
prompt-caching, ikke via svakere modell.

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
├─ docker-compose.yml          # postgres + mailhog
├─ .env.example                # alle env-variabler, dokumentert
├─ pnpm-workspace.yaml
├─ tsconfig.base.json          # strict, noUncheckedIndexedAccess
│
├─ packages/
│  ├─ db/                      # Drizzle-skjema + klient. Ingen forretningslogikk.
│  ├─ core/                    # Domenet. Penger, MVA, valuta, dedup, matching,
│  │                           # kategorisering, normalisering, bransjeprofiler.
│  ├─ extraction/              # LLM-laget. Claude + regelbasert fallback.
│  ├─ ingestion/               # IngestionChannel-grensesnittet + kanalene.
│  └─ jobs/                    # (IKKE LAGET ENNÅ) pg-boss-kø, jobbnavn, payload-typer
│
├─ apps/
│  ├─ web/                     # (IKKE LAGET ENNÅ) Next.js: dashboard + webhooks
│  ├─ worker/                  # (IKKE LAGET ENNÅ) pg-boss-konsument
│  └─ mcp/                     # (IKKE LAGET ENNÅ) MCP-server
│
├─ scripts/                    # (TOM) seed, mailhog-bro, demo-e-post
├─ fixtures/                   # (TOM) eksempelbilag for DJ og frisør
└─ storage/blobs/              # lokalt blob-lager (gitignored)
```

Avhengighetsretning (**bryt aldri denne**):

```
db  ←  core  ←  extraction
        ↑  ↖
        │    ingestion
        │        ↑
       jobs ─────┘
        ↑
    web / worker / mcp
```

`core` importerer `db` (for typer og for `fx.ts`-cachen). `extraction` og `ingestion`
importerer `core`. Ingenting i `packages/` importerer fra `apps/`.

---

## 5. Hva som ER bygget

Alle filene under er ferdigskrevet og kommentert. **Ingen av dem er kjørt ennå** —
`pnpm install` er ikke gjort, databasen er ikke opprettet. Se punkt 6.0.

### `packages/db` — komplett

| Fil | Innhold |
|---|---|
| `src/schema.ts` (599 linjer) | **Hele datamodellen.** 15 tabeller + 7 enums + relasjoner + inferte typer. |
| `src/client.ts` | `createDb()` / `getDb()` med globalThis-cache for Next.js hot reload. |
| `src/index.ts` | Re-eksporterer skjema, klient og Drizzle-operatorer (`eq`, `and`, `desc` …). |
| `drizzle.config.ts` | Peker på `src/schema.ts`, dialect postgres. |

**Tabellene:**

`users`, `ingestion_channels`, `raw_documents`, `attachments`, `extractions`,
`counterparties`, `counterparty_aliases`, `vouchers`, `voucher_lines`,
`bank_transactions`, `voucher_matches`, `category_rules`, `corrections`, `sync_runs`,
`fx_rates`.

**Fem invarianter som er kodet inn i skjemaet — ikke bryt dem:**

1. `raw_documents` og `attachments` er append-only. Unique index på
   `(user_id, content_sha256)` er første forsvarslinje mot dubletter.
2. `extractions` er versjonert. Ny kjøring = ny rad; gammel rad får `superseded_at`.
   Aldri UPDATE på en ekstraksjon.
3. `vouchers.dedup_hash` har unique index på `(user_id, dedup_hash)`. Hashen inneholder
   `origin` (`"bank"` / `"document"`) **med vilje**, slik at bankbilag og dokumentbilag
   for samme kjøp kan eksistere samtidig og bli matchet. Uten det ville den andre
   importen blitt stille avvist av indeksen.
4. Alle beløp er `bigint` i **øre**. Aldri numeric, aldri float.
5. `corrections` er revisjonssporet. Ingen rad slettes eller oppdateres.

**Statussemantikk på `vouchers.status`** (enum er som spesifisert i oppdraget, men
betydningen må dokumenteres fordi den ikke er selvforklarende):

- `needs_review` — lav confidence, manglende påkrevd felt, mulig dublett, eller
  banktransaksjon uten kvittering
- `matched` — komplett bilag, evt. avstemt mot bank. Klart til bokføring.
- `confirmed` — brukeren har godkjent
- `duplicate` — avvist som dublett / slått sammen inn i et annet bilag

### `packages/core` — komplett

| Fil | Ansvar | Nøkkelfunksjoner |
|---|---|---|
| `money.ts` | Penger som heltall i minste enhet | `parseAmount()` tåler `"1 234,56"`, `"1.234,56"`, `"1,234.56"`, `"kr 349,-"`. `formatAmount()`, `decimalsFor()` (JPY har 0 desimaler). |
| `vat.ts` | Norsk MVA | `VAT_RATES` (25/15/12/0/fritatt), `splitFromGross()`, `splitFromNet()`, `shouldReverseCharge()`, `vatTermFor()` (norske terminer 1–6). |
| `text.ts` | Normalisering + fuzzy | `normalizeCounterparty()` (fjerner AS/LLC/GmbH, Vipps/Klarna-støy, maskerte kortnummer), `counterpartySimilarity()` (Dice + containment), `htmlToText()`, `emailDomain()`. |
| `dedup.ts` | Tre lag dedup | `sha256()`, `dedupHash()`, `isProbableDuplicate()`, `daysBetween()`. |
| `matching.ts` | Bank ↔ dokument | `scoreMatch()` (beløp 0.5 / dato 0.2 / navn 0.3), `bestMatch()`. **Kobler aldri automatisk når nr. 1 og nr. 2 er innenfor 0.08 av hverandre** — to like gode kandidater er nettopp tilfellet der auto ville vært feil. |
| `fx.ts` | Norges Bank | `getRate()` (cache → API → nærmeste tidligere), `convertToNok()`, `parseNorgesBankCsv()` (håndterer `UNIT_MULT` for SEK/DKK/JPY som noteres per 100). |
| `crypto.ts` | Hemmeligheter i ro | AES-256-GCM, `encryptSecret()` / `decryptSecret()` / `encryptJson()`, versjonsprefiks `v1:` for nøkkelrotasjon. |
| `storage.ts` | Blob-lager | `LocalBlobStore` — write-once, innholdsadressert (sha256), **ingen delete**. `BlobStore`-grensesnitt klart for S3/MinIO. |
| `contract.ts` | **Kontrakten mellom LLM og resten** | `extractedDocumentSchema` (zod), `overallConfidence()` med feltvekter, `REVIEW_THRESHOLD = 0.8`. |
| `categorize.ts` | Kategori + konto + MVA-kode | `categorize(profile, rules, input)` — ren funksjon. Prioritet: brukerlærte regler → profilregler i DB → leverandørhint i profilen → fallback. `ruleFromCorrection()` lærer av korreksjoner. |
| `normalize.ts` | ExtractedDocument → bilag | `normalizeDocument()` og `normalizeBankTransaction()`. Returnerer `{ voucher, lines, reviewReasons }`. |
| `config.ts` | Validert env | `config()`, `inboundAddress()`, `generateInboundSlug()`. |
| `profiles/` | Bransjeprofiler som **ren data** | `dj`, `frisor`, `dagligvare`, `generic`. `getProfile(key)`. |

**Det viktigste designvalget i profilene:** leverandørhint setter **aldri** `direction`.
Et hint har `expenseCategory` og/eller `incomeCategory`, og retningen kommer fra
dokumentet. Beatport og Bandcamp har begge — kjøp av musikk er utgift, utbetaling av
eget salg er inntekt. Spotify/Tidal/SoundCloud har bare `expenseCategory`.

### `packages/extraction` — komplett

| Fil | Innhold |
|---|---|
| `types.ts` | `Extractor`-grensesnittet, `ExtractionInput` (text / Buffer + mime / hints), `ExtractionResult`, `ExtractionError`. |
| `prompt.ts` | `SYSTEM_PROMPT` (10 nummererte regler på norsk) + `PROMPT_VERSION = "2026-09-01.1"`. **Bump versjonen når du endrer prompten** — den lagres på hver ekstraksjon slik at du kan finne igjen og kjøre om alt som ble tolket av den gamle. |
| `claude.ts` | `ClaudeExtractor`. Bruker `client.messages.parse()` med `zodOutputFormat(extractedDocumentSchema)` — zod-kontrakten i core er eneste sannhet for både modellen og typene. Sender PDF som `document`-blokk og bilder som `image`-blokk **før** tekstblokken. Håndterer `stop_reason: "refusal"` og `RateLimitError`. |
| `heuristic.ts` | `HeuristicExtractor` — regelbasert, uten LLM. Finnes av to grunner: prosjektet skal kunne kjøres uten API-nøkkel, og tester må være deterministiske. Setter bevisst lav `fieldConfidence` slik at alt havner i gjennomgangskøen. |
| `index.ts` | `getExtractor()` velger Claude når `ANTHROPIC_API_KEY` finnes, ellers heuristikk med en `console.warn`. `setExtractor()` for tester. |

### `packages/ingestion` — delvis

| Fil | Status |
|---|---|
| `types.ts` | **Ferdig.** Hele `IngestionChannel`-grensesnittet. |
| `channels/email-forward.ts` | **Ferdig.** Kanal 1. |
| resten | **Mangler.** Se punkt 6. |

**`IngestionChannel`-grensesnittet** (`packages/ingestion/src/types.ts`) — dette er
systemets viktigste abstraksjon:

```ts
interface IngestionChannel<TConfig, TWebhook> {
  readonly type: ChannelType;              // email_forward | inbox_scan | bank |
                                           // file_upload | folder_watch | browser
  readonly label: string;
  readonly capabilities: ChannelCapabilities;  // push/pull/backfill/fragile …
  readonly configSchema: z.ZodType<TConfig>;

  setup(input): Promise<SetupResult>;      // få klikk, returnerer instruksjoner
  healthCheck(ctx): Promise<ChannelHealth>;
  pull?(ctx, opts): AsyncIterable<IngestionItem>;   // pollende kanaler
  receive?(ctx, payload: TWebhook): Promise<IngestionItem[]>;  // push-kanaler
  nextCursor?(items, previous): Cursor;
  teardown?(ctx): Promise<void>;
}
```

`IngestionItem` er en union: `DocumentItem` (går til ekstraksjon) eller
`TransactionItem` (blir bilag uten dokumentasjon). En kanal **lagrer ingenting, kaller
ingen LLM og vet ikke hva et bilag er.**

`ChannelAuthError` (brukeren må gjøre noe — ikke retry blindt) og
`ChannelTemporaryError` (retry med backoff) er definert og skal brukes.

**`EmailForwardChannel`** er ferdig og inneholder:
- `InboundEmail` — den felles formen alle leverandører normaliseres til (Postmark-lik).
- `normalizeMailgun(fields, attachments)` — Mailgun multipart → `InboundEmail`.
- `verifyMailgunSignature()` (HMAC-SHA256 over timestamp+token) og
  `verifySharedSecret()` (Postmark / MailHog-bro).
- `slugFromRecipient()` — lokaldelen identifiserer brukeren, `+`-suffiks strippes.
- `setup()` returnerer de tre instruksjonene brukeren skal se i UI.

---

## 6. Hva som GJENSTÅR — i denne rekkefølgen

### 6.0 Gjør prosjektet kjørbart (gjør dette FØRST)

Ingenting er installert eller kjørt. Konkret:

1. **Rett `.env.example`:** `EXTRACTION_MODEL=claude-opus-5` (står nå `claude-sonnet-5`).
2. `pnpm install` i rot. **Forvent versjonskonflikter** — alle avhengigheter er skrevet
   med caret-ranges uten å være verifisert mot npm. Særlig:
   - `@anthropic-ai/sdk` er satt til `>=0.110.0 <1` fordi `messages.parse()` og
     `@anthropic-ai/sdk/helpers/zod` krever nyere SDK. Verifiser at
     `zodOutputFormat` finnes på den installerte versjonen.
   - `drizzle-orm ^0.36.0` / `drizzle-kit ^0.28.0` — sjekk at `pgEnum`-signaturen og
     den andre parameteren til `pgTable` (index-callbacken) matcher installert versjon.
     Nyere drizzle-kit vil ha index-callbacken som **array**, ikke objekt.
3. `docker compose up -d` → postgres på **5433**, mailhog på 1025/8025.
4. `cp .env.example .env`, generer nøkkel:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` →
   `ENCRYPTION_KEY`.
5. `pnpm db:push` (drizzle-kit push mot skjemaet).
6. `pnpm typecheck` og fiks det som kommer. **Kjente sannsynlige feil:**
   - `packages/core/src/normalize.ts` bruker `Minor`-typen på steder der Drizzle
     forventer `number` — brand-typen kan kreve en cast.
   - `voucherLines.quantity` er `numeric` (string i Drizzle) mens `buildLines()`
     sender `string | null` — bør stemme, men verifiser.
   - `fx.ts` importerer `lte`/`desc` fra `@qbikk/db` — bekreft at de re-eksporteres.

### 6.1 `packages/jobs` — pg-boss

Opprett `packages/jobs` med:

```ts
// jobbnavn og payload-typer, ett sted
export const JOBS = {
  ingestDocument: "ingest.document",     // { userId, rawDocumentId }
  extractDocument: "extract.document",   // { userId, rawDocumentId, force?: boolean }
  syncChannel: "channel.sync",           // { userId, channelId, full?: boolean }
  matchVouchers: "match.run",            // { userId, voucherId? }
  fetchFxRate: "fx.fetch",               // { currency, date }
} as const;
```

- `createQueue()` som starter pg-boss mot samme `DATABASE_URL`.
- Retry-policy per jobbtype: `retryLimit`, `retryDelay`, `retryBackoff: true`.
  Kanaler med `capabilities.fragile === true` (browser) skal ha **egen, mildere**
  policy og skal aldri blokkere de robuste kanalene.
- `schedule()` for periodiske synker — pg-boss har innebygd cron.

### 6.2 Pipeline-funksjonene (legg i `packages/core/src/pipeline.ts`)

Dette er limet, og det er her referanseimplementasjonen faktisk oppstår.

```ts
// 1. Lagre rått. Idempotent på sha256 — returnerer eksisterende ved dublett.
storeRawDocument(db, blobStore, { userId, channelId, channelType, item: DocumentItem })
  → { rawDocumentId, isDuplicate, attachments }

// 2. Kjør ekstraksjon. Velger primærvedlegg (PDF > bilde > brødtekst).
runExtraction(db, extractor, { userId, rawDocumentId, force })
  → { extractionId, document }
// Skriver ny rad i extractions, setter superseded_at på forrige.

// 3. Normaliser + lagre bilag. Håndterer unique-violation på dedup_hash.
upsertVoucher(db, { userId, profile, rules, extraction, rawDocument })
  → { voucherId, isDuplicate, reviewReasons }

// 4. Foreslå matcher mot bankbilag i vindu.
proposeMatches(db, { userId, voucherId })
  → MatchProposal[]
// autoLink=true → skriv voucher_matches med status 'confirmed' og slå sammen.
// autoLink=false → status 'proposed', dukker opp i "krever handling".

// 5. Slå sammen bank + dokument til ETT bilag.
mergeMatched(db, { bankVoucherId, documentVoucherId })
// Dokumentbilaget beholdes (det har MVA og dokumentasjon), får bookingDate fra
// banken, needsDocumentation=false. Bankbilaget får status='duplicate' og
// supersedesVoucherId satt. Ingenting slettes.
```

Regelen fra oppdraget: **usikre matcher foreslås, ikke utføres.**

### 6.3 `apps/worker`

pg-boss-konsument som registrerer handlerne over. Egen prosess, `tsx watch src/index.ts`
i dev. Skriver `sync_runs`-rader ved start/slutt og oppdaterer
`ingestion_channels.last_sync_at` / `last_error` / `consecutive_failures`.

### 6.4 `apps/web` — Next.js

**Webhook-endepunktet er kritisk stien i referanseimplementasjonen:**

`app/api/inbound/email/route.ts`:
1. Verifiser signatur (`verifyMailgunSignature` eller `verifySharedSecret` avhengig av
   `INBOUND_PROVIDER`). **Avvis med 401 ved feil** — uten dette kan hvem som helst POSTe
   falske bilag inn i regnskapet.
2. Normaliser body → `InboundEmail` (`normalizeMailgun` for mailgun, direkte for
   postmark/mailhog).
3. `slugFromRecipient()` → slå opp `users.inboundSlug`. Ukjent slug → 200 + logg
   (ikke 404, ellers retryer leverandøren i evighet).
4. `emailForwardChannel.receive(ctx, payload)` → `DocumentItem[]`.
5. `storeRawDocument()` → `send(JOBS.extractDocument)`.
6. Svar **200 raskt**. All tung jobb skjer i worker.

Sider som skal bygges:

| Rute | Innhold |
|---|---|
| `/` | Dashboard: inntekt vs. utgift over tid, per kategori, per kanal. |
| `/bilag` | Bilagsliste med filter (dato, status, kategori, kanal, retning), fritekstsøk, inline korrigering. Hver korrigering → rad i `corrections` + `ruleFromCorrection()`. |
| `/handling` | «Krever handling»-kø: bank uten kvittering (`needsDocumentation`), lav confidence (`status='needs_review'`), foreslåtte matcher (`voucher_matches.status='proposed'`), mulige duplikater. |
| `/kanaler` | Kanalstatus: sist synk, siste feil, `healthCheck()`-knapp, `setup()`-instruksjoner. |
| `/mva` | MVA-oppsummering per termin (`vatTermFor()`), inkl. egen seksjon for omvendt avgiftsplikt. |

**Viktig for klientkomponenter:** importer fra undermoduler (`@qbikk/core/money`,
`@qbikk/core/vat`), ikke fra `@qbikk/core` — hovedindeksen drar inn `fx.ts` som
importerer `postgres`.

### 6.5 Resterende kanaler

Alle implementerer `IngestionChannel`. Én fil hver, ingen andre filer endres.

**Kanal 2 — `channels/inbox-scan.ts` (IMAP/Gmail).**
`pull: true`, `backfill: true`. Bruk `imapflow` + `mailparser`, men **importer dem
dynamisk inne i `pull()`** slik at registret ikke drar dem inn ved oppstart. Cursor =
`{ uidValidity, lastUid }`. Søk bakover på `SUBJECT`/`BODY` med
`kvittering|faktura|receipt|invoice|order confirmation|ordrebekreftelse`. Passord/token
krypteres med `encryptJson()`. Gmail bør bruke OAuth, ikke app-passord.

**Kanal 3 — `channels/bank-gocardless.ts` (PSD2).**
`pull: true`, `producesTransactions: true`. Ingen ekstra avhengigheter — bruk `fetch`.
Flyt: `/token/new/` → `/institutions/?country=no` → `/agreements/enduser/` →
`/requisitions/` (returnerer `link` brukeren må åpne — det er `SetupResult.pending`) →
`/accounts/{id}/transactions/`. Cursor = `{ lastBookingDate }`. Samtykke varer 90 dager
→ når API-et svarer 401/403, kast `ChannelAuthError` slik at UI ber om ny godkjenning.

**Kanal 4 — `channels/file-upload.ts` + `channels/folder-watch.ts`.**
Upload er trivielt: multipart → `DocumentItem`. Mobilfoto trenger **ingen egen OCR** —
Claude leser bildet direkte. Folder-watch: Dropbox/Drive-cursor, `pull: true`.

**Kanal 5 — `channels/browser.ts`. Bygg denne SIST.**
`fragile: true`. Skal være isolert bak samme grensesnitt slik at skjørhet ikke smitter.
Risikoene må være eksplisitte i koden og i UI:

- **Lagring av innlogging.** Lagre aldri passord i klartekst. Foretrekk *session cookies*
  over passord, med kort levetid, kryptert med `encryptJson()`.
- **MFA.** Kan ikke automatiseres forsvarlig. Design for at brukeren logger inn
  interaktivt én gang og at vi bare gjenbruker sesjonen til den utløper.
- **Brudd på vilkår.** Mange portaler forbyr automatisert innlogging. UI må si dette
  rett ut og kreve aktivt samtykke per portal.
- **Minimering:** kjør bare når de andre kanalene ikke dekker leverandøren; kjør sjelden;
  hent kun dokumenter, aldri annet; logg hvert kall.

MCP-basert browserstyring er verdt å vurdere her — det holder browserlogikken i en egen
prosess bak et verktøygrensesnitt, som passer perfekt med at kanalen skal være isolert.

### 6.6 `apps/mcp` — MCP-server

Verktøy den bør tilby (skisse fra oppdraget, ikke implementert):

| Verktøy | Signatur | Merknad |
|---|---|---|
| `search_vouchers` | `{ query?, from?, to?, direction?, status?, category?, counterparty?, minAmount?, maxAmount?, limit? }` | Fritekst + filtre. Returnerer normaliserte bilag. |
| `get_voucher` | `{ id }` | Inkl. linjer, korreksjonshistorikk og lenke til rådokument. |
| `create_voucher` | `{ date, direction, grossAmount, currency, counterpartyName, description, category? }` | Manuelt bilag, `sourceChannel: "manual"`. Kjører samme dedup som alt annet. |
| `attach_document` | `{ voucherId, filename, contentBase64, mime }` | Legger dokumentasjon på et bankbilag. |
| `list_action_items` | `{ }` | «Krever handling»-køen som strukturert liste. |
| `propose_match` / `confirm_match` | `{ bankVoucherId, documentVoucherId }` | Confirm skal kreve eksplisitt kall — agenten skal ikke kunne auto-koble. |
| `correct_voucher` | `{ id, field, value, reason }` | Skriver til `corrections`, aldri destruktivt. |
| `vat_summary` | `{ year, term? }` | MVA per termin, inkl. omvendt avgiftsplikt. |
| `channel_status` | `{ }` | Sist synk, feil, hva som krever brukerhandling. |

**Skrivende verktøy må ikke kunne omgå dedup, korreksjonshistorikk eller
matchereglene.** De skal kalle de samme pipeline-funksjonene som resten av systemet.

### 6.7 Tester (vitest)

Minimum, og **den første er et krav fra oppdraget**:

1. `profiles.test.ts` — **DJ-caset og frisør-caset gjennom nøyaktig samme kodevei.**
   Samme `normalizeDocument()`-kall, bare ulik `profile`. Assert at begge produserer
   gyldig bilag og at forskjellen kun er `category` / `accountCode`.
2. `direction.test.ts` — Beatport som utgift (kjøpskvittering) og som inntekt
   (payout statement). Assert at retning kommer fra dokumentet, ikke fra navnet.
3. `money.test.ts` — `parseAmount()` mot alle formatene.
4. `vat.test.ts` — 25/15/12, omvendt avgiftsplikt, `vatTermFor()`.
5. `dedup.test.ts` — samme kvittering fra to kanaler → ett bilag; bank + kvittering →
   to bilag som matches.
6. `matching.test.ts` — tvetydig match (to like beløp samme dag) blir **foreslått**,
   ikke utført.
7. `fx.test.ts` — `parseNorgesBankCsv()` med `UNIT_MULT=2`.

Bruk `HeuristicExtractor` eller en stub via `setExtractor()` — aldri ekte API-kall i test.

### 6.8 Scripts og fixtures

- `scripts/seed.ts` — oppretter én bruker med profil fra `DEFAULT_PROFILE`, genererer
  `inboundSlug`, oppretter `email_forward`-kanalen, seeder profilens leverandørhint
  som `category_rules` med `origin: "profile"`.
- `scripts/mailhog-bridge.ts` — poller `MAILHOG_API_URL/api/v2/messages`, parser med
  `mailparser`, POSTer `InboundEmail`-JSON til `/api/inbound/email` med
  `x-qbikk-secret`-header. Husk å holde styr på hvilke meldinger som er sendt.
- `scripts/send-demo-email.ts` — sender en fixture til MailHog på SMTP 1025.
- `fixtures/emails/` — minst: Beatport-kjøpskvittering (USD, utgift),
  Beatport payout statement (USD, inntekt), Spotify-abonnement (EUR, omvendt
  avgiftsplikt), norsk frisørgrossist-faktura (NOK, 25 %), dagligvarekvittering med
  blandet 15/25 %.

### 6.9 SAF-T og eksport til regnskapsfører

Ikke implementert, men skjemaet er forberedt: `account_code` (NS 4102), `vat_code` per
linje, `counterparty` med org.nr og land, `exchange_rate` + `rate_date` lagret. Neste
steg er en `packages/export`-modul som skriver SAF-T Financial (XML) og en enkel CSV for
regnskapsførere som ikke tar SAF-T.

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

## 8. Kjør lokalt

```bash
cp .env.example .env          # sett ENCRYPTION_KEY og evt. ANTHROPIC_API_KEY
docker compose up -d          # postgres:5433, mailhog:1025/8025
pnpm install
pnpm db:push
pnpm seed
pnpm dev                      # web på :3000, worker parallelt
# i eget vindu:
pnpm tsx scripts/mailhog-bridge.ts
pnpm demo:email               # sender en fixture inn i systemet
```

Uten `ANTHROPIC_API_KEY` kjører systemet på `HeuristicExtractor` og alle bilag havner i
gjennomgangskøen. Det er riktig oppførsel — ikke «fiks» det ved å gjette bedre.

---

## 9. Åpne spørsmål til brukeren

Disse er ikke blokkerende, men bør avklares før produksjon:

1. **Domene for bilagsadressene** — `bilag.minapp.no` er en placeholder. Hvilket domene
   skal faktisk brukes, og er det tilgjengelig for MX-oppsett hos Mailgun/Postmark?
2. **GoCardless-konto** — er den opprettet? Secret ID/key trengs før kanal 3 kan testes.
3. **Oppbevaring av rådokumenter** — lokalt filsystem holder i utvikling. I produksjon
   må bilag ligge trygt i fem år: S3 med versjonering og object lock, eller tilsvarende.
4. **Flere brukere** — v1 er én bruker per installasjon, men skjemaet tåler flere.
   Når auth skal inn, må alle spørringer få `user_id`-filter — de har det allerede i
   signaturene, men det er ingen RLS i databasen ennå.
