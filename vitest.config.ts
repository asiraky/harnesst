/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Pure unit tests over in-memory fakes — no shared state, so files run in parallel.
    testTimeout: 20_000,
    // Feature worktrees carry their own copy of the suite — don't run them from here.
    exclude: [
      "**/node_modules/**",
      "**/.worktrees/**",
      "**/.claude/worktrees/**",
      // node:test suites, run by `npm run ledger:test`.
      "catalog/ledger/tests/**",
    ],
  },
});
