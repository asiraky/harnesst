/**
 * The generated teammate delegation tools (Team delegation — D2/§5, fire-and-forget — #269). This
 * exports the SOURCE TEXT of two static eve tools that harnesst bakes into a team member's image at
 * build time (never the repo): `ask-teammate` (blocking — the caller needs the answer) and
 * `tell-teammate` (fire-and-forget — the caller hands work off and moves on). Both are generated
 * from ONE template and both POST to `/api/team/ask`, differing only in the `mode` they put on the
 * wire and the prose that routes the model between them. Each file is identical for every member
 * and every roster — all variability arrives via env (`HARNESST_TEAMMATES`, `HARNESST_TEAM_URL`,
 * `HARNESST_TEAM_TOKEN`) — so images stay reusable across redeploys and roster changes.
 *
 * The DESCRIPTIONS ARE THE FEATURE: they are the only thing that decides whether an intent becomes
 * a blocking ask or a handoff, so their wording is dispatch logic, not documentation. The shared
 * caveat (fresh conversation, self-contained message) is a single constant used by both, so it
 * cannot drift; the `waiting_on_human`/`handed_off` result notes are ask-only, because a dispatched
 * handoff can never return them. Tests pin the wording.
 *
 * Contract each source must uphold (also what the tests pin):
 *  - imports ONLY `eve/tools` + `zod` (both in every member's package.json);
 *  - module-load is crash-proof: bad/absent `HARNESST_TEAMMATES` → empty roster, tool still defines;
 *  - the description enumerates teammates + roles and tells the model asks must be self-contained;
 *  - `execute` NEVER throws — every failure path returns `{ ok: false, error }`.
 */

/** Repo-relative paths the tools are written to inside a member's build context. */
export const ASK_TEAMMATE_TOOL_PATH = "agent/tools/ask-teammate.ts";
export const TELL_TEAMMATE_TOOL_PATH = "agent/tools/tell-teammate.ts";

/**
 * The one shared caveat both descriptions carry, verbatim — a single constant so the two tools
 * cannot drift apart on it (#269).
 */
const SHARED_CONTEXT_CAVEAT =
  "Every delegation opens a FRESH conversation with the teammate: they cannot see this " +
  "conversation, so write a complete, self-contained request that includes every piece of " +
  "context they need.";

interface ModeSpec {
  mode: "ask" | "tell";
  /** First line of the description — the verb, the consequence, and the pointer to the twin. */
  intro: string;
  rosterHeading: string;
  /** Trailing caveats — always starts with the shared constant. */
  caveats: string;
  /** Description when no teammates are configured (degraded roster). */
  empty: string;
  /** The `execute` lines that pick the fetch timeout, mode-specific. */
  timeoutSource: string;
}

const ASK_SPEC: ModeSpec = {
  mode: "ask",
  intro:
    "Ask a teammate agent a question and wait for their reply. Your turn BLOCKS until the " +
    "teammate finishes, so use this only when you need their answer before you can continue. " +
    "To hand work off without waiting, use tell-teammate.",
  rosterHeading: "Teammates you can ask:",
  caveats:
    SHARED_CONTEXT_CAVEAT +
    " The returned value is the teammate's final answer. If it instead " +
    'carries status "waiting_on_human", the teammate paused to ask a human a question - ' +
    "the delegation resumes and finishes on its own once a human answers, so do not re-ask. " +
    'Status "handed_off" means the reply stream dropped but the teammate is STILL working ' +
    "on it - the task is handed over and tracked, so do not re-ask or redo it either.",
  empty:
    "Ask a teammate agent for help and get their reply. No teammates are configured for " +
    "this agent right now, so there is no one to contact.",
  timeoutSource: `    const budgetMs = Number(process.env.HARNESST_DELEGATION_TIMEOUT_MS || "600000");
    const timeoutMs = (Number.isFinite(budgetMs) ? budgetMs : 600000) + 60000;`,
};

const TELL_SPEC: ModeSpec = {
  mode: "tell",
  intro:
    "Hand a task off to a teammate agent without waiting. This returns as soon as the " +
    "teammate has started: you will NOT see their reply or the outcome, so never wait for " +
    "one or invent one. Use it to tell, nudge, remind, or get a teammate to go do something " +
    "whose result you don't need; to ask a question you need answered, use ask-teammate.",
  rosterHeading: "Teammates you can tell:",
  caveats: SHARED_CONTEXT_CAVEAT,
  empty:
    "Hand a task off to a teammate agent without waiting. No teammates are configured for " +
    "this agent right now, so there is no one to contact.",
  // The relay answers a tell as soon as the peer's turn is dispatched; the budget only has to
  // cover waking a stopped teammate first, never their work.
  timeoutSource: `    const timeoutMs = 180000;`,
};

/** Render one mode's full tool source. All mode-varying prose is injected as JSON literals. */
function buildToolSource(spec: ModeSpec): string {
  return `import { defineTool } from "eve/tools";
import { z } from "zod";

// harnesst bakes this file into a team member's image (see app/team/tool-template.ts). All
// variability arrives via env — do not edit; a repo file at this path overrides it.

/** Parse HARNESST_TEAMMATES defensively — any malformed value yields an empty roster. */
function loadTeammates() {
  try {
    const raw = process.env.HARNESST_TEAMMATES;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.name === "string")
      .map((t) => ({ name: t.name, role: typeof t.role === "string" ? t.role : "" }));
  } catch {
    return [];
  }
}

function buildDescription(teammates) {
  if (teammates.length === 0) {
    return ${JSON.stringify(spec.empty)};
  }
  const roster = teammates
    .map((t) => "- " + t.name + (t.role ? ": " + t.role : ""))
    .join("\\n");
  return [
    ${JSON.stringify(spec.intro)},
    "",
    ${JSON.stringify(spec.rosterHeading)},
    roster,
    "",
    ${JSON.stringify(spec.caveats)},
  ].join("\\n");
}

const teammates = loadTeammates();
const names = teammates.map((t) => t.name);

export default defineTool({
  description: buildDescription(teammates),
  inputSchema: z.object({
    teammate: names.length ? z.enum(names) : z.string(),
    message: z
      .string()
      .describe(
        "A complete, self-contained request for the teammate. They cannot see your " +
          "conversation, so include all the context and specifics they need.",
      ),
  }),
  async execute({ teammate, message }) {
    const baseUrl = process.env.HARNESST_TEAM_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!baseUrl || !token) {
      return { ok: false, error: "Teammate delegation is not configured for this agent." };
    }
${spec.timeoutSource}
    try {
      const res = await fetch(baseUrl.replace(/\\/+$/, "") + "/api/team/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({ teammate, message, mode: ${JSON.stringify(spec.mode)} }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const error =
          body && typeof body.error === "string"
            ? body.error
            : "Delegation failed (HTTP " + res.status + ").";
        return { ok: false, error };
      }
      return body || { ok: false, error: "The delegation relay returned an empty response." };
    } catch (error) {
      return {
        ok: false,
        error: "Couldn't reach your teammate: " + (error && error.message ? error.message : String(error)),
      };
    }
  },
});
`;
}

/** The full source text of the generated tool files. */
export const ASK_TEAMMATE_TOOL_SOURCE = buildToolSource(ASK_SPEC);
export const TELL_TEAMMATE_TOOL_SOURCE = buildToolSource(TELL_SPEC);
