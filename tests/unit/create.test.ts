import { describe, expect, it } from "vitest";

import { memberScaffold, teamFiles } from "~/github/create.server";
import { EMPTY_TEAM_MARKER } from "~/eve/parse";

describe("repo scaffold", () => {
  it("creates an empty team skeleton with a durable marker and no member package", () => {
    const paths = teamFiles("my-team").map((file) => file.path);
    expect(paths).toContain(EMPTY_TEAM_MARKER);
    expect(paths).toContain("package.json");
    expect(paths).toContain("harnesst.json");
    expect(paths.some((path) => /^agents\/[^/]+\/agent\//.test(path))).toBe(
      false,
    );
    expect(
      paths.some((path) => /^agents\/[^/]+\/package\.json$/.test(path)),
    ).toBe(false);
  });

  it("starts new members on the workspace model resolver, with no baked model", () => {
    const files = memberScaffold("assistant");

    // The model module lands in the member's platform root — the sibling of agent/, outside
    // every directory eve discovers and outside every path the editors will write (issue #254).
    expect(files.map((file) => file.path)).toEqual([
      "agents/assistant/agent/instructions.md",
      "agents/assistant/agent/agent.ts",
      "agents/assistant/harnesst/model.ts",
      "agents/assistant/agent/sandbox.ts",
      "agents/assistant/package.json",
    ]);
    expect(files.some((file) => file.path.includes("/tools/"))).toBe(false);
    const agentTs = files.find((file) =>
      file.path.endsWith("agent/agent.ts"),
    )?.content;
    // The member resolves its model from harnesst's workspace configuration by NAME — no model
    // string anywhere in the repo.
    expect(agentTs).toContain("harnesstAgentModel('assistant')");
    expect(agentTs).toContain("from '../harnesst/model'");
    const moduleTs = files.find((file) =>
      file.path.endsWith("harnesst/model.ts"),
    )?.content;
    expect(moduleTs).toContain("export function harnesstAgentModel");
    expect(moduleTs).toContain("/model-config?agent=");
    const packageJson = files.find((file) =>
      file.path.endsWith("package.json"),
    );
    expect(packageJson?.content).toBeTypeOf("string");
    expect(JSON.parse(packageJson!.content as string).dependencies).toEqual({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      ai: "^7.0.0",
      zod: "^4.4.3",
      eve: "latest",
    });
  });
});
