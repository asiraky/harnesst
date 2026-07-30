/**
 * The generated delegation tools (Team delegation — D2/§5, fire-and-forget — #269). Each template
 * is a source STRING baked into a member's image, importing only `eve/tools` + `zod`. We evaluate
 * them under the env contract — stubbing `defineTool` (returns the config) and injecting a
 * `process` — to prove: the roster is parsed crash-proof from HARNESST_TEAMMATES; the description
 * enumerates teammates; and the `teammate` input is a strict enum when teammates exist and an open
 * string when none are configured.
 *
 * The DESCRIPTIONS ARE THE ROUTING MECHANISM between the blocking ask and the fire-and-forget
 * tell — nothing else decides which one the model reaches for — so the wording is pinned here the
 * way behavior is pinned elsewhere: a later edit must not quietly turn a handoff verb into a
 * blocking one, leak the ask-only `waiting_on_human` note into tell, or let the shared
 * self-contained-message caveat drift between the two.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ASK_TEAMMATE_TOOL_SOURCE,
  CONTACT_USER_TOOL_SOURCE,
  TELL_TEAMMATE_TOOL_SOURCE,
} from "~/team/tool-template";

interface ToolConfig {
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (args: { teammate: string; message: string }) => Promise<unknown>;
}

/** Evaluate a template with a given process.env, returning the defineTool config. */
function evalTool(source: string, env: Record<string, string>): ToolConfig {
  const body = source
    .replace(/^import .*$/gm, "")
    .replace("export default defineTool(", "return defineTool(");
  const factory = new Function("defineTool", "z", "process", body);
  return factory((config: ToolConfig) => config, z, { env }) as ToolConfig;
}

const TOOLS = [
  {
    name: "ask-teammate",
    source: ASK_TEAMMATE_TOOL_SOURCE,
    mode: "ask",
  },
  {
    name: "tell-teammate",
    source: TELL_TEAMMATE_TOOL_SOURCE,
    mode: "tell",
  },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(TOOLS)("$name tool template", ({ source, mode }) => {
  it("imports only eve/tools and zod", () => {
    const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual(["eve/tools", "zod"]);
  });

  it("with HARNESST_TEAMMATES: enumerates teammates and enforces a strict enum", () => {
    const config = evalTool(source, {
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
    const config = evalTool(source, {});
    expect(config.description).toContain("No teammates are configured");
    expect(config.inputSchema.safeParse({ teammate: "anyone", message: "hi" }).success).toBe(true);
  });

  it("survives malformed HARNESST_TEAMMATES (degrades to empty roster)", () => {
    const config = evalTool(source, { HARNESST_TEAMMATES: "{ not json" });
    expect(config.description).toContain("No teammates are configured");
    expect(config.inputSchema.safeParse({ teammate: "x", message: "hi" }).success).toBe(true);
  });

  it("execute returns { ok:false } when the relay env is missing (never throws)", async () => {
    const config = evalTool(source, {
      HARNESST_TEAMMATES: JSON.stringify([{ name: "pm", role: "" }]),
    });
    const out = (await config.execute({ teammate: "pm", message: "hi" })) as {
      ok: boolean;
      error: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });

  it(`execute puts mode "${mode}" on the wire to /api/team/ask`, async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      async (input: string, init: { body: string }) => {
        url = String(input);
        body = JSON.parse(init.body) as Record<string, unknown>;
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      },
    );
    const config = evalTool(source, {
      HARNESST_TEAMMATES: JSON.stringify([{ name: "pm", role: "" }]),
      HARNESST_TEAM_URL: "http://relay.local/",
      HARNESST_TEAM_TOKEN: "tkn",
    });
    await config.execute({ teammate: "pm", message: "go" });
    expect(url).toBe("http://relay.local/api/team/ask");
    expect(body).toEqual({ teammate: "pm", message: "go", mode });
  });
});

/**
 * #269: the two descriptions ARE the ask/tell dispatch logic — pin the discriminating prose and
 * the shared caveat so neither can drift.
 */
describe("ask/tell description routing", () => {
  const env = {
    HARNESST_TEAMMATES: JSON.stringify([{ name: "pm", role: "Roadmap." }]),
  };
  const ask = evalTool(ASK_TEAMMATE_TOOL_SOURCE, env);
  const tell = evalTool(TELL_TEAMMATE_TOOL_SOURCE, env);

  it("ask states that it blocks for the answer and points at tell-teammate", () => {
    expect(ask.description).toContain("wait for their reply");
    expect(ask.description).toContain("BLOCKS");
    expect(ask.description).toContain("tell-teammate");
  });

  it("tell states the fire-and-forget consequence and points at ask-teammate", () => {
    expect(tell.description).toContain("without waiting");
    expect(tell.description).toContain("Hand a task off");
    expect(tell.description).toContain("will NOT see their reply");
    expect(tell.description).toContain("never wait for one or invent one");
    expect(tell.description).toContain("ask-teammate");
  });

  it("tell reaches handoff vocabulary; ask keeps the question vocabulary", () => {
    for (const verb of ["tell", "nudge", "remind"]) {
      expect(tell.description).toContain(verb);
    }
    expect(ask.description).toContain("Ask a teammate agent a question");
  });

  it("keeps the ask-only result notes out of tell (a dispatch can never return them)", () => {
    expect(ask.description).toContain("waiting_on_human");
    expect(ask.description).toContain("handed_off");
    expect(tell.description).not.toContain("waiting_on_human");
    expect(tell.description).not.toContain("handed_off");
  });

  it("shares the fresh-conversation caveat verbatim between both tools", () => {
    const caveat =
      "Every delegation opens a FRESH conversation with the teammate: they cannot see this " +
      "conversation, so write a complete, self-contained request that includes every piece of " +
      "context they need.";
    expect(ask.description).toContain(caveat);
    expect(tell.description).toContain(caveat);
  });
});

/**
 * #288 3c: contact-user is baked into EVERY image (not just team members) and upholds the
 * same source contract — imports only eve/tools + zod, crash-proof module load, execute never
 * throws. Its description is the dispatch logic between a fire-and-forget notification and
 * the blocking ask_question, so the discriminating prose is pinned like ask/tell's.
 */
describe("contact-user tool template", () => {
  interface ContactConfig {
    description: string;
    inputSchema: z.ZodTypeAny;
    execute: (args: { message: string; title?: string }) => Promise<unknown>;
  }
  const evalContact = (env: Record<string, string>) =>
    evalTool(CONTACT_USER_TOOL_SOURCE, env) as unknown as ContactConfig;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports only eve/tools and zod", () => {
    const imports = [
      ...CONTACT_USER_TOOL_SOURCE.matchAll(/^import .* from "([^"]+)";/gm),
    ].map((m) => m[1]);
    expect(imports.sort()).toEqual(["eve/tools", "zod"]);
  });

  it("states the fire-and-forget consequence and routes answers to ask_question", () => {
    const config = evalContact({});
    expect(config.description).toContain("Fire-and-forget");
    expect(config.description).toContain("will NOT get a reply");
    expect(config.description).toContain("never wait");
    expect(config.description).toContain("ask_question");
  });

  it("requires a message; the title is optional", () => {
    const config = evalContact({});
    expect(config.inputSchema.safeParse({ message: "hi" }).success).toBe(true);
    expect(
      config.inputSchema.safeParse({ message: "hi", title: "t" }).success,
    ).toBe(true);
    expect(config.inputSchema.safeParse({ title: "t" }).success).toBe(false);
  });

  it("execute returns { ok:false } when the notify env is missing (never throws)", async () => {
    const config = evalContact({});
    const out = (await config.execute({ message: "hi" })) as {
      ok: boolean;
      error: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not configured/i);
  });

  it("POSTs {message, title?} to HARNESST_FOH_NOTIFY_URL with the bearer", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    let authorization = "";
    vi.stubGlobal(
      "fetch",
      async (
        input: string,
        init: { body: string; headers: Record<string, string> },
      ) => {
        url = String(input);
        body = JSON.parse(init.body) as Record<string, unknown>;
        authorization = init.headers.authorization;
        return { ok: true, json: async () => ({ ok: true, sessionId: "ps_1" }) };
      },
    );
    const config = evalContact({
      HARNESST_FOH_NOTIFY_URL: "http://cp.local/api/foh/notify",
      HARNESST_TEAM_TOKEN: "tkn",
    });

    const out = await config.execute({ message: "done", title: "report" });

    expect(url).toBe("http://cp.local/api/foh/notify");
    expect(authorization).toBe("Bearer tkn");
    expect(body).toEqual({ message: "done", title: "report" });
    expect(out).toEqual({ ok: true, sessionId: "ps_1" });

    await config.execute({ message: "no title" });
    expect(body).toEqual({ message: "no title" });
  });

  it("returns { ok:false } when the fetch itself throws (never throws)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    const config = evalContact({
      HARNESST_FOH_NOTIFY_URL: "http://cp.local/api/foh/notify",
      HARNESST_TEAM_TOKEN: "tkn",
    });

    const out = (await config.execute({ message: "hi" })) as {
      ok: boolean;
      error: string;
    };

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/boom/);
  });
});
