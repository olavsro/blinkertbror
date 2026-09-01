import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Testene skal aldri snakke med en ekte database eller et ekte API.
    // Se tests/setup.ts - den stenger valutakall og setter et kjent miljø.
    setupFiles: ["tests/setup.ts"],
  },
});
