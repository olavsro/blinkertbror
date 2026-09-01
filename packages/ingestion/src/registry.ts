/**
 * Kanalregisteret.
 *
 * Dette er det ENESTE stedet som vet hvilke kanaler som finnes. Worker, web
 * og MCP slår opp her og forholder seg ellers bare til `IngestionChannel`.
 *
 * Å legge til en kanal: skriv én fil i `channels/`, legg den til i lista under.
 * Ingen andre filer skal endres. Må du endre noe annet, er abstraksjonen feil -
 * fiks abstraksjonen, ikke kallstedet.
 */
import { emailForwardChannel } from "./channels/email-forward.js";
import { inboxScanChannel } from "./channels/inbox-scan.js";
import { bankGoCardlessChannel } from "./channels/bank-gocardless.js";
import { fileUploadChannel } from "./channels/file-upload.js";
import { folderWatchChannel } from "./channels/folder-watch.js";
import { browserChannel } from "./channels/browser.js";
import type { ChannelType, IngestionChannel } from "./types.js";

/**
 * Registrert i den rekkefølgen vi anbefaler brukeren å ta dem i bruk:
 * robuste og enkle først, skjøre sist. Rekkefølgen er det UI-et viser.
 */
const CHANNELS: IngestionChannel<never, never>[] = [
  emailForwardChannel,
  inboxScanChannel,
  bankGoCardlessChannel,
  fileUploadChannel,
  folderWatchChannel,
  browserChannel,
] as unknown as IngestionChannel<never, never>[];

const byType = new Map<ChannelType, IngestionChannel<never, never>>(CHANNELS.map((c) => [c.type, c]));

/** Alle kanaler, i anbefalt rekkefølge. */
export function listChannels(): IngestionChannel<never, never>[] {
  return [...CHANNELS];
}

/**
 * Kanalen for en type. Kaster ved ukjent type - en kanaltype i databasen som
 * ikke finnes i koden er en feil vi vil høre om, ikke en vi vil svelge.
 */
export function getChannel(type: ChannelType): IngestionChannel<never, never> {
  const channel = byType.get(type);
  if (!channel) throw new Error(`Ukjent kanaltype: ${type}`);
  return channel;
}

export function hasChannel(type: string): type is ChannelType {
  return byType.has(type as ChannelType);
}

/** Kanaler som kan synkes på timeplan. Worker planlegger disse. */
export function pullableChannels(): IngestionChannel<never, never>[] {
  return CHANNELS.filter((c) => c.capabilities.pull);
}
