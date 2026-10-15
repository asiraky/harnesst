/**
 * What harnesst does with an approved merge gate, given the PR as GitHub reports it. Pure, so
 * every refusal is testable. Agents can't merge into the default branch (branch protection
 * allowlists only humans and harnesst's App); this is the only path an approved change lands by,
 * so it merges exactly the commit the human approved, from the project's own repo, into its
 * default branch, or nothing.
 */

/** The fields of GitHub's pull request object the plan reads. */
export interface PullRequestState {
  number: number;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string; default_branch: string } };
}

export interface MergeTarget {
  /** owner/name, as the ledger project records it. */
  repo: string;
  number: number;
  headSha: string;
}

export type MergePlan =
  | { action: "merge"; number: number; body: { sha: string; merge_method: "squash" } }
  | { action: "merged"; mergeSha: string | null }
  | { action: "fail"; reason: string };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const SHA = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** Only the gate that approves a merge: approving it sends the work to ready-to-merge. */
export function isMergeGate(details: Record<string, unknown>): boolean {
  return obj(details.input).approve_to === "ready-to-merge";
}

/** The approved PR and commit, read from the stored ledger request. */
export function mergeTarget(
  details: Record<string, unknown>,
): { ok: true; target: MergeTarget } | { ok: false; reason: string } {
  const input = obj(details.input);
  const repo = obj(details.project).repo;
  if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo))
    return { ok: false, reason: "The ledger project has no GitHub repository." };
  const headSha = typeof input.head_sha === "string" ? input.head_sha : "";
  if (!SHA.test(headSha))
    return { ok: false, reason: "The approval isn't bound to a commit." };
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts.map(obj) : [];
  const pr = artifacts.find((a) => a.type === "pr");
  const match = typeof pr?.value === "string" ? PR_URL.exec(pr.value) : null;
  if (!match || !same(match[1], repo))
    return { ok: false, reason: `The approval has no pull request in ${repo}.` };
  return { ok: true, target: { repo, number: Number(match[2]), headSha } };
}

export function mergePlan(input: {
  details: Record<string, unknown>;
  pr: PullRequestState;
}): MergePlan {
  const parsed = mergeTarget(input.details);
  if (!parsed.ok) return { action: "fail", reason: parsed.reason };
  const { repo, number, headSha } = parsed.target;
  const { pr } = input;
  if (pr.number !== number || !same(pr.base.repo.full_name, repo))
    return { action: "fail", reason: `Pull request #${number} isn't in ${repo}.` };
  // A fork's branch isn't the team's code, whatever was approved.
  if (!same(pr.head.repo?.full_name, repo))
    return { action: "fail", reason: "The pull request comes from a fork." };
  if (pr.merged)
    return pr.head.sha === headSha
      ? { action: "merged", mergeSha: pr.merge_commit_sha }
      : { action: "fail", reason: "The pull request was merged at a different commit than the one approved." };
  if (pr.state !== "open")
    return { action: "fail", reason: "The pull request was closed without merging." };
  if (pr.head.sha !== headSha)
    return {
      action: "fail",
      reason: "The pull request changed after approval. The team needs a new merge approval.",
    };
  if (pr.base.ref !== pr.base.repo.default_branch)
    return {
      action: "fail",
      reason: `The pull request targets ${pr.base.ref}, not ${pr.base.repo.default_branch}.`,
    };
  // `sha` makes GitHub refuse the merge if the head moves between this read and the merge.
  return { action: "merge", number, body: { sha: headSha, merge_method: "squash" } };
}
