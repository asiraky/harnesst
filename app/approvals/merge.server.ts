/**
 * harnesst merges approved merge gates. Branch protection lets only humans and harnesst's own
 * GitHub App push to a team's default branch, so the agents (and the repo's Actions) can't land
 * their own work: once a human approves the merge here, harnesst merges the PR at the approved
 * commit with a token narrowed to that one repo. The repo's Ledger workflow sees the merge and
 * moves the item on.
 *
 * merge_status: pending (to try, last error kept) → merged | failed (permanent, reason kept).
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "~/db/client.server";
import { approvals, projects, type Approval } from "~/db/schema";
import { mintNarrowedMergeToken } from "~/github/client.server";
import { listInstallationsForAccount } from "~/github/installations.server";
import {
  isMergeGate,
  mergePlan,
  mergeTarget,
  type PullRequestState,
} from "./merge-plan";

export interface MergeDeps {
  /** A merge token for `owner/name`, or null when harnesst's App isn't installed on it. */
  tokenFor?: (orgId: string, repo: string) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** How long harnesst keeps retrying a merge that hasn't gone through. */
const RETRY_WINDOW_MS = 7 * 86_400_000;
const RETRY_EVERY_MS = 60_000;

class RetryableMergeError extends Error {}

const details = (approval: Approval) => (approval.details ?? {}) as Record<string, unknown>;

/** Tries each of the org's installations on the repo's owner; GitHub refuses repos outside one. */
async function platformMergeToken(orgId: string, repo: string): Promise<string | null> {
  const [owner, name] = repo.split("/");
  for (const grant of await listInstallationsForAccount(orgId, owner)) {
    try {
      return (await mintNarrowedMergeToken({ installationId: grant.grantId, repo: name })).token;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 422/404: this installation doesn't cover the repo. Anything else is worth a retry.
      if (status === 422 || status === 404) continue;
      if (!status)
        console.warn(
          `[approvals] merge token for ${repo}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      throw new RetryableMergeError(
        `Couldn't get a GitHub token to merge${status ? ` (HTTP ${status})` : ""}.`,
      );
    }
  }
  return null;
}

/** GitHub's own message, trimmed; never echoes request headers. */
async function githubMessage(response: Response) {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message.slice(0, 200) : "";
  } catch {
    return "";
  }
}

async function github(
  request: typeof fetch,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  try {
    return await request(`https://api.github.com/repos/${path}`, {
      method: init.method ?? "GET",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RetryableMergeError("GitHub couldn't be reached.");
  }
}

async function record(
  id: string,
  values:
    | { mergeStatus: "merged"; mergeSha: string | null }
    | { mergeStatus: "pending" | "failed"; mergeError: string },
) {
  const set =
    values.mergeStatus === "merged"
      ? { ...values, mergeError: null, mergedAt: new Date() }
      : values;
  const [row] = await db
    .update(approvals)
    .set({ ...set, updatedAt: new Date() })
    // A concurrent attempt that already merged wins.
    .where(and(eq(approvals.id, id), or(isNull(approvals.mergeStatus), ne(approvals.mergeStatus, "merged"))))
    .returning();
  return row ?? null;
}

/**
 * One attempt at merging an approved merge gate. Records the outcome and returns the updated
 * row; never throws for GitHub's or the PR's state (the decision itself already stands).
 */
export async function mergeApproved(
  approval: Approval,
  deps: MergeDeps = {},
): Promise<Approval> {
  const info = details(approval);
  if (approval.status !== "approved" || !isMergeGate(info)) return approval;
  if (approval.mergeStatus === "merged" || approval.mergeStatus === "failed") return approval;
  const parsed = mergeTarget(info);
  if (!parsed.ok)
    return (await record(approval.id, { mergeStatus: "failed", mergeError: parsed.reason })) ?? approval;
  const { repo, number } = parsed.target;
  const request = deps.fetch ?? fetch;
  let outcome: Parameters<typeof record>[1];
  try {
    const [project] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, approval.projectId));
    if (!project) return approval;
    const token = await (deps.tokenFor ?? platformMergeToken)(project.orgId, repo);
    if (!token)
      throw new RetryableMergeError(
        `Install harnesst's GitHub App on ${repo} so it can merge approved changes.`,
      );
    const read = await github(request, token, `${repo}/pulls/${number}`);
    if (read.status === 404)
      outcome = { mergeStatus: "failed", mergeError: `Pull request #${number} wasn't found in ${repo}.` };
    else if (!read.ok)
      throw new RetryableMergeError(
        `GitHub couldn't read the pull request (HTTP ${read.status}). ${await githubMessage(read)}`.trim(),
      );
    else {
      const plan = mergePlan({ details: info, pr: (await read.json()) as PullRequestState });
      if (plan.action === "fail") outcome = { mergeStatus: "failed", mergeError: plan.reason };
      else if (plan.action === "merged") outcome = { mergeStatus: "merged", mergeSha: plan.mergeSha };
      else outcome = await merge(request, token, repo, plan.number, plan.body);
    }
  } catch (error) {
    if (!(error instanceof RetryableMergeError)) {
      // Unexpected (config, DB): keep the merge pending and say so without leaking internals.
      console.warn(
        `[approvals] merge ${approval.id} failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    outcome = {
      mergeStatus: "pending",
      mergeError:
        error instanceof RetryableMergeError
          ? error.message
          : "harnesst couldn't merge this yet. It will retry.",
    };
  }
  return (await record(approval.id, outcome)) ?? approval;
}

async function merge(
  request: typeof fetch,
  token: string,
  repo: string,
  number: number,
  body: { sha: string; merge_method: "squash" },
): Promise<Parameters<typeof record>[1]> {
  const response = await github(request, token, `${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body,
  });
  const message = response.ok ? "" : await githubMessage(response);
  if (response.ok) {
    const result = (await response.json()) as { merged?: boolean; sha?: string };
    if (result.merged) return { mergeStatus: "merged", mergeSha: result.sha ?? null };
    return { mergeStatus: "pending", mergeError: `GitHub didn't merge it: ${message || "no reason given"}.` };
  }
  // 409: the head moved off the approved sha, so this approval can never merge.
  if (response.status === 409)
    return {
      mergeStatus: "failed",
      mergeError: "The pull request changed after approval. The team needs a new merge approval.",
    };
  // 422: GitHub rejected the request itself (e.g. squash merges disabled); retrying won't help.
  if (response.status === 422)
    return { mergeStatus: "failed", mergeError: `GitHub refused the merge: ${message || "invalid request"}.` };
  // 405 (checks pending, base moved, not mergeable yet), 403 (branch protection), 5xx: retry.
  return {
    mergeStatus: "pending",
    mergeError: `GitHub hasn't merged it yet (HTTP ${response.status})${message ? `: ${message}` : ""}.`,
  };
}

/** Marks an approved merge gate as owed a merge. Returns the row if this call claimed it. */
async function markPending(id: string) {
  const [row] = await db
    .update(approvals)
    .set({ mergeStatus: "pending", updatedAt: new Date() })
    .where(and(eq(approvals.id, id), isNull(approvals.mergeStatus)))
    .returning();
  return row ?? null;
}

/** After a decision made here: claim the merge and try it straight away. */
export async function mergeAfterDecision(approval: Approval, deps: MergeDeps = {}) {
  if (approval.status !== "approved" || !isMergeGate(details(approval))) return approval;
  const claimed = await markPending(approval.id);
  if (!claimed) return approval;
  try {
    return await mergeApproved(claimed, deps);
  } catch (error) {
    console.warn(
      `[approvals] merge ${approval.id} threw: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return claimed;
  }
}

/**
 * The sync tick's share: retry pending merges, and pick up merge gates approved elsewhere (or
 * before a failed attempt to claim). Bounded to recent decisions so an old approval never
 * resurfaces as a merge.
 */
export async function syncApprovedMerges(
  deps: MergeDeps = {},
  scope: { projectId?: string } = {},
) {
  const since = new Date(Date.now() - RETRY_WINDOW_MS);
  const retryAfter = new Date(Date.now() - RETRY_EVERY_MS);
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "approved"),
        scope.projectId ? eq(approvals.projectId, scope.projectId) : undefined,
        or(
          isNull(approvals.mergeStatus),
          // A minute between attempts: GitHub rate-limits the App, and checks take that long anyway.
          and(
            eq(approvals.mergeStatus, "pending"),
            sql`${approvals.updatedAt} < ${retryAfter.toISOString()}::timestamptz`,
          ),
        ),
        sql`${approvals.details} -> 'input' ->> 'approve_to' = 'ready-to-merge'`,
        sql`coalesce(${approvals.decidedAt}, ${approvals.createdAt}) >= ${since.toISOString()}::timestamptz`,
      ),
    );
  for (const row of rows) {
    try {
      const claimed = row.mergeStatus === null ? await markPending(row.id) : row;
      if (claimed) await mergeApproved(claimed, deps);
    } catch (error) {
      console.warn(
        `[approvals] merge ${row.id} threw: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }
}
