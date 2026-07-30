/**
 * `publishArtifact` against in-memory fakes (#290) — the decisions that are security decisions.
 *
 * WHERE an artifact lands is the first one. The tool carries no session id, so the destination is
 * derived from the live turn on the CALLING deployment; deriving it from "the agent's newest
 * conversation" instead was a cross-member image leak, because one deployment serves every member's
 * FOH sessions and those sessions are per-creator confidential. Two live turns are refused rather
 * than guessed, and a publish with no live turn is refused too.
 *
 * The budgets are the second: the caller is an agent that can loop, nothing ever deletes stored
 * bytes, and every in-flight copy holds its tar in this process's heap.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_BUDGET_WINDOW_MS,
  MAX_ARTIFACTS_PER_PROJECT_WINDOW,
  MAX_ARTIFACTS_PER_SESSION,
  MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW,
  MAX_CONCURRENT_ARTIFACT_COPIES,
  publishArtifact,
  withArtifactCopySlot,
  type PublishArtifactDeps,
} from "~/foh/artifacts.server";
import type { Artifact } from "~/foh/artifact-store.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const NOW = new Date(1_700_000_000_000);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

let store: FakeStore;

async function seedDeployment(): Promise<string> {
  store.seedProject({ id: PROJECT, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
  store.seedEnvironment({
    id: "env_1",
    projectId: PROJECT,
    agentId: "agent_1",
    name: "production",
  });
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: "agent_1",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_1",
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  return dep.id;
}

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: "ps_live",
    projectId: PROJECT,
    agentId: "agent_1",
    environmentId: "env_1",
    createdBy: "user_b",
    surface: "foh",
    status: "running",
    ...over,
  } as unknown as PlaygroundSession;
}

type Deps = PublishArtifactDeps & {
  copies: Array<{ deploymentId: string; path: string }>;
  finds: Array<Parameters<PublishArtifactDeps["findSession"]>[0]>;
  rows: Artifact[];
};

function makeDeps(
  over: {
    find?: PublishArtifactDeps["findSession"];
    copy?: PublishArtifactDeps["copyFile"];
    usage?: PublishArtifactDeps["usage"];
  } = {},
): Deps {
  const copies: Deps["copies"] = [];
  const finds: Deps["finds"] = [];
  const rows: Artifact[] = [];
  return {
    store,
    copies,
    finds,
    rows,
    findSession: async (input) => {
      finds.push(input);
      return over.find
        ? over.find(input)
        : { ok: true as const, session: session() };
    },
    copyFile: async (input) => {
      copies.push({ deploymentId: input.deploymentId, path: input.path });
      return over.copy ? over.copy(input) : { ok: true as const, bytes: PNG };
    },
    usage:
      over.usage ??
      (async () => ({ sessionCount: 0, projectCount: 0, projectBytes: 0 })),
    writeBytes: async (sha256) => `${sha256.slice(0, 2)}/${sha256}`,
    insert: async (input) => {
      const row = { ...input, id: `art_${rows.length + 1}`, createdAt: NOW } as Artifact;
      rows.push(row);
      return row;
    },
    streamPosition: async () => 7,
    now: () => NOW,
  };
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("publishArtifact destination", () => {
  it("publishes into the conversation whose turn is running on the calling deployment", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png", title: "  Chart  " },
      deps,
    );

    expect(result).toMatchObject({
      ok: true,
      name: "chart.png",
      contentType: "image/png",
      byteSize: PNG.length,
      url: `/api/foh/${PROJECT}/artifact/art_1`,
    });
    expect(deps.rows[0]).toMatchObject({
      sessionId: "ps_live",
      projectId: PROJECT,
      agentId: "agent_1",
      deploymentId,
      title: "Chart",
      streamIndex: 7,
    });
    // Both narrowing facts come off the token's deployment, not the body: the environment (a
    // staging container must not publish into a production conversation) and the deployment
    // itself (which is what ties the publish to one member's live turn).
    expect(deps.finds[0]).toMatchObject({
      projectId: PROJECT,
      agentId: "agent_1",
      environmentId: "env_1",
      deploymentId,
    });
    expect(deps.finds[0].staleAfterMs).toBeGreaterThan(0);
  });

  it("refuses when no conversation is running a turn instead of falling back to the newest one", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      find: async () => ({ ok: false, reason: "no_live_turn" }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no Front of House conversation waiting on you/i);
    // Nothing was read: a refusal must not cost a 25 MB copy either.
    expect(deps.copies).toHaveLength(0);
    expect(deps.rows).toHaveLength(0);
  });

  it("refuses when two conversations are live at once rather than guessing between members", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      find: async () => ({ ok: false, reason: "ambiguous" }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/more than one Front of House conversation/i);
    expect(deps.copies).toHaveLength(0);
  });
});

describe("publishArtifact budgets", () => {
  it("refuses once a conversation holds the per-conversation maximum", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      usage: async () => ({
        sessionCount: MAX_ARTIFACTS_PER_SESSION,
        projectCount: 1,
        projectBytes: 10,
      }),
    });

    const result = await publishArtifact(
      { deploymentId, path: "artifacts/chart.png" },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/already holds 100 published files/);
    expect(deps.copies).toHaveLength(0);
  });

  it("refuses on the repo's daily count and byte ceilings, and measures them over the window", async () => {
    const deploymentId = await seedDeployment();
    const seen: Array<{ since: Date; projectId: string; sessionId: string }> = [];
    const byCount = makeDeps({
      usage: async (input) => {
        seen.push(input);
        return {
          sessionCount: 0,
          projectCount: MAX_ARTIFACTS_PER_PROJECT_WINDOW,
          projectBytes: 0,
        };
      },
    });
    const byBytes = makeDeps({
      usage: async () => ({
        sessionCount: 0,
        projectCount: 1,
        projectBytes: MAX_ARTIFACT_BYTES_PER_PROJECT_WINDOW,
      }),
    });

    for (const deps of [byCount, byBytes]) {
      const result = await publishArtifact(
        { deploymentId, path: "artifacts/chart.png" },
        deps,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/daily limit/i);
      expect(deps.copies).toHaveLength(0);
    }
    expect(seen[0]).toMatchObject({ projectId: PROJECT, sessionId: "ps_live" });
    expect(seen[0].since.getTime()).toBe(NOW.getTime() - ARTIFACT_BUDGET_WINDOW_MS);
  });
});

describe("withArtifactCopySlot", () => {
  it("refuses past the concurrency ceiling and frees the slot even when the copy throws", async () => {
    const releases: Array<() => void> = [];
    const held = Array.from({ length: MAX_CONCURRENT_ARTIFACT_COPIES }, () =>
      withArtifactCopySlot(
        () =>
          new Promise<string>((resolve) =>
            releases.push(() => resolve("done")),
          ),
      ),
    );

    expect(await withArtifactCopySlot(async () => "extra")).toEqual({ ok: false });
    for (const release of releases) release();
    expect(await Promise.all(held)).toEqual(
      held.map(() => ({ ok: true, value: "done" })),
    );

    await expect(
      withArtifactCopySlot(async () => {
        throw new Error("docker exploded");
      }),
    ).rejects.toThrow("docker exploded");
    // The throw above must not have leaked its slot.
    expect(await withArtifactCopySlot(async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });
});
