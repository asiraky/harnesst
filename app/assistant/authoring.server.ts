/**
 * The assistant's control-plane knowledge service — the business logic behind the read-only
 * `api/assistant/*` callback endpoints.
 *
 * Under the coding-agent model the assistant no longer edits files through harnesst: it works in a real
 * per-conversation git checkout with native bash, and the control plane mirrors that checkout to a
 * PR (see `checkout-sync.server.ts`). So the old file read/write/dependency/scaffold/run-checks
 * callbacks are gone. What remains here is pure control-plane KNOWLEDGE the model can't get from its
 * sandbox: project context (roster, members, secret names, its own config) and the marketplace
 * catalog, plus the published-config bundle the container entrypoint materializes at boot.
 *
 * Every dependency is injected (`AuthoringDeps`), like `app/team/ask.server.ts`, so the surface
 * unit-tests against an in-memory store with zero I/O. Endpoints return plain JSON-able results;
 * business failures come back as `{ ok: false, error }` (the route serves them at HTTP 200 so the
 * model reads the text).
 */
import path from "node:path";

import semver from "semver";

import type { DataStore } from "~/data/ports";
import { listDrafts as listDraftsDefault } from "~/drafts/drafts.server";
import { ASSISTANT_CONFIG_ROOT } from "~/eve/parse";
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
import { LOCK_PATH, overlayLock } from "~/marketplace/lock";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type TemplateType,
} from "~/marketplace/manifest";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import type { ConnectedProject } from "~/project/guard.server";
import { drizzleSecretKV } from "~/seams/oss/secret-store";
import { getRuntime } from "~/seams/index.server";
import type { CatalogSource } from "~/seams/types";

/** The subset of a connected project the authoring service reads. */
export type AuthoringProject = ConnectedProject;

export interface AuthoringDeps {
  store: DataStore;
  getSource: typeof getAgentSource;
  listDrafts: typeof listDraftsDefault;
  /** Published (default-branch) content of a repo file, ignoring drafts (used by bundle). */
  readPublished: (
    project: AuthoringProject,
    path: string,
  ) => Promise<string | null>;
  /** Member-scoped secret names (never values), for project-context. */
  secretKeys: (input: {
    projectId: string;
    agentId: string;
  }) => Promise<string[]>;
  catalog: CatalogSource;
}

export function defaultAuthoringDeps(): AuthoringDeps {
  const runtime = getRuntime();
  return {
    store: runtime.data,
    getSource: getAgentSource,
    listDrafts: listDraftsDefault,
    readPublished: (project, p) =>
      readAgentFile(
        project.repoInstallationId,
        { owner: project.repoOwner, repo: project.repoName },
        p,
      ),
    secretKeys: ({ projectId, agentId }) =>
      drizzleSecretKV
        .listKeys({ projectId, agentId, environmentId: null })
        .catch(() => []),
    catalog: runtime.catalog,
  };
}

// ── Caller resolution ────────────────────────────────────────────────────────

export interface AssistantContext {
  project: AuthoringProject;
  agentId: string;
  deploymentId: string;
}

/**
 * Resolve the assistant caller from a token-verified deployment id: deployment → environment →
 * agent (must be kind 'assistant') → project. Returns null if anything is missing or the agent
 * is not the built-in assistant (so a leaked non-assistant deployment token can't reach these).
 */
export async function resolveAssistantContext(
  deploymentId: string,
  store: DataStore,
): Promise<AssistantContext | null> {
  const deployment = await store.deployments.findById(deploymentId);
  if (!deployment) return null;
  const env = await store.environments.findById(deployment.environmentId);
  if (!env) return null;
  const agent = await store.agents.findById(env.agentId);
  if (!agent || agent.kind !== "assistant") return null;
  const project = await store.projects.findById(agent.projectId);
  if (
    !project ||
    !project.repoInstallationId ||
    !project.repoOwner ||
    !project.repoName
  ) {
    return null;
  }
  return {
    project: project as AuthoringProject,
    agentId: agent.id,
    deploymentId,
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

type Ok<T> = { ok: true } & T;
type Result<T> = Ok<T> | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

// ── Endpoints ──────────────────────────────────────────────────────────────────

export async function projectContext(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<
  Result<{
    isTeam: boolean;
    members: { name: string; root: string; secretNames: string[] }[];
    assistantConfig: {
      instructions: boolean;
      skills: string[];
      schedules: string[];
      model: string | null;
      effort: ReasoningEffort | null;
    };
    stagedDrafts: { path: string; deletion: boolean }[];
    marketplaceInstalls: MarketplaceInstall[];
  }>
> {
  const agents = (await deps.store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  const isTeam = project.layout === "team";
  const members = await Promise.all(
    agents.map(async (a) => ({
      name: a.name,
      root: a.root,
      secretNames: await deps.secretKeys({
        projectId: project.id,
        agentId: a.id,
      }),
    })),
  );
  const bundle = await assembleBundle(project, deps);
  const drafts = await deps.listDrafts(project.id);
  const marketplaceInstalls = await describeInstalls(project, drafts, deps);
  return {
    ok: true,
    isTeam,
    members,
    assistantConfig: {
      instructions: bundle.instructions !== null,
      skills: Object.keys(bundle.files)
        .filter((p) => p.startsWith("skills/user/"))
        .map((p) => path.posix.basename(p)),
      schedules: Object.keys(bundle.files)
        .filter((p) => p.startsWith("schedules/user/"))
        .map((p) => path.posix.basename(p)),
      model: bundle.model,
      effort: bundle.effort,
    },
    stagedDrafts: drafts.map((d) => ({
      path: d.path,
      deletion: d.content === null,
    })),
    marketplaceInstalls,
  };
}

/** One marketplace install as the assistant sees it — provenance for the files it owns. */
export interface MarketplaceInstall {
  id: string;
  type: TemplateType;
  name: string;
  version: string;
  /** Owning roster member; null = the single-agent repo's root agent. */
  member: string | null;
  /** The repo-relative paths this install owns — the file → template mapping. */
  files: string[];
  /** The catalog's current version, when the catalog is reachable. */
  catalogVersion: string | null;
  /** True when the catalog carries a newer version than the one installed. */
  updateAvailable: boolean;
}

/**
 * Marketplace provenance for the assistant (issue: the legal-advisor skill shipped a frontmatter
 * key eve rejects, and the assistant — with no idea the file was template-owned — restructured the
 * agent's skills by hand instead of reporting a broken template).
 *
 * `harnesst-lock.json` has recorded the owned paths all along; nothing surfaced them to the model.
 * Pushing them into project-context (which `instructions.md` already makes mandatory before any
 * plan or change) means provenance is present BEFORE an approach is formed — the failure was that
 * the model never wondered where the file came from, and a tool it must think to call can't fix a
 * question it never asked.
 *
 * Lock reads follow the same overlay rule as every other surface: a staged install's lock draft
 * wins over the branch's file. A catalog outage degrades to no version info, never an error — the
 * ownership mapping is the load-bearing part and it comes from the repo.
 */
async function describeInstalls(
  project: AuthoringProject,
  drafts: Awaited<ReturnType<typeof listDraftsDefault>>,
  deps: AuthoringDeps,
): Promise<MarketplaceInstall[]> {
  const source = await deps.getSource(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
  });
  const lock = overlayLock(
    source.files[LOCK_PATH] ?? null,
    drafts.map((d) => ({ path: d.path, content: d.content })),
  );
  if (lock.installs.length === 0) return [];

  let index: { id: string; type: TemplateType; version: string }[] = [];
  try {
    index = (await deps.catalog.index()).templates;
  } catch {
    // Catalog unavailable — rows still carry ownership, just no update signal.
  }

  return lock.installs.map((entry) => {
    const row = index.find((r) => r.id === entry.id && r.type === entry.type);
    let updateAvailable = false;
    try {
      updateAvailable = row ? semver.gt(row.version, entry.version) : false;
    } catch {
      updateAvailable = false; // unparseable version on either side — say nothing.
    }
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      version: entry.version,
      member: entry.member,
      files: entry.files,
      catalogVersion: row?.version ?? null,
      updateAvailable,
    };
  });
}

export async function catalogOp(
  input: { op: string; type?: string; id?: string },
  deps: AuthoringDeps,
): Promise<Result<{ index?: unknown; template?: unknown }>> {
  if (input.op === "index") {
    return { ok: true, index: await deps.catalog.index() };
  }
  if (input.op === "template") {
    if (!input.type || !input.id)
      return fail("template lookup needs a type and id.");
    if (!TEMPLATE_TYPES.includes(input.type as TemplateType)) {
      return fail(`Unknown template type "${input.type}".`);
    }
    if (!isTemplateSlug(input.id)) return fail("Invalid template id.");
    try {
      const template = await deps.catalog.template(
        input.type as TemplateType,
        input.id,
      );
      return { ok: true, template };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  return fail(
    `Unknown catalog op "${input.op}" (expected "index" or "template").`,
  );
}

// ── Bundle (entrypoint materialization; published config only) ─────────────────

export interface AssistantBundle {
  /** Published `.harnesst/assistant/instructions.md`, or null. */
  instructions: string | null;
  /** agent-relative target path → content (skills/user/*, skills/installed/*, schedules/user/*). */
  files: Record<string, string>;
  /** Per-project model override from `.harnesst/assistant/assistant.json`, or null. */
  model: string | null;
  /** Explicit normalized effort paired with the project model, or provider default when null. */
  effort: ReasoningEffort | null;
}

export async function assembleBundle(
  project: AuthoringProject,
  deps: AuthoringDeps,
): Promise<AssistantBundle> {
  const source = await deps.getSource(project.repoInstallationId, {
    owner: project.repoOwner,
    repo: project.repoName,
  });
  const prefix = `${ASSISTANT_CONFIG_ROOT}/`;
  const configPaths = source.paths.filter((p) => p.startsWith(prefix));

  const files: Record<string, string> = {};
  let model: string | null = null;
  let effort: ReasoningEffort | null = null;
  let instructions: string | null = null;

  await Promise.all(
    configPaths.map(async (p) => {
      const content = await deps.readPublished(project, p);
      if (content === null) return;
      const rel = p.slice(prefix.length);
      if (rel === "instructions.md") {
        instructions = content;
      } else if (rel.startsWith("skills/") && rel.endsWith(".md")) {
        files[`skills/user/${path.posix.basename(rel)}`] = content;
      } else if (rel.startsWith("schedules/") && rel.endsWith(".md")) {
        files[`schedules/user/${path.posix.basename(rel)}`] = content;
      } else if (rel === "assistant.json") {
        try {
          const parsed = JSON.parse(content) as {
            model?: unknown;
            effort?: unknown;
          };
          if (typeof parsed.model === "string" && parsed.model.trim()) {
            model = parsed.model.trim();
            effort = isReasoningEffort(parsed.effort) ? parsed.effort : null;
          }
        } catch {
          // ignore a malformed override — the instance falls back to the env default.
        }
      }
    }),
  );

  // Installed marketplace skills (issue #274): one per install in the PUBLISHED lock, delivered
  // to `agent/skills/installed/<template-id>.md` — a namespace user skills can't collide with and
  // the container's reset() can wipe. Prefer the lock's install-time snapshot (the skill the
  // install shipped with); locks that predate the field backfill from the catalog's current
  // version. A catalog outage or a skill-less template degrades to no skill, never an error.
  const lock = overlayLock(source.files[LOCK_PATH] ?? null, []);
  const seenInstallIds = new Set<string>();
  for (const entry of lock.installs) {
    // The id becomes a container file path — only well-formed slugs may travel.
    if (!isTemplateSlug(entry.id) || seenInstallIds.has(entry.id)) continue;
    seenInstallIds.add(entry.id);
    let skill = entry.assistantSkill ?? null;
    if (skill === null) {
      try {
        skill = (await deps.catalog.template(entry.type, entry.id)).assistantSkill;
      } catch {
        skill = null;
      }
    }
    if (skill) files[`skills/installed/${entry.id}.md`] = skill;
  }

  return { instructions, files, model, effort };
}
