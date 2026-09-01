import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { loadRootEnv } from "@qbikk/core/env";

// Next leser .env fra sin egen katalog. Vår ligger i roten av monorepoet,
// og next.config kjøres før alt annet - så det er her den må lastes.
loadRootEnv();

/**
 * Roten av monorepoet, eksplisitt.
 *
 * Next gjetter seg fram til workspace-roten ved å lete etter lockfiler, og
 * plukker feil katalog hvis det ligger en package-lock.json lenger oppe i
 * hjemmeområdet. Da havner build traces utenfor prosjektet, og en deploy tar
 * med seg feil filer. Vi peker på roten i stedet for å gjette.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  outputFileTracingRoot: repoRoot,
  // Workspace-pakkene distribueres som TypeScript-kilde, ikke bygget JS.
  // Uten dette forsøker Next å kjøre .ts-filene som om de var ferdig kompilert.
  transpilePackages: ["@qbikk/core", "@qbikk/db", "@qbikk/extraction", "@qbikk/ingestion", "@qbikk/jobs", "@qbikk/export"],
  serverExternalPackages: ["postgres", "pg-boss", "@anthropic-ai/sdk", "imapflow", "mailparser"],
  /**
   * Workspace-pakkene bruker `.js`-endelser i importene sine, slik ESM krever
   * - men filene på disk er `.ts`. Node og tsc håndterer det; webpack gjør det
   * ikke uten å få beskjed. Uten dette feiler bygget på «Can't resolve
   * ./vat.js» for hver eneste intern import i @qbikk/core.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  experimental: {
    // Webhooks med PDF-vedlegg blir fort store. 25 MB matcher grensen i
    // file-upload-kanalen, så de to sier det samme.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default config;
