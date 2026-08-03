/**
 * The eve agent config surface harnesst reads out of a repo.
 *
 * An eve agent lives under `agent/` in the repo (D3 — the repo is the source of truth):
 * `instructions.md`, `agent.ts`, and directories `tools/`, `skills/`, `subagents/`,
 * `hooks/`, `channels/`, `schedules/`, `connections/`. This type is the normalized,
 * UI-friendly shape every configuration surface renders and edits — it is fully editable, not
 * a read-only projection.
 *
 * A declared subagent directory (`<root>/subagents/<name>/`) is its own agent root in eve and
 * inherits none of its parent's authored slots (issue #344), so the same shape describes it —
 * filtered by the capability matrix below, because channels and schedules are root-only.
 *
 * Shared client/server (no server-only imports) so route components can type `loaderData`.
 */

/** A file- or directory-backed named resource inside the agent (e.g. a tool, a channel). */
export interface AgentResource {
  /** Display name — the file basename (sans extension) or directory name. */
  name: string;
  /** Repo-relative path to the file or directory. */
  path: string;
  /** True when the resource is a directory (skills/subagents are usually folders). */
  isDirectory: boolean;
}

/**
 * The authored sandbox definition for an agent (or subagent) — a singleton like
 * instructions, not a directory category. eve accepts `sandbox.<ext>` directly under the
 * agent root, or a `sandbox/` folder owning `sandbox/sandbox.<ext>` plus an optional
 * `workspace/` seed tree. Absent = eve's framework default sandbox.
 */
export interface AgentSandbox {
  /** Repo-relative path to the definition module (`…/sandbox.ts` or `…/sandbox/sandbox.ts`). */
  path: string;
  /** True when the folder layout carries a `sandbox/workspace/` seed tree. */
  hasWorkspace: boolean;
}

/** The eve concepts we surface. Keyed so the UI can iterate categories generically. */
export interface AgentConfig {
  /** Whether `agent/agent.ts` exists (the agent entrypoint module). */
  hasAgentModule: boolean;
  /** Contents of `agent/instructions.md`, or null when absent. */
  instructions: string | null;
  /** The agent's own sandbox definition, or null when it runs eve's framework default. */
  sandbox: AgentSandbox | null;
  /** Subagent sandbox definitions by subagent name (each subagent owns its own sandbox). */
  subagentSandboxes: Record<string, AgentSandbox>;
  tools: AgentResource[];
  skills: AgentResource[];
  subagents: AgentResource[];
  channels: AgentResource[];
  schedules: AgentResource[];
  connections: AgentResource[];
  hooks: AgentResource[];
}

/**
 * A subagent surfaced beneath its parent member (issue #146, made editable in #344). Subagents
 * live under `<root>/subagents/<name>/`, deploy inside their parent, and are invoked by
 * delegation — they are never roster members, so we present them beneath the parent with a
 * best-effort one-line description parsed from the tree, linking into their own nested
 * configuration context (`ConfigTarget`, `app/project/config-target.server.ts`).
 */
export interface SubagentSummary {
  /** Directory name of the subagent. */
  name: string;
  /** Repo-relative subagent directory, e.g. "agents/ivy/agent/subagents/quinn". */
  path: string;
  /** Best-effort one-liner from the subagent's `agent.ts` description or instructions.md; null if none. */
  description: string | null;
  /**
   * True when the subagent's module default-exports `defineDynamic(...)` — its availability is
   * decided per session at runtime, so the UI must not claim it is always active.
   */
  dynamic: boolean;
}

/**
 * Which agent roots a category is authored under. eve's declared subagents are their own agent
 * roots but do NOT own every slot: `channels` and `schedules` are root-only, so a subagent target
 * must neither render nor accept writes for them (issue #344 capability matrix).
 */
export type CategoryScope = "root" | "any";

/** The configuration surfaces harnesst can target: a top-level agent, or a declared subagent. */
export type TargetKind = "agent" | "subagent";

/**
 * The categories, in display order, with the subdirectory each maps to under an agent root and
 * the target kinds that may author it. This array is the single source of truth: parsing
 * (`buildAgentConfig`), the overview cards, the category list route's 404 gate, `CATEGORY_META`
 * and `RESOURCE_KINDS` all derive from it, so adding or removing an eve slot is a one-line change
 * here plus its presentation metadata.
 */
export const AGENT_CATEGORIES = [
  { key: "tools", dir: "tools", label: "Tools", scope: "any" },
  { key: "skills", dir: "skills", label: "Skills", scope: "any" },
  { key: "subagents", dir: "subagents", label: "Subagents", scope: "any" },
  { key: "channels", dir: "channels", label: "Channels", scope: "root" },
  { key: "schedules", dir: "schedules", label: "Schedules", scope: "root" },
  { key: "connections", dir: "connections", label: "Connections", scope: "any" },
  { key: "hooks", dir: "hooks", label: "Hooks", scope: "any" },
] as const satisfies ReadonlyArray<{
  key: keyof Pick<
    AgentConfig,
    | "tools"
    | "skills"
    | "subagents"
    | "channels"
    | "schedules"
    | "connections"
    | "hooks"
  >;
  dir: string;
  label: string;
  scope: CategoryScope;
}>;

export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * The categories a target of `kind` may author. Both the UI iteration and the server-side
 * category gate go through here, so a root-only category is never merely hidden — it is
 * unreachable as an action surface too.
 */
export function categoriesFor(kind: TargetKind): AgentCategory[] {
  return AGENT_CATEGORIES.filter(
    (category) => kind === "agent" || category.scope === "any",
  );
}
