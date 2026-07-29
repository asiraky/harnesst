/**
 * The generated `ask-teammate` tool (Team delegation — D2/§5). This exports the SOURCE TEXT of a
 * static eve tool that harnesst bakes into a team member's image at build time (never the repo). The
 * file is identical for every member and every roster — all variability arrives via env
 * (`HARNESST_TEAMMATES`, `HARNESST_TEAM_URL`, `HARNESST_TEAM_TOKEN`) — so images stay reusable across
 * redeploys and roster changes.
 *
 * Contract the source must uphold (also what the tests pin):
 *  - imports ONLY `eve/tools` + `zod` (both in every member's package.json);
 *  - module-load is crash-proof: bad/absent `HARNESST_TEAMMATES` → empty roster, tool still defines;
 *  - the description enumerates teammates + roles and tells the model asks must be self-contained;
 *  - `execute` NEVER throws — every failure path returns `{ ok: false, error }`.
 */

/** Repo-relative path the tool is written to inside a member's build context. */
export const ASK_TEAMMATE_TOOL_PATH = "agent/tools/ask-teammate.ts";

/** The full source text of the generated tool file. */
export const ASK_TEAMMATE_TOOL_SOURCE = `import { defineTool } from "eve/tools";
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
    return (
      "Ask a teammate agent for help and get their reply. No teammates are configured for " +
      "this agent right now, so there is no one to contact."
    );
  }
  const roster = teammates
    .map((t) => "- " + t.name + (t.role ? ": " + t.role : ""))
    .join("\\n");
  return [
    "Delegate a task to a teammate agent and get their reply back.",
    "",
    "Teammates you can ask:",
    roster,
    "",
    "Each ask opens a FRESH conversation with the teammate: they cannot see this " +
      "conversation, so write a complete, self-contained request that includes every piece of " +
      "context they need. The returned value is the teammate's final answer. If it instead " +
      'carries status "waiting_on_human", the teammate paused to ask a human a question - ' +
      "the delegation resumes and finishes on its own once a human answers, so do not re-ask. " +
      'Status "handed_off" means the reply stream dropped but the teammate is STILL working ' +
      "on it - the task is handed over and tracked, so do not re-ask or redo it either.",
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
          "conversation, so include all the context and specifics they need to answer.",
      ),
  }),
  async execute({ teammate, message }) {
    const baseUrl = process.env.HARNESST_TEAM_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!baseUrl || !token) {
      return { ok: false, error: "Teammate delegation is not configured for this agent." };
    }
    const budgetMs = Number(process.env.HARNESST_DELEGATION_TIMEOUT_MS || "600000");
    const timeoutMs = (Number.isFinite(budgetMs) ? budgetMs : 600000) + 60000;
    try {
      const res = await fetch(baseUrl.replace(/\\/+$/, "") + "/api/team/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({ teammate, message }),
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
