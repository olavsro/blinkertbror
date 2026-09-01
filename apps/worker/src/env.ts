/**
 * Sideeffekt-modul: laster .env fra roten av monorepoet.
 *
 * Egen fil fordi ESM heiser alle importer. Et `loadRootEnv()`-kall MELLOM to
 * import-setninger kjører etter at begge modulene er lastet - altså for sent.
 * Importrekkefølgen er derimot garantert, så `import "./env.js"` øverst er
 * det eneste som faktisk virker.
 */
import { loadRootEnv } from "@qbikk/core/env";

loadRootEnv();
