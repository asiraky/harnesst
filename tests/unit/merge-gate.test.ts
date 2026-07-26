/**
 * The pre-merge build gate for assistant conversation branches (issue #137) — pure logic,
 * no DB/GitHub/docker. Pins the contract the old client-side single-root inference broke:
 * every affected member root is built (recomputed server-side), team shared/root files build
 * nothing, and the gate NEVER falls back to a repo-root build on a team layout.
 */
import { describe, expect, it, vi } from "vitest";

import {
  inferMergeBuildRoots,
  runConversationMergeGate,
} from "~/assistant/merge-gate.server";
import type { BuildCheckRequest, BuildCheckResult } from "~/seams/types";

const REPO = { owner: "acme", repo: "team-repo" };
type CheckBuildFn = (req: BuildCheckRequest) => Promise<BuildCheckResult>;
const okCheck = () => vi.fn<CheckBuildFn>(async () => ({ ok: true }));

describe("inferMergeBuildRoots", () => {
  it("team: a two-member change → both member roots, no undefined", () => {
    const roots = inferMergeBuildRoots(
      ["agents/sam/agent/agent.ts", "agents/ivy/agent/instructions.md"],
      true,
    );
    expect(roots).toEqual(["agents/ivy/agent", "agents/sam/agent"]);
    expect(roots).not.toContain(undefined);
  });

  it("team: member files + root package-lock.json → member roots only", () => {
    expect(
      inferMergeBuildRoots(
        ["agents/sam/agent/agent.ts", "package-lock.json"],
        true,
      ),
    ).toEqual(["agents/sam/agent"]);
  });

  it("team: a new-member change → that member's agent root", () => {
    expect(
      inferMergeBuildRoots(
        ["agents/qa/package.json", "agents/qa/agent/agent.ts"],
        true,
      ),
    ).toEqual(["agents/qa/agent"]);
  });

  it("team: a root-only change → nothing to build", () => {
    expect(inferMergeBuildRoots(["package-lock.json"], true)).toEqual([]);
  });

  it("team: .harnesst config is ignored", () => {
    expect(
      inferMergeBuildRoots([".harnesst/assistant/instructions.md"], true),
    ).toEqual([]);
    expect(
      inferMergeBuildRoots(
        [".harnesst/assistant/instructions.md", "agents/sam/agent/agent.ts"],
        true,
      ),
    ).toEqual(["agents/sam/agent"]);
  });

  it("single layout: always one undefined root regardless of paths", () => {
    expect(inferMergeBuildRoots(["agent/agent.ts", "package.json"], false)).toEqual([
      undefined,
    ]);
    expect(inferMergeBuildRoots([], false)).toEqual([undefined]);
  });
});

describe("runConversationMergeGate", () => {
  const base = {
    projectId: "proj_1",
    repo: REPO,
    ref: "harnesst/conv-abc",
    installationId: "inst_1",
  };

  it("the issue #137 shape → one build per member, each scoped, never undefined", async () => {
    const checkBuild = okCheck();
    const result = await runConversationMergeGate({
      ...base,
      teamLayout: true,
      paths: [
        "agents/sam/agent/agent.ts",
        "agents/ivy/agent/instructions.md",
        "agents/qa/package.json",
        "agents/qa/agent/agent.ts",
        "agents/reviewer/package.json",
        "agents/reviewer/agent/agent.ts",
        "package-lock.json",
      ],
      checkBuild,
    });

    expect(result).toEqual({ ok: true });
    expect(checkBuild).toHaveBeenCalledTimes(4);
    const rootsBuilt = checkBuild.mock.calls.map(
      (c) => (c[0] as BuildCheckRequest).agentRoot,
    );
    expect(rootsBuilt).toEqual([
      "agents/ivy/agent",
      "agents/qa/agent",
      "agents/reviewer/agent",
      "agents/sam/agent",
    ]);
    expect(rootsBuilt).not.toContain(undefined);
    for (const call of checkBuild.mock.calls) {
      const req = call[0] as BuildCheckRequest;
      expect(req.overlay).toEqual([]);
      expect(req.ref).toBe("harnesst/conv-abc");
    }
  });

  it("fails fast, scoping the error to the broken member", async () => {
    const checkBuild = vi.fn(
      async (req: BuildCheckRequest): Promise<BuildCheckResult> =>
        req.agentRoot === "agents/ivy/agent"
          ? { ok: false, output: "TS2304: Cannot find name 'foo'." }
          : { ok: true },
    );
    const result = await runConversationMergeGate({
      ...base,
      teamLayout: true,
      paths: ["agents/ivy/agent/agent.ts", "agents/sam/agent/agent.ts"],
      checkBuild,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("agents/ivy/agent");
      expect(result.error).toContain("TS2304");
    }
    // ivy sorts before sam and fails → sam is never built.
    expect(checkBuild).toHaveBeenCalledTimes(1);
  });

  it("team root-only change → checkBuild never called, gate ok", async () => {
    const checkBuild = okCheck();
    const result = await runConversationMergeGate({
      ...base,
      teamLayout: true,
      paths: ["package-lock.json"],
      checkBuild,
    });
    expect(result).toEqual({ ok: true });
    expect(checkBuild).not.toHaveBeenCalled();
  });

  it("single layout → exactly one build with an undefined root", async () => {
    const checkBuild = okCheck();
    const result = await runConversationMergeGate({
      ...base,
      teamLayout: false,
      paths: ["agent/agent.ts", "package.json"],
      checkBuild,
    });
    expect(result).toEqual({ ok: true });
    expect(checkBuild).toHaveBeenCalledTimes(1);
    expect((checkBuild.mock.calls[0][0] as BuildCheckRequest).agentRoot).toBeUndefined();
  });

  it("runs the checks sequentially, in sorted-root order", async () => {
    const order: string[] = [];
    let active = 0;
    const checkBuild = vi.fn(async (req: BuildCheckRequest): Promise<BuildCheckResult> => {
      active++;
      expect(active).toBe(1); // never two builds in flight at once
      await Promise.resolve();
      order.push(req.agentRoot ?? "<root>");
      active--;
      return { ok: true };
    });
    await runConversationMergeGate({
      ...base,
      teamLayout: true,
      paths: ["agents/sam/agent/agent.ts", "agents/ivy/agent/agent.ts"],
      checkBuild,
    });
    expect(order).toEqual(["agents/ivy/agent", "agents/sam/agent"]);
  });
});
