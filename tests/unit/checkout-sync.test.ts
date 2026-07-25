import { describe, expect, it, vi } from "vitest";

import {
  checkoutEnsureError,
  conversationBranch,
  conversationCheckoutPath,
  isBlockedPath,
  planCommit,
  policyWarnings,
  type TreeState,
} from "~/assistant/checkout-sync";
import {
  syncConversationCheckout,
  type AssistantCheckout,
  type SyncEngineDeps,
} from "~/assistant/checkout-sync.server";
import { stageDraft } from "~/drafts/drafts.server";
import { narrowedReadTokenParams } from "~/github/client.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";
// The instance-side sidecar's pure record classifier (importing the module must not bind a port).
import { classifyRawRecord } from "../../assistant-template/checkout-sidecar.mjs";

const tree = (dirty: TreeState["dirty"], baseSha = "base0"): TreeState => ({
  branch: "eden/conv-abc",
  baseSha,
  dirty,
});

describe("checkout-sync: path policy", () => {
  it("blocks assistant.json and .ts under .eden/assistant, allows everything else", () => {
    expect(isBlockedPath(".eden/assistant/assistant.json")).toBe(true);
    expect(isBlockedPath(".eden/assistant/tools/foo.ts")).toBe(true);
    expect(isBlockedPath(".eden/assistant/instructions.md")).toBe(false);
    expect(isBlockedPath(".eden/assistant/skills/x.md")).toBe(false);
    expect(isBlockedPath("agent/tools/foo.ts")).toBe(false);
    expect(isBlockedPath("package.json")).toBe(false);
  });

  it("strips blocked paths from the commit and records them as warnings", () => {
    const plan = planCommit(
      tree([
        { path: "agent/tools/foo.ts", status: "added", content: "export default 1;" },
        { path: ".eden/assistant/assistant.json", status: "modified", content: "{}" },
        { path: ".eden/assistant/agent.ts", status: "added", content: "x" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["agent/tools/foo.ts"]);
    expect(plan.blocked).toEqual([".eden/assistant/agent.ts", ".eden/assistant/assistant.json"]);
    expect(policyWarnings(plan)[0]).toContain(".eden/assistant/agent.ts");
  });
});

describe("checkout-sync: diff → commit mapping", () => {
  it("maps added/modified to writes and deleted to null-content deletions", () => {
    const plan = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A" },
        { path: "b.ts", status: "modified", content: "B" },
        { path: "c.ts", status: "deleted" },
      ]),
    );
    expect(plan.files).toEqual([
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
      { path: "c.ts", content: null },
    ]);
  });

  it("skips binary and oversize bodies but keeps them as warnings", () => {
    const plan = planCommit(
      tree([
        { path: "img.png", status: "added", binary: true },
        { path: "big.bin", status: "modified", oversize: true },
        { path: "ok.ts", status: "added", content: "ok" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(plan.skippedBodies).toEqual(["big.bin", "img.png"]);
    expect(policyWarnings(plan).some((w) => w.includes("1MB"))).toBe(true);
  });

  it("never commits non-regular files (symlinks/submodules), even with a smuggled body", () => {
    // A model-authored symlink could point at instance files (e.g. /proc/1/environ). The sidecar
    // flags it notFile and sends no body — and even if a body somehow arrived, the flag wins.
    const plan = planCommit(
      tree([
        { path: "leak.txt", status: "added", notFile: true, content: "SECRET=oops" },
        { path: "vendor", status: "added", notFile: true },
        { path: "ok.ts", status: "added", content: "ok" },
      ]),
    );
    expect(plan.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(plan.notFiles).toEqual(["leak.txt", "vendor"]);
    expect(policyWarnings(plan).some((w) => w.includes("symlink"))).toBe(true);
  });

  it("carries the executable bit into the plan and the hash", () => {
    const plain = planCommit(tree([{ path: "run.sh", status: "added", content: "#!/bin/sh" }]));
    const exec = planCommit(
      tree([{ path: "run.sh", status: "added", content: "#!/bin/sh", executable: true }]),
    );
    expect(plain.files[0].executable).toBeUndefined();
    expect(exec.files[0].executable).toBe(true);
    // A bare chmod +x (same content) must still register as a change to sync.
    expect(exec.hash).not.toBe(plain.hash);
  });

  it("hashes deterministically regardless of input order, and changes with content", () => {
    const a = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A" },
        { path: "b.ts", status: "added", content: "B" },
      ]),
    );
    const b = planCommit(
      tree([
        { path: "b.ts", status: "added", content: "B" },
        { path: "a.ts", status: "added", content: "A" },
      ]),
    );
    expect(a.hash).toBe(b.hash);

    const changed = planCommit(
      tree([
        { path: "a.ts", status: "added", content: "A2" },
        { path: "b.ts", status: "added", content: "B" },
      ]),
    );
    expect(changed.hash).not.toBe(a.hash);

    // A different base with the same files is a different snapshot.
    const rebased = planCommit(
      tree(
        [
          { path: "a.ts", status: "added", content: "A" },
          { path: "b.ts", status: "added", content: "B" },
        ],
        "base1",
      ),
    );
    expect(rebased.hash).not.toBe(a.hash);
  });

  it("an empty dirty set produces no files (a no-op sync)", () => {
    const plan = planCommit(tree([]));
    expect(plan.files).toEqual([]);
    expect(policyWarnings(plan)).toEqual([]);
  });
});

describe("checkout-sync: naming", () => {
  it("derives branch and checkout path from the conversation id", () => {
    expect(conversationBranch("abc")).toBe("eden/conv-abc");
    expect(conversationCheckoutPath("abc")).toBe("/workspace/home/checkouts/abc");
  });
});

describe("checkout-sync: pre-turn ensure gate", () => {
  it("lets a successful ensure proceed", () => {
    expect(checkoutEnsureError({ ok: true })).toBeNull();
  });

  it("lets targets without a checkout sidecar proceed (unsupported, not failed)", () => {
    expect(
      checkoutEnsureError({ ok: false, unsupported: true, reason: "no sidecar endpoint" }),
    ).toBeNull();
  });

  it("fails the turn when a sidecar exists but ensure failed, surfacing the reason", () => {
    const error = checkoutEnsureError({
      ok: false,
      reason: "read-token failed (fetch timeout)",
    });
    expect(error).toContain("read-token failed (fetch timeout)");
    expect(error).toContain("repo checkout");
  });

  it("still fails with a generic reason when none was reported", () => {
    expect(checkoutEnsureError({ ok: false })).toContain("unknown error");
  });
});

describe("checkout sidecar: raw-diff record classification", () => {
  const meta = (newMode: string, status: string) =>
    `:100644 ${newMode} 0000000 1111111 ${status}`;

  it("classifies regular files, executables, deletions", () => {
    expect(classifyRawRecord(meta("100644", "A"), "a.ts")).toEqual({ path: "a.ts", status: "added" });
    expect(classifyRawRecord(meta("100644", "M"), "b.ts")).toEqual({ path: "b.ts", status: "modified" });
    expect(classifyRawRecord(meta("100755", "A"), "run.sh")).toEqual({
      path: "run.sh",
      status: "added",
      executable: true,
    });
    expect(classifyRawRecord(":100644 000000 1111111 0000000 D", "gone.ts")).toEqual({
      path: "gone.ts",
      status: "deleted",
    });
  });

  it("flags symlinks and submodules notFile so their bodies are never read", () => {
    expect(classifyRawRecord(meta("120000", "A"), "leak")).toEqual({
      path: "leak",
      status: "added",
      notFile: true,
    });
    expect(classifyRawRecord(meta("160000", "M"), "sub")).toEqual({
      path: "sub",
      status: "modified",
      notFile: true,
    });
  });

  it("ignores non-record lines", () => {
    expect(classifyRawRecord("garbage", "x")).toBeNull();
  });
});

describe("github: narrowed read token request shape", () => {
  it("scopes to exactly one repo with contents:read only", () => {
    const params = narrowedReadTokenParams("123", "my-repo");
    expect(params).toEqual({
      installation_id: 123,
      repositories: ["my-repo"],
      permissions: { contents: "read" },
    });
    // Guard against accidental permission widening.
    expect(Object.keys(params.permissions)).toEqual(["contents"]);
  });
});

// ── Post-turn sync engine (server half, all I/O injected) ──────────────────────

/** A connected project with one member rooted at `agent/`, so drafts attribute to it. */
function seedRepoProject(store: FakeStore): void {
  store.seedProject({
    id: "proj_1",
    orgId: "org_1",
    repoOwner: "acme",
    repoName: "agent",
    repoInstallationId: "inst_1",
    defaultBranch: "main",
  });
  store.seedAgent({ id: "agent_1", projectId: "proj_1", name: "agent", root: "agent" });
}

function makeSyncDeps(over: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  return {
    auxBase: vi.fn(async () => ({ supported: true, base: "http://sidecar" })),
    readTree: vi.fn(async () => tree([])),
    getRow: vi.fn(async () => null),
    upsertRow: vi.fn(async () => {}),
    mirror: vi.fn(async () => "mirror_sha"),
    stage: stageDraft,
    recordFailure: vi.fn(async () => {}),
    ...over,
  };
}

const syncInput = {
  projectId: "proj_1",
  conversationId: "conv1",
  deploymentId: "dep_1",
} as const;

describe("checkout-sync: post-turn sync engine", () => {
  it("stages drafts (writes and deletions), opens no PR, and still mirrors the conversation branch", async () => {
    const store = makeFakeStore();
    seedRepoProject(store);
    const t = tree([
      { path: "agent/tools/foo.ts", status: "added", content: "export default 1;" },
      { path: "agent/instructions.md", status: "modified", content: "Be nice." },
      { path: "agent/old.ts", status: "deleted" },
    ]);
    const deps = makeSyncDeps({ readTree: vi.fn(async () => t) });

    const result = await syncConversationCheckout({ ...syncInput, store }, deps);

    expect(result).toEqual({ synced: true, kind: "synced", stagedCount: 3, warnings: undefined });
    // The sync's only surfaces are the staging area and the durability mirror — no PR identity.
    expect("prNumber" in result).toBe(false);

    // Every planned write AND the deletion (content: null) landed as drafts, attributed to the
    // owning member, authorless (a null createdBy is what marks a draft assistant-staged).
    const drafts = await store.drafts.listByProject("proj_1");
    expect(drafts.map((d) => [d.path, d.content])).toEqual([
      ["agent/instructions.md", "Be nice."],
      ["agent/old.ts", null],
      ["agent/tools/foo.ts", "export default 1;"],
    ]);
    expect(drafts.every((d) => d.agentId === "agent_1" && d.createdBy === null)).toBe(true);

    // The durability branch was still mirrored, once, from the merge-base the diff was cut at.
    expect(deps.mirror).toHaveBeenCalledOnce();
    const [, branch, baseSha] = vi.mocked(deps.mirror).mock.calls[0];
    expect(branch).toBe("eden/conv-conv1");
    expect(baseSha).toBe("base0");

    // The row advanced to the plan's hash so the next identical tree no-ops.
    expect(deps.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv1",
        branch: "eden/conv-conv1",
        lastSyncedHash: planCommit(t).hash,
      }),
    );
  });

  it("an unchanged tree no-ops without staging or mirroring", async () => {
    const store = makeFakeStore();
    seedRepoProject(store);
    const t = tree([{ path: "agent/a.ts", status: "added", content: "A" }]);
    const stage = vi.fn();
    const deps = makeSyncDeps({
      readTree: vi.fn(async () => t),
      getRow: vi.fn(async () => ({ lastSyncedHash: planCommit(t).hash }) as AssistantCheckout),
      stage,
    });

    const result = await syncConversationCheckout({ ...syncInput, store }, deps);

    expect(result).toEqual({ synced: false, kind: "noop", reason: "unchanged", stagedCount: 0 });
    expect(stage).not.toHaveBeenCalled();
    expect(deps.mirror).not.toHaveBeenCalled();
  });

  it("a mirror failure fails the sync before anything is staged", async () => {
    const store = makeFakeStore();
    seedRepoProject(store);
    const stage = vi.fn();
    const deps = makeSyncDeps({
      readTree: vi.fn(async () => tree([{ path: "agent/a.ts", status: "added", content: "A" }])),
      mirror: vi.fn(async () => {
        throw new Error("boom");
      }),
      stage,
    });

    const result = await syncConversationCheckout({ ...syncInput, store }, deps);

    expect(result.kind).toBe("failed");
    expect(result.stagedCount).toBe(0);
    expect(result.reason).toContain("mirroring to GitHub failed: boom");
    expect(stage).not.toHaveBeenCalled();
    expect(await store.drafts.listByProject("proj_1")).toEqual([]);
    expect(deps.recordFailure).toHaveBeenCalledOnce();
  });

  it("a staging failure keeps the hash behind so the next turn retries", async () => {
    const store = makeFakeStore();
    seedRepoProject(store);
    const deps = makeSyncDeps({
      readTree: vi.fn(async () => tree([{ path: "agent/a.ts", status: "added", content: "A" }])),
      stage: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    const result = await syncConversationCheckout({ ...syncInput, store }, deps);

    expect(result.kind).toBe("failed");
    expect(result.reason).toContain("staging the changes failed: db down");
    // The row never advanced — the next turn re-mirrors (idempotent) and re-stages.
    expect(deps.upsertRow).not.toHaveBeenCalled();
    expect(deps.recordFailure).toHaveBeenCalledOnce();
  });

  it("a turn whose only edits were policy-stripped lands the warnings on the row", async () => {
    const store = makeFakeStore();
    seedRepoProject(store);
    const stage = vi.fn();
    const deps = makeSyncDeps({
      readTree: vi.fn(async () =>
        tree([{ path: ".eden/assistant/assistant.json", status: "modified", content: "{}" }]),
      ),
      stage,
    });

    const result = await syncConversationCheckout({ ...syncInput, store }, deps);

    expect(result.kind).toBe("noop");
    expect(result.warnings?.[0]).toContain(".eden/assistant/assistant.json");
    expect(stage).not.toHaveBeenCalled();
    expect(deps.mirror).not.toHaveBeenCalled();
    expect(deps.upsertRow).toHaveBeenCalledWith(
      expect.objectContaining({ warnings: result.warnings }),
    );
  });
});
