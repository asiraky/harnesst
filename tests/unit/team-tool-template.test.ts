/**
 * The generated ask-teammate tool (Team delegation — D2/§5). The template is a source STRING baked
 * into a member's image, importing only `eve/tools` + `zod`. We evaluate it under the env contract
 * — stubbing `defineTool` (returns the config) and injecting a `process` — to prove: the roster is
 * parsed crash-proof from HARNESST_TEAMMATES; the description enumerates teammates; and the `teammate`
 * input is a strict enum when teammates exist and an open string when none are configured.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ASK_TEAMMATE_TOOL_PATH,
  ASK_TEAMMATE_TOOL_SOURCE,
} from "~/team/tool-template";

interface ToolConfig {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: { teammate: string; message: string }) => Promise<unknown>;
}

/** Evaluate the template with a given process.env, returning the defineTool config. */
function evalTool(env: Record<string, string>): ToolConfig {
  const body = ASK_TEAMMATE_TOOL_SOURCE.replace(/^import .*$/gm, "").replace(
    "export default defineTool(",
    "return defineTool(",
  );
  const factory = new Function("defineTool", "z", "process", body);
  return factory((config: ToolConfig) => config, z, { env }) as ToolConfig;
}

describe("ask-teammate tool template", () => {
  it("imports only eve/tools and zod", () => {
    const imports = [...ASK_TEAMMATE_TOOL_SOURCE.matchAll(/^import .* from "([^"]+)";/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["eve/tools", "zod"]);
    expect(ASK_TEAMMATE_TOOL_PATH).toBe("agent/tools/ask-teammate.ts");
  });

  it("with HARNESST_TEAMMATES: enumerates teammates and enforces a strict enum", () => {
    const config = evalTool({
      HARNESST_TEAMMATES: JSON.stringify([
        { name: "pm", role: "Manages the roadmap." },
        { name: "deployer", role: "" },
      ]),
    });
    expect(config.description).toContain("pm");
    expect(config.description).toContain("Manages the roadmap.");
    expect(config.description).toContain("deployer");
    expect(config.description).toContain("self-contained");
    expect(config.inputSchema.safeParse({ teammate: "pm", message: "hi" }).success).toBe(true);
    expect(config.inputSchema.safeParse({ teammate: "nobody", message: "hi" }).success).toBe(false);
    // A message is required.
    expect(config.inputSchema.safeParse({ teammate: "pm" }).success).toBe(false);
  });

  it("without HARNESST_TEAMMATES: empty roster, open string input, no crash", () => {
    const config = evalTool({});
    expect(config.description).toContain("No teammates are configured");
    expect(config.inputSchema.safeParse({ teammate: "anyone", message: "hi" }).success).toBe(true);
  });

  it("survives malformed HARNESST_TEAMMATES (degrades to empty roster)", () => {
    const config = evalTool({ HARNESST_TEAMMATES: "{ not json" });
    expect(config.description).toContain("No teammates are configured");
    expect(config.inputSchema.safeParse({ teammate: "x", message: "hi" }).success).toBe(true);
  });

  it("execute returns { ok:false } when the relay env is missing (never throws)", async () => {
    const config = evalTool({ HARNESST_TEAMMATES: JSON.stringify([{ name: "pm", role: "" }]) });
    const out = (await config.execute({ teammate: "pm", message: "hi" })) as {
      ok: boolean;
      error: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });
});
