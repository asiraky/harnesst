/**
 * Shared loader/action guards for project routes. Centralizes the "resolve the tenant, load
 * the organization-scoped project, require a connected repo" steps so every editor/route enforces the
 * same tenant-isolation + connected-repo invariants.
 */
import { data, redirect } from "react-router";

import type { SessionAuth } from "~/auth/session.server";
import {
  ensureWorkspace,
  listUserWorkspaces,
  requireBackOfHouse,
  resolveActiveWorkspace,
  setActiveWorkspace,
} from "~/auth/workspace.server";
import {
  findProjectAnyOrg,
  getProject,
  type Project,
} from "~/db/queries.server";
import { ASSISTANT_CONFIG_ROOT, isPlatformPath, PLATFORM_ROOT } from "~/eve/parse";

/** A project guaranteed to have a connected GitHub repo. */
export type ConnectedProject = Project & {
  repoInstallationId: string;
  repoOwner: string;
  repoName: string;
};

/**
 * Decide whether a project miss in the current org is actually a deep link into ANOTHER
 * workspace the viewer belongs to (issue #56). Pure over its injected lookups so the branching
 * is unit-testable without a DB or auth provider:
 *  - project unknown, or already in the current org → null (the normal 404 / no-op).
 *  - project in another org where the viewer IS a member → that org id (auto-switch target).
 *  - project in another org where the viewer is NOT a member → null (stays a 404).
 */
export async function resolveCrossWorkspaceRedirect(input: {
  projectId: string;
  currentOrgId: string | null;
  findById: (id: string) => Promise<{ orgId: string } | null>;
  isMember: (orgId: string) => Promise<boolean>;
}): Promise<string | null> {
  const project = await input.findById(input.projectId);
  if (!project) return null;
  if (project.orgId === input.currentOrgId) return null;
  return (await input.isMember(project.orgId)) ? project.orgId : null;
}

/**
 * Validate the Better Auth organization membership and load the org-scoped project, or throw
 * 403/404.
 *
 * Pass `opts.request` from page-document GET loaders (never from actions or api routes) to opt
 * into two request-aware behaviors (issue #56): an org-less session provisions/adopts/chooses a
 * workspace instead of 403-ing, and a `/repos/:id` link to a project in another workspace the
 * viewer belongs to silently switches them into it. A stale-tab POST with no request stays a
 * hard 404 — it must never silently change the active workspace.
 */
export async function requireProject(
  auth: SessionAuth,
  projectId: string | undefined,
  opts?: { request?: Request },
): Promise<Project> {
  let active = await resolveActiveWorkspace(auth);
  if (!active) {
    if (!opts?.request) throw data("No organization", { status: 403 });
    // Provision/adopt/choose a workspace. It redirects to replay whenever it changes the
    // Better Auth session, so reaching the next line means this session was already usable.
    await ensureWorkspace(opts.request, auth);
    active = await resolveActiveWorkspace(auth);
    if (!active) throw data("No organization", { status: 403 });
  }
  // Every /repos page and /api/repos resource route funnels through here, so this is THE
  // back-of-house chokepoint (D10): front-of-house members are turned away before any
  // project data loads. FOH routes use their own guard, never requireProject.
  requireBackOfHouse(active, opts?.request ? "page" : "api");
  const project = projectId
    ? await getProject(active.org.id, projectId)
    : undefined;
  if (!project) {
    if (opts?.request && projectId) {
      const target = await resolveCrossWorkspaceRedirect({
        projectId,
        currentOrgId: active.org.id,
        findById: (id) => findProjectAnyOrg(id),
        isMember: async (orgId) =>
          (await listUserWorkspaces(auth)).some(
            (workspace) => workspace.id === orgId,
          ),
      });
      if (target) {
        const url = new URL(opts.request.url);
        await setActiveWorkspace(auth, target);
        throw redirect(url.pathname + url.search);
      }
    }
    throw data("Project not found", { status: 404 });
  }
  return project;
}

/** Narrow a project to one with a connected repo, or throw 400. */
export function requireRepo(project: Project): ConnectedProject {
  if (!project.repoInstallationId || !project.repoOwner || !project.repoName) {
    throw data("Project has no connected repo", { status: 400 });
  }
  return project as ConnectedProject;
}

/**
 * Validate a user-supplied repo path stays within the editable surface — the root `agent/`
 * directory, a team member's `agents/<member>/agent/` (PRD §7.9), or the built-in assistant's
 * user-config surface under `.harnesst/assistant/`. Prevents editing files
 * outside those and path-traversal. Returns the normalized path or null if invalid.
 */
const ROOT_FILE_ALLOWLIST = new Set(["package.json", "package-lock.json"]);
const MEMBER_PATH =
  /^agents\/[A-Za-z0-9][\w.-]*\/(agent\/.+|package\.json|package-lock\.json)$/;

/** The assistant's user-config surface: markdown config + the JSON model override, never code. */
export { ASSISTANT_CONFIG_ROOT };
const ASSISTANT_CONFIG_PATH =
  /^\.harnesst\/assistant\/(instructions\.md|(?:skills|schedules)\/[A-Za-z0-9][\w.-]*\.md|assistant\.json)$/;

export function isAssistantConfigPath(path: string): boolean {
  return ASSISTANT_CONFIG_PATH.test(path);
}

/**
 * Platform-owned code is outside the editable surface (issue #254), and `normalizeAgentPath`
 * already rejects it — it simply isn't in the allowlist. But "invalid path" is the wrong answer
 * to "let me fix the channel": the path is well-formed, it belongs to someone else. Every write
 * site checks `isPlatformPath` first so the refusal says what to do instead.
 */
export { isPlatformPath };
export const PLATFORM_PATH_REFUSAL =
  `\`${PLATFORM_ROOT}/\` is platform-owned and cannot be edited. Channel behaviour is ` +
  "configured on the Deployment tab; if the platform files themselves are wrong, escalate to " +
  "an administrator.";

/**
 * The refusal for a RAW (still user-shaped) path, or null when it isn't platform-owned. Applies
 * the same leading-slash/whitespace tolerance as `normalizeAgentPath` so `/harnesst/model.ts`
 * refuses for the right reason instead of falling through to the generic rejection.
 */
export function platformPathRefusal(raw: string): string | null {
  return isPlatformPath(raw.trim().replace(/^\/+/, "")) ? PLATFORM_PATH_REFUSAL : null;
}

export function normalizeAgentPath(raw: string): string | null {
  const p = raw.trim().replace(/^\/+/, "");
  if (p.includes("..") || p.endsWith("/")) return null;
  // Change-sets may carry the dependency manifest (a tool can need an npm package); anything
  // else outside the agent surface (CI config, Dockerfile, app code) stays off-limits.
  if (ROOT_FILE_ALLOWLIST.has(p)) return p;
  if (p.startsWith("agent/")) return p;
  if (MEMBER_PATH.test(p)) return p;
  if (ASSISTANT_CONFIG_PATH.test(p)) return p;
  return null;
}
