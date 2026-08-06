/**
 * The configuration target a repo route operates on (issue #344).
 *
 * Until now every loader/action hardcoded `active.root` — the roster member's agent directory —
 * so a declared subagent, which eve treats as its own agent root, had no way to be addressed.
 * A `ConfigTarget` names the directory a page configures AND the deployment it belongs to, and
 * every path a route touches is derived from it rather than from user input.
 *
 * The nested URL is `…/sub/:subPath`, where `subPath` is the chain of subagent directory names
 * joined by `~` (`researcher`, `researcher~fact-checker`). `~` is outside the validated segment
 * charset, so the encoding is collision-free and the delimiter can never appear in a name.
 */
import { data } from "react-router";

import type { Agent, DataStore } from "~/data/ports";
import { listDrafts } from "~/drafts/drafts.server";
import {
  overlayDrafts,
  subagentDirNames,
  subagentRootFor,
  type AgentSource,
} from "~/eve/parse";
import { getAgentSource } from "~/github/cached.server";
import {
  agentFromParams,
  requireActiveAgent,
  resolveAgentContext,
  type AgentContext,
} from "./agent-context.server";

/**
 * A resolved configuration surface. `root` is the directory whose `instructions.md`, categories
 * and sandbox the page reads and writes; `deploymentRoot` is the roster member's root — the thing
 * that actually builds, deploys and owns `package.json`, secrets and channels. They are equal for
 * an agent target and differ for a subagent, which "runs inside and deploys with" its member.
 */
export type ConfigTarget =
  | {
      kind: "agent";
      /** Roster member name (the `agent` pseudo-member for single-agent repos). */
      member: string;
      root: string;
      deploymentRoot: string;
    }
  | {
      kind: "subagent";
      member: string;
      /** Subagent directory names from the member root down, e.g. ["researcher", "fact-checker"]. */
      subagentPath: string[];
      root: string;
      deploymentRoot: string;
    };

/** Delimiter joining subagent segments in the `:subPath` URL param. */
export const SUBAGENT_PATH_DELIMITER = "~";

/**
 * A subagent directory name harnesst is willing to address. Mirrors the member-segment rule in
 * `guard.server`'s MEMBER_PATH: must start alphanumeric, then word chars/dot/dash — which
 * excludes `.`, `..`, empty segments, slashes and the `~` delimiter by construction.
 */
const SEGMENT = /^[A-Za-z0-9][\w.-]*$/;

/**
 * The subagent chain a route's `:subPath` param names, or null when the route has no nested
 * segment (i.e. the target is the member itself). Validation of the individual segments is
 * `resolveConfigTarget`'s job — this only decodes.
 */
export function subagentSegmentsFromParams(params: {
  subPath?: string;
}): string[] | null {
  const raw = params.subPath;
  if (raw === undefined) return null;
  return raw.split(SUBAGENT_PATH_DELIMITER);
}

export interface ConfigTargetContext extends AgentContext {
  /** Narrowed: a target only resolves once there IS an active member. */
  active: Agent;
  target: ConfigTarget;
}

export interface ResolveConfigTargetInput {
  projectId: string;
  /** The `:agentName` URL segment, or null for repo-level (single-agent) URLs. */
  agentName: string | null;
  /** The decoded `:subPath` segments, or null for a member-level target. */
  subSegments: string[] | null;
  /**
   * The repo tree the target must exist in. Required for a nested target (that existence check
   * IS the authorization); a member-level resolution never reads it, so pages that only
   * sometimes go nested may skip the fetch.
   */
  source?: AgentSource;
  /** The project's saved drafts, so a saved-but-unpublished subagent resolves. */
  drafts?: ReadonlyArray<{ path: string; content: string | null }>;
  store?: DataStore;
}

/**
 * Resolve the roster, the active member, and the configuration target one request addresses.
 *
 * For a subagent target this is also the authorization boundary, so it is deliberately strict:
 *
 *  - the member must match EXACTLY. `resolveAgentContext` falls back to `roster[0]` for an
 *    unknown name (fine for a member URL — you land on the first member), but combined with an
 *    arbitrary subagent path that fallback would mint a phantom root under an unrelated member.
 *  - every segment must satisfy `SEGMENT`, and
 *  - every level's directory must actually exist in the draft-overlaid tree. Drafts are overlaid
 *    first so a saved-but-unpublished subagent resolves and a saved deletion stops resolving.
 */
export async function resolveConfigTarget(
  input: ResolveConfigTargetInput,
): Promise<ConfigTargetContext> {
  const ctx = await resolveAgentContext(input.projectId, input.agentName, input.store);
  requireActiveAgent(ctx.active, input.projectId);
  const active = ctx.active;

  if (input.subSegments === null) {
    return {
      ...ctx,
      active,
      target: {
        kind: "agent",
        member: active.name,
        root: active.root,
        deploymentRoot: active.root,
      },
    };
  }

  // No `?? roster[0]` for a nested target — see the doc comment above.
  if (input.agentName === null) {
    if (ctx.isTeam) throw notFound();
  } else if (active.name !== input.agentName && active.id !== input.agentName) {
    throw notFound();
  }

  const segments = input.subSegments;
  if (segments.length === 0 || !segments.every((name) => SEGMENT.test(name))) {
    throw notFound();
  }

  if (!input.source) throw notFound();
  const overlaid = overlayDrafts(input.source, input.drafts ?? []);
  let parentRoot = active.root;
  for (const name of segments) {
    if (!subagentDirNames(overlaid.paths, parentRoot).includes(name)) throw notFound();
    parentRoot = `${parentRoot}/subagents/${name}`;
  }

  return {
    ...ctx,
    active,
    target: {
      kind: "subagent",
      member: active.name,
      subagentPath: segments,
      root: parentRoot,
      deploymentRoot: active.root,
    },
  };
}

function notFound() {
  return data("Subagent not found.", { status: 404 });
}

/**
 * The target a repo ROUTE addresses, resolved from its URL params alone — the form is never
 * consulted, which is the whole point (a posted member name would let one page write into
 * another's tree). `fallbackMember` covers legacy repo-level links that carry the member only
 * inside the edited path.
 *
 * The repo tree and the project's drafts are fetched only for a nested target, where a
 * subagent's existence in the draft-overlaid tree IS the authorization check.
 */
export async function resolveRouteTarget(
  project: {
    id: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  },
  params: { agentName?: string; subPath?: string },
  fallbackMember?: string | null,
): Promise<ConfigTargetContext> {
  const subSegments = subagentSegmentsFromParams(params);
  const agentName =
    agentFromParams(params) ?? (subSegments ? null : (fallbackMember ?? null));
  if (!subSegments) {
    return resolveConfigTarget({ projectId: project.id, agentName, subSegments });
  }
  const [source, drafts] = await Promise.all([
    getAgentSource(project.repoInstallationId, {
      owner: project.repoOwner,
      repo: project.repoName,
    }),
    listDrafts(project.id),
  ]);
  return resolveConfigTarget({
    projectId: project.id,
    agentName,
    subSegments,
    source,
    drafts: drafts.map((d) => ({ path: d.path, content: d.content })),
  });
}
