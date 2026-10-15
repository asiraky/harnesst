import { describe, expect, it } from "vitest";
import { isMergeGate, mergePlan, type PullRequestState } from "~/approvals/merge-plan";

const SHA = "a".repeat(40);
const MERGE_SHA = "c".repeat(40);

const details = (input: Record<string, unknown> = {}, repo: unknown = "Owner/app") => ({
  project: { name: "App", repo },
  input: {
    approve_to: "ready-to-merge",
    head_sha: SHA,
    artifacts: [{ type: "pr", value: "https://github.com/owner/app/pull/7", head_sha: SHA }],
    ...input,
  },
});

const pr = (over: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 7,
  state: "open",
  merged: false,
  merge_commit_sha: null,
  head: { sha: SHA, repo: { full_name: "owner/app" } },
  base: { ref: "main", repo: { full_name: "owner/app", default_branch: "main" } },
  ...over,
});

describe("mergePlan", () => {
  it("squash-merges the open PR at exactly the approved commit", () => {
    expect(mergePlan({ details: details(), pr: pr() })).toEqual({
      action: "merge",
      number: 7,
      body: { sha: SHA, merge_method: "squash" },
    });
  });

  it("records a PR already merged at the approved commit", () => {
    expect(
      mergePlan({ details: details(), pr: pr({ merged: true, state: "closed", merge_commit_sha: MERGE_SHA }) }),
    ).toEqual({ action: "merged", mergeSha: MERGE_SHA });
  });

  it("refuses a PR merged at some other commit", () => {
    const plan = mergePlan({
      details: details(),
      pr: pr({ merged: true, state: "closed", head: { sha: "b".repeat(40), repo: { full_name: "owner/app" } } }),
    });
    expect(plan.action).toBe("fail");
  });

  it("refuses when the head moved after approval", () => {
    const plan = mergePlan({
      details: details(),
      pr: pr({ head: { sha: "b".repeat(40), repo: { full_name: "owner/app" } } }),
    });
    expect(plan).toMatchObject({ action: "fail", reason: expect.stringMatching(/changed after approval/) });
  });

  it("refuses a PR that doesn't target the default branch", () => {
    const plan = mergePlan({
      details: details(),
      pr: pr({ base: { ref: "release", repo: { full_name: "owner/app", default_branch: "main" } } }),
    });
    expect(plan).toMatchObject({ action: "fail", reason: expect.stringMatching(/targets release/) });
  });

  it("refuses a PR from a fork, or one whose head repo is gone", () => {
    expect(
      mergePlan({ details: details(), pr: pr({ head: { sha: SHA, repo: { full_name: "stranger/app" } } }) }).action,
    ).toBe("fail");
    expect(mergePlan({ details: details(), pr: pr({ head: { sha: SHA, repo: null } }) }).action).toBe("fail");
  });

  it("refuses a PR closed without merging", () => {
    expect(mergePlan({ details: details(), pr: pr({ state: "closed" }) })).toMatchObject({
      action: "fail",
      reason: expect.stringMatching(/closed without merging/),
    });
  });

  it("refuses a PR artifact in another repo, a malformed one, or none", () => {
    for (const value of [
      "https://github.com/owner/other/pull/7",
      "https://github.com/owner/app/pull/7/files",
      "https://evil.example/owner/app/pull/7",
    ])
      expect(
        mergePlan({ details: details({ artifacts: [{ type: "pr", value }] }), pr: pr() }).action,
      ).toBe("fail");
    expect(mergePlan({ details: details({ artifacts: [] }), pr: pr() }).action).toBe("fail");
  });

  it("refuses a PR fetched from a different repo or number than the artifact names", () => {
    expect(mergePlan({ details: details(), pr: pr({ number: 8 }) }).action).toBe("fail");
    expect(
      mergePlan({
        details: details(),
        pr: pr({ base: { ref: "main", repo: { full_name: "owner/other", default_branch: "main" } } }),
      }).action,
    ).toBe("fail");
  });

  it("refuses an approval without a project repo or a bound commit", () => {
    expect(mergePlan({ details: details({}, null), pr: pr() }).action).toBe("fail");
    expect(mergePlan({ details: details({ head_sha: "main" }), pr: pr() }).action).toBe("fail");
  });
});

describe("isMergeGate", () => {
  it("is only the gate that approves to ready-to-merge", () => {
    expect(isMergeGate(details())).toBe(true);
    expect(isMergeGate(details({ approve_to: "build" }))).toBe(false);
    expect(isMergeGate({})).toBe(false);
  });
});
