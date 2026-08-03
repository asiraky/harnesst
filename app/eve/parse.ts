/**
 * Pure parser: repo file listing + a few known file contents -> normalized AgentConfig.
 *
 * Kept free of any GitHub/IO coupling so it's trivially unit-testable and reusable across
 * DeployTargets (a local checkout can feed the same shape). The GitHub layer
 * (`app/github/repo.server.ts`) is responsible for producing `AgentSource`.
 */
import { isDynamicSubagentModule } from "./agentModule";
import {
  AGENT_CATEGORIES,
  type AgentConfig,
  type AgentResource,
  type AgentSandbox,
  type SubagentSummary,
} from "./types";

/** Root directory that marks an eve agent. */
export const AGENT_ROOT = "agent";
/**
 * The built-in assistant's user-config surface. Not a roster member —
 * `detectAgentRoots` ignores it — but it is the repo-relative directory the assistant agent
 * row's `root` points at, so drafts under it attribute to the assistant.
 */
export const ASSISTANT_CONFIG_ROOT = ".harnesst/assistant";
/** Root directory that marks a team monorepo (PRD §7.9): `agents/<member>/agent/...`. */
export const TEAM_ROOT = "agents";
/** Committed sentinel that distinguishes a valid empty team from a truncated tree read. */
export const EMPTY_TEAM_MARKER = `${TEAM_ROOT}/README.md`;

/**
 * Platform-owned code, sibling to the agent root (issue #254). eve claims every directory it
 * knows under `agent/` and errors on any it doesn't (`DISCOVER_UNSUPPORTED_DIRECTORY`), and its
 * channel discovery validates every path segment as a channel slug — so a shared helper cannot
 * live under `agent/` at all. It CAN live beside it: the directory is inside the npm package, so
 * imports, tsconfig and `eve build` treat it as ordinary code, while eve's discovery (rooted at
 * the agent root, never scanning above it) never looks at it.
 *
 * Files here are written by the marketplace installer and by nothing else: the assistant and the
 * editors refuse them, and publish verifies their hashes against the lock.
 */
export const PLATFORM_ROOT = "harnesst";

/** `agent` -> `harnesst`; `agents/ivy/agent` -> `agents/ivy/harnesst`. */
export function platformRootForAgentRoot(agentRoot: string): string {
  const slash = agentRoot.lastIndexOf("/");
  const parent = slash === -1 ? "" : agentRoot.slice(0, slash + 1);
  return `${parent}${PLATFORM_ROOT}`;
}

/**
 * A repo-relative path inside a platform root: `harnesst/x.ts` or `agents/<member>/harnesst/x.ts`.
 *
 * Deliberately anchored and member-segment-validated: `.harnesst/assistant/**` (the assistant's
 * user-config surface — a different surface with a different owner) must NOT match, and neither
 * may a traversal like `agents/../harnesst/x`. A bare directory path matches nothing; only files
 * under the root are platform files.
 */
const PLATFORM_PATH = new RegExp(
  `^(?:${TEAM_ROOT}/[A-Za-z0-9][\\w.-]*/)?${PLATFORM_ROOT}/[^/].*$`,
);

export function isPlatformPath(path: string): boolean {
  if (path.endsWith("/")) return false;
  const segments = path.split("/");
  if (segments.includes("..") || segments.includes(".")) return false;
  return PLATFORM_PATH.test(path);
}

/** Detect the team repository shape even when it currently has no members. */
export function hasTeamLayout(paths: string[]): boolean {
  if (paths.some((p) => p === AGENT_ROOT || p.startsWith(`${AGENT_ROOT}/`))) return false;
  return paths.includes(EMPTY_TEAM_MARKER) || detectAgentRoots(paths).length > 0;
}

export interface AgentSource {
  /** Every file path in the repo, repo-relative, forward-slashed. */
  paths: string[];
  /** Pre-fetched contents for a handful of known text files (by repo-relative path). */
  files: Record<string, string>;
}

/** One member of the repo: its display name and the agent directory it lives under. */
export interface AgentRoot {
  /** "agent" for a single-agent repo; the member directory name for a team member. */
  name: string;
  /** Repo-relative agent directory, e.g. "agent" or "agents/product-manager/agent". */
  root: string;
}

/**
 * Detect the repo layout by convention (PRD §7.9): `agent/` at the root is a single-agent
 * repo; otherwise each `agents/<member>/agent/` directory is a team member. Single-agent
 * takes precedence so today's repos are unaffected by a stray `agents/` directory.
 */
export function detectAgentRoots(paths: string[]): AgentRoot[] {
  const singlePrefix = `${AGENT_ROOT}/`;
  if (paths.some((p) => p === AGENT_ROOT || p.startsWith(singlePrefix))) {
    return [{ name: AGENT_ROOT, root: AGENT_ROOT }];
  }

  const teamPrefix = `${TEAM_ROOT}/`;
  const members = new Map<string, AgentRoot>();
  for (const path of paths) {
    if (!path.startsWith(teamPrefix)) continue;
    const rest = path.slice(teamPrefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const member = rest.slice(0, slash);
    const inner = rest.slice(slash + 1);
    if (inner === AGENT_ROOT || inner.startsWith(singlePrefix)) {
      members.set(member, { name: member, root: `${TEAM_ROOT}/${member}/${AGENT_ROOT}` });
    }
  }
  return [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** True when the repo looks like an eve project — single-agent or team layout. */
export function isEveRepo(paths: string[]): boolean {
  return detectAgentRoots(paths).length > 0 || hasTeamLayout(paths);
}

/**
 * Collect the immediate children of `<root>/<dir>/` as resources. A child is either a file
 * (`agent/tools/foo.ts` -> "foo") or a directory (`agent/skills/bar/skill.ts` -> "bar",
 * marked isDirectory). Deduped by name, sorted.
 */
function childrenOf(paths: string[], root: string, dir: string): AgentResource[] {
  const prefix = `${root}/${dir}/`;
  const byName = new Map<string, AgentResource>();

  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;

    const slash = rest.indexOf("/");
    const isDirectory = slash !== -1;
    const segment = isDirectory ? rest.slice(0, slash) : rest;
    if (!segment) continue;

    // Skip test/spec files and dotfiles — they're not authored resources.
    if (!isDirectory && (/\.(test|spec)\.[cm]?[jt]sx?$/.test(segment) || segment.startsWith("."))) {
      continue;
    }

    const name = isDirectory ? segment : stripExtension(segment);
    if (byName.has(name)) continue;

    byName.set(name, {
      name,
      path: `${prefix}${segment}`,
      isDirectory,
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Module extensions eve's discovery accepts (verified against eve's discover/filesystem). */
const MODULE_FILE = /^sandbox\.(?:cts|mts|cjs|mjs|ts|js)$/;

/**
 * Detect the authored sandbox definition under `base` (an agent root, or a subagent
 * directory), mirroring eve's discovery order: a `sandbox/` folder owns the sandbox when it
 * exists (`sandbox/sandbox.<ext>`, optionally alongside a `workspace/` seed tree); otherwise
 * the top-level `sandbox.<ext>` shorthand. A `sandbox/` folder with only a workspace and no
 * module still runs eve's default backend — but there is no file to edit, so we surface it
 * only via the module-carrying layouts.
 */
export function detectSandbox(paths: string[], base: string): AgentSandbox | null {
  const folderPrefix = `${base}/sandbox/`;
  const folderModule = paths.find(
    (p) => p.startsWith(folderPrefix) && MODULE_FILE.test(p.slice(folderPrefix.length)),
  );
  if (folderModule) {
    return {
      path: folderModule,
      hasWorkspace: paths.some((p) => p.startsWith(`${folderPrefix}workspace/`)),
    };
  }
  const flat = paths.find(
    (p) => p.startsWith(`${base}/`) && MODULE_FILE.test(p.slice(base.length + 1)),
  );
  return flat ? { path: flat, hasWorkspace: false } : null;
}

/**
 * Best-effort one-line description from a `defineAgent({ description: '...' })` literal in an
 * agent/subagent module: string literals only, no module execution. Collapses internal
 * whitespace so a multi-line template still reads as one line.
 */
export function extractDescription(agentModuleSource: string | undefined): string | null {
  if (!agentModuleSource) return null;
  const match = agentModuleSource.match(/\bdescription\s*:\s*(['"`])([\s\S]*?)\1/);
  if (!match) return null;
  const text = match[2].trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : null;
}

/**
 * Build the normalized config from a repo listing + known file contents. `root` selects
 * which agent directory to read — "agent" (default, single-agent repos) or a team member's
 * `agents/<name>/agent` (§7.9).
 */
export function buildAgentConfig(source: AgentSource, root: string = AGENT_ROOT): AgentConfig {
  const { paths, files } = source;

  const categories = Object.fromEntries(
    AGENT_CATEGORIES.map((c) => [c.key, childrenOf(paths, root, c.dir)]),
  ) as Pick<
    AgentConfig,
    | "tools"
    | "skills"
    | "subagents"
    | "channels"
    | "schedules"
    | "connections"
    | "hooks"
  >;

  const agentModulePath = `${root}/agent.ts`;
  const instructionsPath = `${root}/instructions.md`;

  // Sandboxes are singletons per agent (and per subagent) — detected, not listed.
  const subagentSandboxes: Record<string, AgentSandbox> = {};
  for (const sub of categories.subagents) {
    if (!sub.isDirectory) continue;
    const sandbox = detectSandbox(paths, `${root}/subagents/${sub.name}`);
    if (sandbox) subagentSandboxes[sub.name] = sandbox;
  }

  return {
    hasAgentModule: paths.includes(agentModulePath),
    instructions: files[instructionsPath] ?? null,
    sandbox: detectSandbox(paths, root),
    subagentSandboxes,
    ...categories,
  };
}

/** First non-empty line of Markdown, stripped of a leading heading marker (best-effort blurb). */
function firstMarkdownLine(markdown: string | undefined): string | null {
  if (!markdown) return null;
  for (const line of markdown.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text) return text;
  }
  return null;
}

/**
 * The directory-backed subagent names under `<root>/subagents/`, deduped and sorted. Matches
 * childrenOf's "directory child" rule so it agrees with buildAgentConfig's `subagents` list.
 */
export function subagentDirNames(paths: string[], root: string = AGENT_ROOT): string[] {
  const prefix = `${root}/subagents/`;
  const names = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue; // only directory-backed subagents (like config.subagents)
    names.add(rest.slice(0, slash));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Every eagerly-readable subagent module/instructions path under `root`, at ANY nesting depth
 * (`<root>/subagents/a/subagents/b/agent.ts` included). The GitHub layer reads exactly these so a
 * nested configuration context can render its own description and instructions instead of a
 * blank page (issue #344). Sorted, deduped; only paths present in the tree are returned.
 */
export function subagentModuleFiles(paths: string[], root: string = AGENT_ROOT): string[] {
  const prefix = `${root}/`;
  const wanted = /(?:^|\/)subagents\/[^/]+\/(?:agent\.ts|instructions\.md)$/;
  const found = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    if (wanted.test(path.slice(prefix.length))) found.add(path);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Subagent summaries for one agent root (issue #146; made clickable in #344): one per subagent
 * directory under `<root>/subagents/`, with a best-effort description from the subagent's own
 * `agent.ts` (`description:` literal) or, failing that, the first line of its `instructions.md`.
 * Descriptions only populate when those files are in `source.files` (they are — see repo.server's
 * eager fetch); otherwise description is null. `dynamic` flags a `defineDynamic(...)` module, whose
 * availability is decided per session. Purely derived from the parsed tree — no new DB rows.
 *
 * Overlay drafts onto `source` first (see `overlayDrafts`) when saved-but-unpublished subagents
 * should appear.
 */
export function buildSubagentSummaries(
  source: AgentSource,
  root: string = AGENT_ROOT,
): SubagentSummary[] {
  const { paths, files } = source;
  return subagentDirNames(paths, root).map((name) => {
    const base = `${root}/subagents/${name}`;
    const module = files[`${base}/agent.ts`];
    const description =
      extractDescription(module) ??
      firstMarkdownLine(files[`${base}/instructions.md`]);
    return {
      name,
      path: base,
      description,
      dynamic: isDynamicSubagentModule(module),
    };
  });
}

/**
 * Apply a project's saved-but-unpublished changes to a repo source, so every surface derived from
 * it (discovery, `buildAgentConfig`, target resolution) sees what the user has actually saved:
 * a non-deletion draft adds or replaces its path and content, a deletion draft (`content: null`)
 * removes the path entirely. Pure — the caller supplies the drafts.
 */
export function overlayDrafts(
  source: AgentSource,
  drafts: ReadonlyArray<{ path: string; content: string | null }>,
): AgentSource {
  if (drafts.length === 0) return source;
  const paths = new Set(source.paths);
  const files = { ...source.files };
  for (const draft of drafts) {
    if (draft.content === null) {
      paths.delete(draft.path);
      delete files[draft.path];
      continue;
    }
    paths.add(draft.path);
    files[draft.path] = draft.content;
  }
  return { paths: [...paths], files };
}
