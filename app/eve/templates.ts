/**
 * Starter templates for new agent resources (the "New tool/skill/…" action on the agent page).
 *
 * Shapes mirror what eve itself scaffolds (eve@0.19 `setup/scaffold` + public definitions):
 * tools are `defineTool` modules from `eve/tools`, skills are markdown frontmatter,
 * schedules are markdown with a `cron` frontmatter, channels/connections are the module
 * shapes from eve's own catalog. Pure module (client+server safe).
 */
import type { AGENT_CATEGORIES } from "./types";

type CategoryKey = (typeof AGENT_CATEGORIES)[number]["key"];

export interface ResourceKind {
  key: CategoryKey;
  /** Singular, for buttons/dialog titles: "New tool". */
  label: string;
  ext: ".ts" | ".md";
  /** One-liner shown in the create dialog. */
  hint: string;
  template(name: string): string;
}

/** kebab-case a human name into a file slug (eve derives resource identity from it). */
export function slugifyResourceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function titleCase(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const RESOURCE_KINDS: Record<CategoryKey, ResourceKind> = {
  tools: {
    key: "tools",
    label: "tool",
    ext: ".ts",
    hint: "A function the model can call — described inputs, typed output.",
    template: (name) => `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "What ${titleCase(name)} does and when the agent should use it.",
  inputSchema: z.object({
    query: z.string().describe("What to look up"),
  }),
  async execute({ query }) {
    // TODO: implement — return any JSON-serializable value.
    return { answer: \`${name} received: \${query}\` };
  },
});
`,
  },
  skills: {
    key: "skills",
    label: "skill",
    ext: ".md",
    hint: "Markdown guidance the agent follows when the skill applies.",
    template: (name) => `---
description: When the agent should use the ${titleCase(name)} skill.
---

# ${titleCase(name)}

Write the step-by-step guidance the agent should follow when this skill applies.

1. First…
2. Then…
`,
  },
  subagents: {
    key: "subagents",
    label: "subagent",
    ext: ".md",
    hint: "A focused helper agent the main agent can delegate to.",
    template: (name) => `---
description: What the ${titleCase(name)} subagent is for and when to delegate to it.
---

# ${titleCase(name)}

Instructions for this subagent: its job, its boundaries, and what a good
result looks like.
`,
  },
  channels: {
    key: "channels",
    label: "channel",
    ext: ".ts",
    hint: "A way to reach the agent (HTTP, Slack, web chat…).",
    template: () => `import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for \`eve dev\` and the REPL; ignored in production.
    localDev(),
    // Replace with your app's auth provider before real traffic.
    placeholderAuth(),
  ],
});
`,
  },
  schedules: {
    key: "schedules",
    label: "schedule",
    ext: ".md",
    hint: "A cron trigger with instructions for what to do when it fires.",
    template: (name) => `---
cron: "0 9 * * 1-5"
---

Each time this fires, the agent should: describe the ${titleCase(name)} task here.
`,
  },
  connections: {
    key: "connections",
    label: "connection",
    ext: ".ts",
    hint: "An external service the agent can use (MCP server or API).",
    template: (
      name,
    ) => `import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://example.com/mcp",
  description: "What the ${titleCase(name)} connection provides.",
  // auth: { getToken: async () => ({ token: process.env.MY_SERVICE_TOKEN! }) },
});
`,
  },
};

/** Path a new resource of `kind` named `slug` lives at, under an agent root (§7.9). */
export function resourcePath(
  kind: ResourceKind,
  slug: string,
  root = "agent",
): string {
  return `${root}/${kind.key}/${slug}${kind.ext}`;
}

/**
 * Default sandbox definition — scaffolded into new agents and used as the starter template
 * when a repo without one opens the sandbox editor. Behaviorally identical to eve's
 * framework default until the human exposes a secret: with no HARNESST_SANDBOX_ENV names the
 * env map is empty, which is exactly what `defaultBackend()` gets when it isn't configured.
 *
 * The HARNESST_SANDBOX_ENV contract (harnesst convention, both sides must agree):
 *  - harnesst's deploy pipeline sets it on the INSTANCE container to the comma-separated NAMES
 *    of the secrets marked "available in the agent's sandbox shell" (Settings → Secrets).
 *    Names only, never values — the values are already in the instance env as secrets.
 *  - This module forwards exactly those variables into the sandbox backend's `env`, so the
 *    agent's bash sees them. Everything else stays sealed out of the sandbox (eve's
 *    sealed-by-default model — sandboxes never inherit the instance's process env).
 *
 * Two propagation semantics worth knowing (verified against eve@0.19.0's docker backend):
 *  - The resolved backend options INCLUDING env values are hashed into the template image
 *    reference — so for templated sandboxes, rotating an exposed secret's value changes the
 *    expected `eve-sbx-tpl-*` name, and the next `eve start` (deploy/wake) rebuilds it
 *    automatically. Harmless, just the slow path once.
 *  - Session containers are REUSED by name (docker start, not recreate), so env changes
 *    reach NEW sessions only; existing sessions keep the env they started with.
 */
export const DEFAULT_SANDBOX_MODULE = `import { defaultBackend, defineSandbox } from "eve/sandbox";

// This agent's sandbox: the isolated shell its bash/read/write tools run in. Add a
// bootstrap() hook to preinstall CLIs (gh, wrangler, ...) — it runs ONCE and is snapshotted
// into a reusable template, so sessions start fast with the tools already in place.
//
// harnesst convention: HARNESST_SANDBOX_ENV is a comma-separated allowlist of env var NAMES
// (managed from the Secrets page — "available in the agent's sandbox shell") forwarded from
// the instance into the sandbox. Everything else stays sealed out of the shell.
const names = (process.env.HARNESST_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((n) => [n, process.env[n] ?? ""]));

export default defineSandbox({
  backend: () => defaultBackend({ docker: { env }, vercel: { env } }),
});
`;

/** Path an agent's sandbox definition is created at, under an agent root (§7.9). */
export function sandboxPath(root = "agent"): string {
  return `${root}/sandbox.ts`;
}
