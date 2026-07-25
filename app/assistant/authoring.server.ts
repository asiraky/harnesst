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

import type { DataStore } from "~/data/ports";
import { listDrafts as listDraftsDefault } from "~/drafts/drafts.server";
import { ASSISTANT_CONFIG_ROOT } from "~/eve/parse";
import { getAgentSource } from "~/github/cached.server";
import { readAgentFile } from "~/github/repo.server";
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
  };
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
  /** agent-relative target path → content (skills/user/*, schedules/user/*). */
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

  return { instructions, files, model, effort };
}
