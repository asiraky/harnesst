import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readTemplate = (path: string) =>
  readFile(
    new URL(`../../assistant-template/${path}`, import.meta.url),
    "utf8",
  );

describe("assistant template runtime wiring", () => {
  it("passes the normalized assistant effort into the eve agent runtime", async () => {
    const [agent, bootstrap, entrypoint] = await Promise.all([
      readTemplate("agent/agent.ts"),
      readTemplate("bootstrap.mjs"),
      readTemplate("entrypoint.sh"),
    ]);

    expect(agent).toMatch(/reasoning:\s*assistantEffort/);
    expect(agent).toContain("HARNESST_ASSISTANT_EFFORT");
    expect(bootstrap).toContain('shellAssignment("HARNESST_ASSISTANT_EFFORT"');
    expect(entrypoint).toContain("export HARNESST_ASSISTANT_EFFORT");
  });
});
