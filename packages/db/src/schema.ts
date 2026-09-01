/**
 * Qbikk - datamodell.
 *
 * Prinsipper som ligger til grunn for hele skjemaet:
 *  1. Rådokumentet er sannheten og endres ALDRI. `raw_documents` og `attachments`
 *     er append-only. All tolkning er avledet og ligger i `extractions`.
 *  2. Ekstraksjon kan kjøres om igjen uten tap: nye rader i `extractions`,
 *     gamle beholdes og markeres `superseded_at`.
 *  3. Ingen destruktiv redigering av bilag. Endringer skrives til `corrections`
 *     for full sporbarhet i 5 år (bokføringsloven).
 *  4. Alle beløp lagres som HELTALL I MINSTE ENHET (øre). Aldri float.
 *     Se `@qbikk/core/money`.
 *  5. `user_id` finnes overalt selv om v1 kjører med én bruker per installasjon.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  bigint,
  numeric,
  date,
  integer,
  char,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/* ------------------------------------------------------------------ enums */

export const channelTypeEnum = pgEnum("channel_type", [
  "email_forward", // kanal 1 - videresendingsadresse
  "inbox_scan", // kanal 2 - IMAP/Gmail bakoversøk
  "bank", // kanal 3 - PSD2 / GoCardless
  "file_upload", // kanal 4 - drag & drop, mobilfoto
  "folder_watch", // kanal 4 - Dropbox/Drive-mappe
  "browser", // kanal 5 - browserautomatisering
  "manual", // manuelt opprettet i UI
]);

export const directionEnum = pgEnum("direction", ["income", "expense"]);

export const voucherStatusEnum = pgEnum("voucher_status", [
  "needs_review", // lav confidence eller manglende felt
  "matched", // bank + dokument koblet, men ikke bekreftet av bruker
  "confirmed", // bruker har godkjent
  "duplicate", // avvist som dublett av et annet bilag
]);

export const matchStatusEnum = pgEnum("match_status", ["proposed", "confirmed", "rejected"]);

/** Norske MVA-koder. `reverse_charge` = omvendt avgiftsplikt ved kjøp fra utlandet. */
export const vatCodeEnum = pgEnum("vat_code", [
  "standard_25",
  "food_15",
  "transport_12",
  "zero_0",
  "exempt",
  "reverse_charge",
  "outside_scope",
]);

export const docKindEnum = pgEnum("doc_kind", ["email", "pdf", "image", "csv", "html", "other"]);

export const channelStatusEnum = pgEnum("channel_status", ["active", "paused", "needs_auth", "error"]);

export const syncStatusEnum = pgEnum("sync_status", ["running", "success", "partial", "failed"]);

export const syncTriggerEnum = pgEnum("sync_trigger", ["schedule", "manual", "webhook", "backfill"]);

/* ------------------------------------------------------------------ users */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    orgNumber: text("org_number"),
    /** Bransjeprofil: styrer KUN kategorisett, kontoplan og forventede leverandører. */
    profile: text("profile").notNull().default("generic"),
    /** Lokaldelen av videresendingsadressen: <slug>@bilag.minapp.no */
    inboundSlug: text("inbound_slug").notNull(),
    vatRegistered: boolean("vat_registered").notNull().default(true),
    baseCurrency: char("base_currency", { length: 3 }).notNull().default("NOK"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_uq").on(t.email),
    slugIdx: uniqueIndex("users_inbound_slug_uq").on(t.inboundSlug),
  }),
);

/* ------------------------------------------------------- inntakskanaler -- */

export const ingestionChannels = pgTable(
  "ingestion_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: channelTypeEnum("type").notNull(),
    /** Visningsnavn i UI, f.eks. "Gmail - privat" eller "DNB brukskonto". */
    name: text("name").notNull(),
    /** Hemmeligheter (tokens, passord, cookies) AES-256-GCM-kryptert. Aldri klartekst. */
    configEncrypted: text("config_encrypted"),
    /** Ikke-hemmelig konfig som trygt kan vises i UI og logges. */
    configMeta: jsonb("config_meta").$type<Record<string, unknown>>().notNull().default({}),
    status: channelStatusEnum("status").notNull().default("active"),
    /** Inkrementell posisjon: IMAP UID, GoCardless-dato, mappe-mtime osv. */
    cursor: jsonb("cursor").$type<Record<string, unknown>>(),
    scheduleCron: text("schedule_cron"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("channels_user_idx").on(t.userId, t.type),
  }),
);

/* ---------------------------------------------------------- rådokumenter - */

/** Uendret råkopi av alt som kommer inn. Skrives én gang, leses mange. */
export const rawDocuments = pgTable(
  "raw_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").references(() => ingestionChannels.id, { onDelete: "set null" }),
    channelType: channelTypeEnum("channel_type").notNull(),
    /** Kanalens egen id: Message-ID, IMAP UID, GoCardless transaction_id, filsti. */
    externalRef: text("external_ref"),
    kind: docKindEnum("kind").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    subject: text("subject"),
    sender: text("sender"),
    recipient: text("recipient"),
    /** Nøkkel i blob-lageret for den rå byte-strømmen (hele MIME-meldingen, filen). */
    storageKey: text("storage_key"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    /** SHA-256 over råbytene. Første forsvarslinje mot dubletter. */
    contentSha256: text("content_sha256").notNull(),
    /** Ren tekst som kan mates rett til ekstraktoren uten å hente blob. */
    textBody: text("text_body"),
    /** Webhook-body, e-posthoder, API-respons - alt som kom med. */
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shaIdx: uniqueIndex("raw_docs_user_sha_uq").on(t.userId, t.contentSha256),
    extIdx: index("raw_docs_external_idx").on(t.userId, t.channelType, t.externalRef),
    receivedIdx: index("raw_docs_received_idx").on(t.userId, t.receivedAt),
  }),
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    rawDocumentId: uuid("raw_document_id")
      .notNull()
      .references(() => rawDocuments.id, { onDelete: "cascade" }),
    filename: text("filename"),
    mime: text("mime").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    /** Sann for vedlegget som er selve bilaget (ikke logo eller signaturbilde). */
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index("attachments_doc_idx").on(t.rawDocumentId),
  }),
);

/* ------------------------------------------------------------ ekstraksjon */

export const extractions = pgTable(
  "extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rawDocumentId: uuid("raw_document_id")
      .notNull()
      .references(() => rawDocuments.id, { onDelete: "cascade" }),
    /** Hvilken kilde ble lest: "body" eller en attachment-id. */
    inputRef: text("input_ref").notNull().default("body"),
    extractor: text("extractor").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    /** Validert ExtractedDocument-JSON. Se @qbikk/extraction/schema. */
    output: jsonb("output").$type<Record<string, unknown>>(),
    /** { gross_amount: 0.95, date: 0.99, ... } - per felt, ikke bare totalt. */
    fieldConfidence: jsonb("field_confidence").$type<Record<string, number>>().notNull().default({}),
    overallConfidence: numeric("overall_confidence", { precision: 4, scale: 3 }),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    /** Satt når en nyere ekstraksjon av samme dokument har erstattet denne. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    docIdx: index("extractions_doc_idx").on(t.rawDocumentId, t.createdAt),
  }),
);

/* --------------------------------------------------------------- motparter */

export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    /** Normalisert nøkkel for oppslag: lowercase, uten AS/AB/Ltd/Inc og tegnsetting. */
    normalizedKey: text("normalized_key").notNull(),
    country: char("country", { length: 2 }),
    orgNumber: text("org_number"),
    vatNumber: text("vat_number"),
    defaultCategory: text("default_category"),
    defaultAccountCode: text("default_account_code"),
    /** Hint, ikke fasit. Retning avgjøres alltid av dokumentet (jf. Beatport). */
    typicalDirection: directionEnum("typical_direction"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyIdx: uniqueIndex("counterparties_key_uq").on(t.userId, t.normalizedKey),
  }),
);

/** Skrivemåter vi har sett i banken og i dokumenter for samme motpart. */
export const counterpartyAliases = pgTable(
  "counterparty_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    counterpartyId: uuid("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    source: channelTypeEnum("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    aliasIdx: index("cp_alias_idx").on(t.normalizedKey),
  }),
);

/* -------------------------------------------------------------------- bilag */

export const vouchers = pgTable(
  "vouchers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),

    sourceChannel: channelTypeEnum("source_channel").notNull(),
    sourceChannelId: uuid("source_channel_id").references(() => ingestionChannels.id, {
      onDelete: "set null",
    }),
    externalRef: text("external_ref"),

    rawDocumentId: uuid("raw_document_id").references(() => rawDocuments.id, { onDelete: "set null" }),
    extractionId: uuid("extraction_id").references(() => extractions.id, { onDelete: "set null" }),

    /** Bilagsdato = dokumentdato. Bankens bokføringsdato ligger i bookingDate. */
    date: date("date").notNull(),
    bookingDate: date("booking_date"),
    direction: directionEnum("direction").notNull(),

    /** Alle beløp i øre (minste enhet av `currency`). Alltid positive. */
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    netAmount: bigint("net_amount", { mode: "number" }),
    vatAmount: bigint("vat_amount", { mode: "number" }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatCode: vatCodeEnum("vat_code"),
    currency: char("currency", { length: 3 }).notNull().default("NOK"),

    /** Omregnet til NOK med Norges Banks kurs på transaksjonsdato. Lagret, ikke beregnet ved lesing. */
    amountNok: bigint("amount_nok", { mode: "number" }).notNull(),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 8 }).notNull().default("1"),
    rateDate: date("rate_date"),

    counterpartyId: uuid("counterparty_id").references(() => counterparties.id, { onDelete: "set null" }),
    counterpartyName: text("counterparty_name"),
    counterpartyCountry: char("counterparty_country", { length: 2 }),

    description: text("description"),
    category: text("category"),
    accountCode: text("account_code"),

    /** Blob-nøkkel til hoveddokumentasjonen. Null = bilag uten dokumentasjon. */
    attachmentPath: text("attachment_path"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),

    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    status: voucherStatusEnum("status").notNull().default("needs_review"),

    /** Deterministisk fingeravtrykk brukt til hard dedup. Se @qbikk/core/dedup. */
    dedupHash: text("dedup_hash").notNull(),

    /** Banktransaksjon uten kvittering -> havner i "krever handling". */
    needsDocumentation: boolean("needs_documentation").notNull().default(false),
    /** Kjøp fra utlandet -> omvendt avgiftsplikt, må rapporteres. */
    reverseCharge: boolean("reverse_charge").notNull().default(false),
    /** Bilaget som ble slått sammen inn i dette (bank + kvittering blir ett bilag). */
    supersedesVoucherId: uuid("supersedes_voucher_id"),

    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupIdx: uniqueIndex("vouchers_dedup_uq").on(t.userId, t.dedupHash),
    dateIdx: index("vouchers_date_idx").on(t.userId, t.date),
    statusIdx: index("vouchers_status_idx").on(t.userId, t.status),
    /** Bærer matchesøket: beløp + dato-vindu. */
    matchIdx: index("vouchers_match_idx").on(t.userId, t.direction, t.amountNok, t.date),
  }),
);

/** MVA per linje - ett bilag kan blande 25 % og 15 %. */
export const voucherLines = pgTable(
  "voucher_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    voucherId: uuid("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    description: text("description"),
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    unitPrice: bigint("unit_price", { mode: "number" }),
    netAmount: bigint("net_amount", { mode: "number" }).notNull(),
    vatCode: vatCodeEnum("vat_code").notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    vatAmount: bigint("vat_amount", { mode: "number" }).notNull(),
    grossAmount: bigint("gross_amount", { mode: "number" }).notNull(),
    accountCode: text("account_code"),
    category: text("category"),
  },
  (t) => ({
    voucherIdx: index("voucher_lines_voucher_idx").on(t.voucherId, t.lineNo),
  }),
);

/* ------------------------------------------------------- banktransaksjoner */

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    channelId: uuid("channel_id").references(() => ingestionChannels.id, { onDelete: "set null" }),
    /** GoCardless transactionId - stabil per bank, brukes til inkrementell synk. */
    externalId: text("external_id").notNull(),
    accountId: text("account_id").notNull(),
    bookingDate: date("booking_date").notNull(),
    valueDate: date("value_date"),
    /** Fortegn beholdes: negativ = utgående. Retning utledes av fortegnet. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    counterpartyNameRaw: text("counterparty_name_raw"),
    counterpartyAccount: text("counterparty_account"),
    remittanceInfo: text("remittance_info"),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    /** Bilaget denne transaksjonen ble til. */
    voucherId: uuid("voucher_id").references(() => vouchers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    extIdx: uniqueIndex("bank_tx_external_uq").on(t.userId, t.accountId, t.externalId),
    dateIdx: index("bank_tx_date_idx").on(t.userId, t.bookingDate),
  }),
);

/* ---------------------------------------------------------------- matching */

/**
 * Kobling mellom et bankbilag og et dokumentbilag.
 * Usikre matcher lagres som `proposed` og utføres ALDRI automatisk.
 */
export const voucherMatches = pgTable(
  "voucher_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bankVoucherId: uuid("bank_voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "cascade" }),
    documentVoucherId: uuid("document_voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "cascade" }),
    score: numeric("score", { precision: 4, scale: 3 }).notNull(),
    /** { amount: 1, dateDays: 1, nameSimilarity: 0.82, currency: 1 } */
    reasons: jsonb("reasons").$type<Record<string, unknown>>().notNull().default({}),
    status: matchStatusEnum("status").notNull().default("proposed"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairIdx: uniqueIndex("matches_pair_uq").on(t.bankVoucherId, t.documentVoucherId),
    statusIdx: index("matches_status_idx").on(t.userId, t.status),
  }),
);

/* ---------------------------------------------------------- kategoriregler */

export const categoryRules = pgTable(
  "category_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Lav verdi vinner. Brukerlærte regler får lavere tall enn profilregler. */
    priority: integer("priority").notNull().default(100),
    matchType: text("match_type").$type<"counterparty" | "domain" | "regex" | "amount_range">().notNull(),
    matchValue: text("match_value").notNull(),
    /** Null = gjelder begge retninger. */
    direction: directionEnum("direction"),
    setCategory: text("set_category"),
    setAccountCode: text("set_account_code"),
    setVatCode: vatCodeEnum("set_vat_code"),
    /** profile = fra bransjeprofil, user_correction = lært av en korreksjon. */
    origin: text("origin").$type<"profile" | "user_correction" | "manual">().notNull().default("manual"),
    hitCount: integer("hit_count").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lookupIdx: index("rules_lookup_idx").on(t.userId, t.enabled, t.priority),
  }),
);

/* ----------------------------------------------------- korreksjonshistorikk */

/** Append-only. Ingen rad slettes eller oppdateres - dette er revisjonssporet. */
export const corrections = pgTable(
  "corrections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    voucherId: uuid("voucher_id")
      .notNull()
      .references(() => vouchers.id, { onDelete: "restrict" }),
    field: text("field").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
    actor: text("actor").notNull().default("user"),
    /** Satt når korreksjonen har generert en kategoriregel. */
    learnedRuleId: uuid("learned_rule_id").references(() => categoryRules.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    voucherIdx: index("corrections_voucher_idx").on(t.voucherId, t.createdAt),
  }),
);

/* --------------------------------------------------------------- synk-logg */

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").references(() => ingestionChannels.id, { onDelete: "cascade" }),
    trigger: syncTriggerEnum("trigger").notNull(),
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    itemsSeen: integer("items_seen").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    itemsDuplicate: integer("items_duplicate").notNull().default(0),
    itemsFailed: integer("items_failed").notNull().default(0),
    error: text("error"),
    cursorBefore: jsonb("cursor_before"),
    cursorAfter: jsonb("cursor_after"),
  },
  (t) => ({
    channelIdx: index("sync_runs_channel_idx").on(t.channelId, t.startedAt),
  }),
);

/* ------------------------------------------------------------------ valuta */

/** Norges Banks middelkurs, cachet per valuta og dato. */
export const fxRates = pgTable(
  "fx_rates",
  {
    currency: char("currency", { length: 3 }).notNull(),
    rateDate: date("rate_date").notNull(),
    /** Antall NOK for én enhet av `currency` (justert for kursens enhetsmultiplikator). */
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    source: text("source").notNull().default("norges-bank"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex("fx_rates_pk").on(t.currency, t.rateDate),
  }),
);

/* -------------------------------------------------------------- relasjoner */

export const rawDocumentsRelations = relations(rawDocuments, ({ many, one }) => ({
  attachments: many(attachments),
  extractions: many(extractions),
  channel: one(ingestionChannels, {
    fields: [rawDocuments.channelId],
    references: [ingestionChannels.id],
  }),
}));

export const vouchersRelations = relations(vouchers, ({ one, many }) => ({
  rawDocument: one(rawDocuments, { fields: [vouchers.rawDocumentId], references: [rawDocuments.id] }),
  extraction: one(extractions, { fields: [vouchers.extractionId], references: [extractions.id] }),
  counterparty: one(counterparties, {
    fields: [vouchers.counterpartyId],
    references: [counterparties.id],
  }),
  lines: many(voucherLines),
  corrections: many(corrections),
}));

export const voucherLinesRelations = relations(voucherLines, ({ one }) => ({
  voucher: one(vouchers, { fields: [voucherLines.voucherId], references: [vouchers.id] }),
}));

export const attachmentsRelations = relations(attachments, ({ one }) => ({
  rawDocument: one(rawDocuments, {
    fields: [attachments.rawDocumentId],
    references: [rawDocuments.id],
  }),
}));

export const extractionsRelations = relations(extractions, ({ one }) => ({
  rawDocument: one(rawDocuments, {
    fields: [extractions.rawDocumentId],
    references: [rawDocuments.id],
  }),
}));

/* ------------------------------------------------------------------- typer */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type IngestionChannelRow = typeof ingestionChannels.$inferSelect;
export type NewIngestionChannel = typeof ingestionChannels.$inferInsert;
export type RawDocument = typeof rawDocuments.$inferSelect;
export type NewRawDocument = typeof rawDocuments.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type Extraction = typeof extractions.$inferSelect;
export type NewExtraction = typeof extractions.$inferInsert;
export type Voucher = typeof vouchers.$inferSelect;
export type NewVoucher = typeof vouchers.$inferInsert;
export type VoucherLine = typeof voucherLines.$inferSelect;
export type NewVoucherLine = typeof voucherLines.$inferInsert;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;
export type VoucherMatch = typeof voucherMatches.$inferSelect;
export type CategoryRule = typeof categoryRules.$inferSelect;
export type Correction = typeof corrections.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type Counterparty = typeof counterparties.$inferSelect;
