/// <reference types="vitest" />
/**
 * Config for the FOH e2e suite only (`npm run test:e2e`). The specs are named `*.e2e.ts` so
 * the DEFAULT suite (`npm test`, root vitest.config.ts, `**\/*.test.*` glob) never picks them
 * up — they exercise the live worktree Postgres and a real HTTP fake-eve server, opt-in via
 * HARNESST_DB_SMOKE=1 exactly like tests/integration.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("../../app", import.meta.url)) },
  },
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["tests/e2e/**/*.e2e.ts"],
    setupFiles: ["./tests/setup.ts"],
    // The detached drain settles asynchronously; specs poll with generous deadlines.
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
