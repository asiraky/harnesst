/**
 * Deploy controller orchestration — against in-memory fakes (no DB, no docker). Verifies the
 * logic the controller owns: version labelling + collision retry, release idempotency, the
 * build→deploy→record pipeline (success and failure), single-live cutover, rollback, and
 * scoped splits.
 * Row-locking / real constraint enforcement is the store impl's job (trusted at schema level).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRelease,
  deployRelease,
  ensureReleaseForCommit,
  listDeployments,
  queueDeploy,
  rollbackTo,
  setTrafficSplit,
} from "~/deploy/controller.server";
import { cleanupDeploymentContainer } from "~/deploy/cleanup.server";
import {
  DEPLOYMENT_DRAIN_CEILING_MS,
  DEPLOYMENT_DRAIN_POLL_MS,
  drainDeployment,
} from "~/deploy/drain.server";
import { envIngressUrl } from "~/lib/ingress";
import { verifyDelegationToken } from "~/team/token.server";
import type { DeployTarget, SecretsProvider } from "~/seams/types";
import { fakeDeployTarget, fakeSecrets } from "../fakes/infra";
import { makeFakeStore, type FakeStore } from "../fakes/store";

// Team-delegation roster reads go through the cached GitHub source — stub it so the controller
// can build HARNESST_TEAMMATES without network. (Only the team-injection tests exercise this.)
vi.mock("~/github/cached.server", () => ({
  getAgentSource: vi.fn(async () => ({
    paths: [],
    files: {
      "agents/deployer/agent/instructions.md":
        "# Deployer\n\nDeploys builds to production.",
    },
    ref: "main",
    truncated: false,
  })),
}));

let store: FakeStore;
const PROJECT = "proj_1";
const ORG = "org_1";
const AGENT = "agent_1";
const ENV = "env_1";

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({
    id: PROJECT,
    orgId: ORG,
    repoOwner: "acme",
    repoName: "agent",
  });
  store.seedAgent({ id: AGENT, projectId: PROJECT });
  store.seedEnvironment({
    id: ENV,
    projectId: PROJECT,
    agentId: AGENT,
    name: "production",
  });
});

describe("createRelease", () => {
  it("labels releases v1, v2, … per agent", async () => {
    const r1 = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a".repeat(40) },
      store,
    );
    const r2 = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b".repeat(40) },
      store,
    );
    expect(r1.version).toBe("v1");
    expect(r2.version).toBe("v2");
  });

  it("retries past a version-label collision and still lands", async () => {
    store.forceReleaseCollisions(2); // first two inserts raise 23505, third succeeds
    const r = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c".repeat(40) },
      store,
    );
    expect(r.version).toBe("v1");
  });
});

describe("ensureReleaseForCommit", () => {
  it("is idempotent per merge commit (in-app merge + webhook converge)", async () => {
    const sha = "d".repeat(40);
    const first = await ensureReleaseForCommit(
      { projectId: PROJECT, agentId: AGENT, gitSha: sha },
      store,
    );
    const second = await ensureReleaseForCommit(
      { projectId: PROJECT, agentId: AGENT, gitSha: sha },
      store,
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.release.id).toBe(first.release.id);
  });
});

describe("deployRelease", () => {
  it("builds, deploys live, records the image + an audit entry", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://x" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(dep.status).toBe("live");
    expect(dep.url).toBe("http://x");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:fake",
    );
    expect(store.auditEntries).toContainEqual(
      expect.objectContaining({ action: "deploy", target: "v1", orgId: ORG }),
    );
  });

  it("protects exact connection credentials while preserving standard-alias overrides", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a1".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
      providerDeploymentEnv: async () => ({
        HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY: "sk-or-workspace",
        OPENROUTER_API_KEY: "sk-or-workspace",
        HARNESST_PROVIDER_ANTHROPIC_MNOPQRSTUVWX_API_KEY: "sk-ant-workspace",
        ANTHROPIC_API_KEY: "sk-ant-workspace",
      }),
      modelDirectiveSecret: () => "directive-secret",
    };

    // No project secret → the workspace key is injected.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { ...base, secrets: fakeSecrets() },
    );
    expect(deployedEnvs[0].OPENROUTER_API_KEY).toBe("sk-or-workspace");

    // Scoped secrets cannot shadow either the exact credential or its standard alias.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "sk-or-project",
          HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY: "smuggled",
          ANTHROPIC_API_KEY: "sk-ant-project",
          HARNESST_MODEL_DIRECTIVE_SECRET: "smuggled",
          SAFE_TOKEN: "safe",
        }),
        sandboxExposedNames: async () => [
          "HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY",
          "HARNESST_MODEL_DIRECTIVE_SECRET",
          "SAFE_TOKEN",
        ],
      },
    );
    expect(deployedEnvs[1].OPENROUTER_API_KEY).toBe("sk-or-project");
    expect(deployedEnvs[1].HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY).toBe(
      "sk-or-workspace",
    );
    expect(deployedEnvs[1].ANTHROPIC_API_KEY).toBe("sk-ant-project");
    expect(deployedEnvs[1].HARNESST_SANDBOX_ENV).toBe("SAFE_TOKEN");
    expect(deployedEnvs[1].HARNESST_MODEL_DIRECTIVE_SECRET).toBe(
      "directive-secret",
    );
  });

  it("fails before deploy with a clear setup message when no model key is configured", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b2".repeat(20) },
      store,
    );
    const builtRefs: string[] = [];
    const deployedEnvs: Record<string, string>[] = [];

    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ builtRefs, deployedEnvs }),
        secrets: fakeSecrets(),
        providerDeploymentEnv: async () => ({}),
      },
    );

    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toContain(
      "No model provider credential is available",
    );
    expect(builtRefs).toEqual([]);
    expect(deployedEnvs).toEqual([]);
  });

  it("inherits local AI Gateway credentials unless a scoped secret overrides them", async () => {
    const oldGateway = process.env.AI_GATEWAY_API_KEY;
    const oldOidc = process.env.VERCEL_OIDC_TOKEN;
    process.env.AI_GATEWAY_API_KEY = "aigw-local";
    process.env.VERCEL_OIDC_TOKEN = "oidc-local";

    try {
      const release = await createRelease(
        { projectId: PROJECT, agentId: AGENT, gitSha: "c3".repeat(20) },
        store,
      );
      const deployedEnvs: Record<string, string>[] = [];
      const base = {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" as const },
          deployedEnvs,
        }),
      };

      await deployRelease(
        { environmentId: ENV, releaseId: release.id },
        { ...base, secrets: fakeSecrets() },
      );
      expect(deployedEnvs[0].AI_GATEWAY_API_KEY).toBe("aigw-local");
      expect(deployedEnvs[0].VERCEL_OIDC_TOKEN).toBe("oidc-local");

      await deployRelease(
        { environmentId: ENV, releaseId: release.id },
        {
          ...base,
          secrets: fakeSecrets({
            AI_GATEWAY_API_KEY: "aigw-secret",
            VERCEL_OIDC_TOKEN: "oidc-secret",
          }),
        },
      );
      expect(deployedEnvs[1].AI_GATEWAY_API_KEY).toBe("aigw-secret");
      expect(deployedEnvs[1].VERCEL_OIDC_TOKEN).toBe("oidc-secret");
    } finally {
      if (oldGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = oldGateway;
      if (oldOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
      else process.env.VERCEL_OIDC_TOKEN = oldOidc;
    }
  });

  it("joins sandbox-exposed secret names into HARNESST_SANDBOX_ENV (names only, after the spread)", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c3".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
    };

    // Exposed + resolved → the allowlist carries exactly those names.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({
          GH_TOKEN: "gho_x",
          NPM_TOKEN: "npm_y",
          PRIVATE: "keep-out",
        }),
        sandboxExposedNames: async () => ["GH_TOKEN", "NPM_TOKEN"],
      },
    );
    expect(deployedEnvs[0].HARNESST_SANDBOX_ENV).toBe("GH_TOKEN,NPM_TOKEN");
    expect(deployedEnvs[0].PRIVATE).toBe("keep-out"); // still injected — just not allowlisted

    // Exposure of a name that resolved to nothing forwards nothing.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({ GH_TOKEN: "gho_x" }),
        sandboxExposedNames: async () => ["GH_TOKEN", "DELETED_SECRET"],
      },
    );
    expect(deployedEnvs[1].HARNESST_SANDBOX_ENV).toBe("GH_TOKEN");
  });

  it("omits HARNESST_SANDBOX_ENV when nothing is exposed, and strips a user secret squatting the name", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d4".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const base = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
    };

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({ GH_TOKEN: "gho_x" }),
        sandboxExposedNames: async () => [],
      },
    );
    expect(deployedEnvs[0]).not.toHaveProperty("HARNESST_SANDBOX_ENV");

    // The variable is harnesst-owned: a user secret named HARNESST_SANDBOX_ENV must never smuggle
    // its own allowlist into the sandbox.
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        ...base,
        secrets: fakeSecrets({
          HARNESST_SANDBOX_ENV: "PRIVATE",
          PRIVATE: "keep-out",
        }),
        sandboxExposedNames: async () => [],
      },
    );
    expect(deployedEnvs[1]).not.toHaveProperty("HARNESST_SANDBOX_ENV");

    // Deps without the lookup (older callers/tests) behave as "nothing exposed".
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      { ...base, secrets: fakeSecrets({ GH_TOKEN: "gho_x" }) },
    );
    expect(deployedEnvs[2]).not.toHaveProperty("HARNESST_SANDBOX_ENV");
  });

  it("strips a SHARED secret squatting HARNESST_SANDBOX_ENV after the merged resolve (§11.9)", async () => {
    const crypto = await import("node:crypto");
    const { makeLocalSecretsProvider } =
      await import("~/seams/oss/secrets.local.server");
    const { makeFakeSecretKV } = await import("../fakes/secret-kv");
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e5".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];

    // A project-level shared secret named HARNESST_SANDBOX_ENV, attached to the agent, resolves
    // through the real provider merge — and must still be deleted before harnesst sets its own.
    const kv = makeFakeSecretKV();
    const boxKey = crypto.randomBytes(32);
    const secrets = makeLocalSecretsProvider(kv, () => boxKey);
    await secrets.set(
      {
        projectId: PROJECT,
        agentId: null,
        environmentId: null,
        key: "HARNESST_SANDBOX_ENV",
      },
      "SMUGGLED",
    );
    await secrets.set(
      {
        projectId: PROJECT,
        agentId: AGENT,
        environmentId: null,
        key: "GH_TOKEN",
      },
      "gho_x",
    );
    kv.attach(AGENT, "HARNESST_SANDBOX_ENV");

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" as const },
          deployedEnvs,
        }),
        secrets,
        sandboxExposedNames: async () => ["GH_TOKEN"],
      },
    );
    expect(deployedEnvs[0].HARNESST_SANDBOX_ENV).toBe("GH_TOKEN"); // harnesst-owned, never "SMUGGLED"
    expect(deployedEnvs[0].GH_TOKEN).toBe("gho_x");
  });

  it("keys the Workflow world by ENVIRONMENT — two deploys of one env share a worldKey", async () => {
    // The durability invariant this feature exists for: a redeploy reuses the environment's
    // world (so sessions + their sandboxes survive), which means the worldKey must be stable
    // across deploys and equal to the environment id — never the (per-deploy) deployment id.
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b2".repeat(20) },
      store,
    );
    const deployedWorldKeys: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedWorldKeys,
      }),
      secrets: fakeSecrets(),
    };
    const d1 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    const d2 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(d1.id).not.toBe(d2.id); // two distinct deployments…
    expect(deployedWorldKeys).toEqual([ENV, ENV]); // …one shared, env-keyed world
  });

  it("rebuilds an already-built release when requested", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ab".repeat(20) },
      store,
    );
    const builtRefs: string[] = [];

    const first = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://first" },
          buildImageRef: "img:first",
          builtRefs,
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(first.status).toBe("live");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:first",
    );

    const rebuilt = await deployRelease(
      { environmentId: ENV, releaseId: release.id, rebuild: true },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://rebuilt" },
          buildImageRef: "img:rebuilt",
          builtRefs,
        }),
        secrets: fakeSecrets(),
      },
    );

    expect(rebuilt.status).toBe("live");
    expect((await store.releases.findById(release.id))?.imageRef).toBe(
      "img:rebuilt",
    );
    expect(builtRefs).toEqual(["img:first", "img:rebuilt"]);
  });

  it("records failed status WITH the reason when the target throws", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f".repeat(40) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ deployError: "docker unavailable" }),
        secrets: fakeSecrets(),
      },
    );
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toBe("docker unavailable");
  });

  it("stops a failed/unhealthy new instance so its schedules cannot keep running", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "7".repeat(40) },
      store,
    );
    const stoppedIds: string[] = [];
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: {
            status: "failed",
            url: "http://bad",
            detail: "container did not become healthy",
          },
          stoppedIds,
        }),
        secrets: fakeSecrets(),
      },
    );

    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toBe("container did not become healthy");
    expect(stoppedIds).toContain(dep.id);
  });
});

describe("queueDeploy", () => {
  it("creates the pending row FIRST, and the job takes over that same row (no duplicate)", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "9".repeat(40) },
      store,
    );

    // Click: row exists immediately in `pending` — this is the UI's instant feedback.
    const queued = await queueDeploy(
      { environmentId: ENV, releaseId: release.id, createdBy: "user_1" },
      store,
    );
    expect(queued.status).toBe("pending");
    expect((await listDeployments(ENV, store)).map((d) => d.id)).toEqual([
      queued.id,
    ]);

    // Worker: claims the job, whose payload points at the pre-created row.
    const job = await store.jobs.claimNext(new Date());
    expect(job?.kind).toBe("deploy_release");
    expect(job?.payload.deploymentId).toBe(queued.id);

    // Executing the deploy updates that row — never inserts a second one.
    const done = await deployRelease(
      job!.payload as {
        environmentId: string;
        releaseId: string;
        deploymentId: string;
      },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://z" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(done.id).toBe(queued.id);
    expect(done.status).toBe("live");
    expect(await listDeployments(ENV, store)).toHaveLength(1);
  });

  it("preserves the rebuild flag in the pending deploy job", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a9".repeat(20) },
      store,
    );

    const queued = await queueDeploy(
      {
        environmentId: ENV,
        releaseId: release.id,
        rebuild: true,
        createdBy: "user_1",
      },
      store,
    );
    const job = await store.jobs.claimNext(new Date());

    expect(queued.status).toBe("pending");
    expect(job?.kind).toBe("deploy_release");
    expect(job?.payload).toMatchObject({
      environmentId: ENV,
      releaseId: release.id,
      deploymentId: queued.id,
      rebuild: true,
      createdBy: "user_1",
    });
  });
});

describe("cutover on deploy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redeploying the same release DRAINS the previous live instance — never two live copies", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "8".repeat(40) },
      store,
    );
    const stoppedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
        stoppedIds,
      }),
      secrets: fakeSecrets(),
    };
    const first = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(first.status).toBe("live");

    const failRunningRuns = vi.spyOn(store.runs, "failRunningByDeployment");
    const second = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    expect(second.status).toBe("live");

    const all = await listDeployments(ENV, store);
    const oldRow = all.find((d) => d.id === first.id);
    // The old instance is DRAINING (weight 0), not stopped — it keeps running to finish turns.
    expect(oldRow?.status).toBe("draining");
    expect(oldRow?.trafficWeight).toBe(0);
    // Exactly one live copy of the release remains.
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
    // Cutover no longer stops infra or reconciles runs — that's the drain watcher's job.
    expect(stoppedIds).not.toContain(first.id);
    expect(failRunningRuns).not.toHaveBeenCalled();

    // A drain job for the old deployment is scheduled one poll interval out (not immediately due).
    expect(await store.jobs.claimNext(new Date())).toBeNull();
    const drainJob = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS + 1000),
    );
    expect(drainJob?.kind).toBe("drain_deployment");
    expect(drainJob?.payload.deploymentId).toBe(first.id);
  });

  it("deploying a DIFFERENT release drains the previously live one + schedules a ceilinged drain", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "3".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "4".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(depA.status).toBe("live");

    const scheduledAt = Date.now();
    const depB = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      deps,
    );
    expect(depB.status).toBe("live");

    const all = await listDeployments(ENV, store);
    const oldRow = all.find((d) => d.id === depA.id);
    expect(oldRow?.status).toBe("draining");
    expect(oldRow?.trafficWeight).toBe(0);
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);

    // Nothing is due immediately; the drain poll is one interval out and carries the ceiling as an
    // absolute deadline anchored at cutover.
    expect(await store.jobs.claimNext(new Date())).toBeNull();
    const drainJob = await store.jobs.claimNext(
      new Date(Date.now() + DEPLOYMENT_DRAIN_POLL_MS + 1000),
    );
    expect(drainJob?.kind).toBe("drain_deployment");
    expect(drainJob?.payload.deploymentId).toBe(depA.id);
    const deadline = Date.parse(drainJob!.payload.deadlineAt as string);
    expect(deadline).toBeGreaterThanOrEqual(
      scheduledAt + DEPLOYMENT_DRAIN_CEILING_MS - 2000,
    );
    expect(deadline).toBeLessThanOrEqual(
      scheduledAt + DEPLOYMENT_DRAIN_CEILING_MS + 2000,
    );
  });

  it("fails the new deployment (old stays live) when the draining flip cannot be persisted", async () => {
    // Stopping is now deferred to the drain job, so a broken docker-stop no longer fails a
    // redeploy. The only cutover-time failure left is being unable to WRITE the draining flip —
    // if that can't land, the new deployment is recorded failed and the old row stays live.
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b".repeat(40) },
      store,
    );
    const first = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://old" },
        }),
        secrets: fakeSecrets(),
      },
    );
    expect(first.status).toBe("live");

    const realUpdate = store.deployments.update.bind(store.deployments);
    vi.spyOn(store.deployments, "update").mockImplementation(
      async (id, patch) => {
        if (id === first.id && patch.status === "draining") {
          throw new Error("deployments row is locked");
        }
        return realUpdate(id, patch);
      },
    );
    const failRunningRuns = vi.spyOn(store.runs, "failRunningByDeployment");
    const second = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live", url: "http://new" },
        }),
        secrets: fakeSecrets(),
      },
    );

    expect(second.status).toBe("failed");
    expect(second.errorDetail).toMatch(
      /cutover failed while draining the previous deployment/,
    );

    const all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === first.id)?.status).toBe("live");
    expect(all.find((d) => d.id === second.id)?.status).toBe("failed");
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
    expect(failRunningRuns).not.toHaveBeenCalled();
  });

  it("keeps a successful cutover live even when scheduling the drain job fails", async () => {
    // The drain schedule is best-effort: a lost job leaves a visible `draining` row, never fails a
    // redeploy that has already gone live.
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "7".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "9".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const first = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    vi.spyOn(store.jobs, "insert").mockRejectedValueOnce(
      new Error("queue unavailable"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const second = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      deps,
    );

    expect(second.status).toBe("live");
    expect((await store.deployments.findById(first.id))?.status).toBe(
      "draining",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to schedule deployment drain"),
      expect.any(Error),
    );
  });

  it("end-to-end: A live → B live drains A → A idle → drain stops A and schedules cleanup", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d".repeat(40) },
      store,
    );
    const stoppedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
        stoppedIds,
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    const depB = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      deps,
    );
    expect(depB.status).toBe("live");
    expect((await store.deployments.findById(depA.id))?.status).toBe(
      "draining",
    );

    // A turn is still in flight on the draining A → the watcher waits and re-polls.
    store.seedRun({
      id: "run_a",
      projectId: PROJECT,
      deploymentId: depA.id,
      status: "running",
    });
    const deadline = new Date(
      Date.now() + DEPLOYMENT_DRAIN_CEILING_MS,
    ).toISOString();
    const waiting = await drainDeployment(
      { deploymentId: depA.id, deadlineAt: deadline },
      deps,
    );
    expect(waiting).toEqual({ status: "waiting", runningRuns: 1 });
    expect(stoppedIds).not.toContain(depA.id);

    // The turn settles → the next tick stops A.
    store.seedRun({
      id: "run_a",
      projectId: PROJECT,
      deploymentId: depA.id,
      status: "completed",
      finishedAt: new Date(),
    });
    const stopped = await drainDeployment(
      { deploymentId: depA.id, deadlineAt: deadline },
      deps,
    );
    expect(stopped).toEqual({ status: "stopped", interruptedRuns: 0 });
    expect(stoppedIds).toContain(depA.id);
    expect((await store.deployments.findById(depA.id))?.status).toBe("stopped");

    // Cleanup of A's container is scheduled once it has actually stopped. Drain jobs (the cutover
    // schedule + the waiting re-poll) also sit in the queue, so drain everything due at a far-future
    // time and assert one is the cleanup for A.
    const far = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const claimed: { kind: string; payload: Record<string, unknown> }[] = [];
    for (
      let job = await store.jobs.claimNext(far);
      job;
      job = await store.jobs.claimNext(far)
    ) {
      claimed.push({ kind: job.kind, payload: job.payload });
    }
    expect(claimed).toContainEqual({
      kind: "cleanup_deployment_container",
      payload: { deploymentId: depA.id },
    });
  });

  it("a FAILED deploy leaves the current live version serving (cutover only on success)", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "5".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "6".repeat(40) },
      store,
    );
    const good = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const, url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      good,
    );
    expect(depA.status).toBe("live");

    const bad = {
      store,
      deployTarget: fakeDeployTarget({ deployError: "boom" }),
      secrets: fakeSecrets(),
    };
    const depB = await deployRelease(
      { environmentId: ENV, releaseId: rB.id },
      bad,
    );
    expect(depB.status).toBe("failed");

    const all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === depA.id)?.status).toBe("live");
  });
});

describe("cleanupDeploymentContainer", () => {
  it("destroys a stopped, zero-weight deployment only when a live replacement exists", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c".repeat(40) },
      store,
    );
    const rB = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
        destroyedIds,
      }),
      secrets: fakeSecrets(),
    };

    const old = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    await deployRelease({ environmentId: ENV, releaseId: rB.id }, deps);
    // Cutover now leaves the old row `draining`; cleanup only reaps a `stopped` one. Simulate the
    // drain having completed (the drain watcher owns that transition — see drain.test.ts).
    await store.deployments.update(old.id, {
      status: "stopped",
      trafficWeight: 0,
    });

    const result = await cleanupDeploymentContainer(old.id, deps);

    expect(result).toEqual({ status: "destroyed" });
    expect(destroyedIds).toContain(old.id);
  });

  it("skips cleanup for live deployments", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const deps = {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
      secrets: fakeSecrets(),
    };
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );

    const result = await cleanupDeploymentContainer(dep.id, deps);

    expect(result).toEqual({ status: "skipped", reason: "deployment is live" });
    expect(destroyedIds).toEqual([]);
  });

  it("skips stopped deployments without a live replacement", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const dep = await store.deployments.insert({
      environmentId: ENV,
      releaseId: release.id,
      status: "stopped",
      trafficWeight: 0,
    });

    const result = await cleanupDeploymentContainer(dep.id, {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "no live replacement in environment",
    });
    expect(destroyedIds).toEqual([]);
  });

  it("destroys failed deployments even when no replacement exists", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "0".repeat(40) },
      store,
    );
    const destroyedIds: string[] = [];
    const dep = await store.deployments.insert({
      environmentId: ENV,
      releaseId: release.id,
      status: "failed",
      trafficWeight: 100,
    });

    const result = await cleanupDeploymentContainer(dep.id, {
      store,
      deployTarget: fakeDeployTarget({ destroyedIds }),
    });

    expect(result).toEqual({ status: "destroyed" });
    expect(destroyedIds).toContain(dep.id);
  });
});

describe("rollbackTo", () => {
  it("redeploys the prior release at 100 and demotes the current live version", async () => {
    const rA = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "1".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://a" },
      }),
      secrets: fakeSecrets(),
    };
    const depA = await deployRelease(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(depA.status).toBe("live");

    const rolled = await rollbackTo(
      { environmentId: ENV, releaseId: rA.id },
      deps,
    );
    expect(rolled.status).toBe("live");
    expect(rolled.trafficWeight).toBe(100);

    const all = await listDeployments(ENV, store);
    const demoted = all.find((d) => d.id === depA.id);
    // Demotion drains rather than stops (the container finishes in-flight turns first — #81).
    expect(demoted?.status).toBe("draining");
    expect(demoted?.trafficWeight).toBe(0);
    expect(all.filter((d) => d.status === "live")).toHaveLength(1);
  });
});

describe("team delegation env injection (D3)", () => {
  const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64); // 32-byte key as 64 hex chars
    store.seedAgent({
      id: "pm",
      projectId: PROJECT,
      name: "pm",
      root: "agents/pm/agent",
    });
    store.seedAgent({
      id: "deployer",
      projectId: PROJECT,
      name: "deployer",
      root: "agents/deployer/agent",
    });
    store.seedEnvironment({
      id: "env_pm",
      projectId: PROJECT,
      agentId: "pm",
      name: "production",
    });
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
    else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
  });

  function capturingTarget(
    builtReqs: Parameters<DeployTarget["build"]>[0][],
    deployedEnvs: Record<string, string>[],
  ): DeployTarget {
    return {
      name: "cap",
      async build(req) {
        builtReqs.push(req);
        return { imageRef: "img:fake", digest: "sha256:fake" };
      },
      async deploy(req) {
        deployedEnvs.push(req.env);
        return { status: "live", url: "http://x" };
      },
      async stop() {},
      async start() {
        return { status: "live" };
      },
      async health() {
        return { status: "stopped" };
      },
    };
  }

  it("bakes the tool flag and injects HARNESST_TEAM_* for a team member", async () => {
    const builtReqs: Parameters<DeployTarget["build"]>[0][] = [];
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: "pm", gitSha: "d4".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: "env_pm", releaseId: release.id },
      {
        store,
        deployTarget: capturingTarget(builtReqs, deployedEnvs),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    expect(dep.status).toBe("live");
    expect(builtReqs[0].injectTeammateTool).toBe(true);
    const env = deployedEnvs[0];
    expect(env.HARNESST_TEAM_URL).toBeTruthy();
    expect(env.HARNESST_TEAM_TOKEN.startsWith("ednt_")).toBe(true);
    // Roster excludes self (pm); the description blurb is the deployer's first paragraph.
    const teammates = JSON.parse(env.HARNESST_TEAMMATES) as {
      name: string;
      role: string;
    }[];
    expect(teammates).toContainEqual({
      name: "deployer",
      role: "Deploys builds to production.",
    });
    expect(teammates.map((t) => t.name)).not.toContain("pm");
  });

  it("does not inject team env for a single-agent repo", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "e5".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    expect(deployedEnvs[0].HARNESST_TEAM_URL).toBeUndefined();
    expect(deployedEnvs[0].HARNESST_TEAMMATES).toBeUndefined();
    // HARNESST_TEAM_TOKEN is NOT asserted absent: since WS2 every deployment carries one so its
    // baked run-reporting hook can identify itself. The token conveys a deployment id and no
    // capability — every endpoint that accepts it (relay, Discord send, park, runs) re-derives
    // the caller and scopes to that caller's own agent — so team membership is decided by the
    // two vars above, which a single-agent repo still does not get.
  });
});

describe("Codex model-gateway env injection (issue #28)", () => {
  const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64); // gateway token is HMAC-minted from this
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
    else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
  });

  it("injects a verifiable gateway URL + token when the org has a Codex connection, stripping a squatter", async () => {
    const { verifyGatewayToken } = await import("~/gateway/token.server");
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c1".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret trying to smuggle its own gateway token — harnesst must strip it.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          HARNESST_MODEL_GATEWAY_TOKEN: "smuggled",
          HARNESST_MODEL_GATEWAY_URL: "http://evil",
        }),
        providerDeploymentEnv: async () => ({}),
        hasCodexConnection: async () => true,
        sandboxExposedNames: async () => [
          "HARNESST_MODEL_GATEWAY_TOKEN",
          "HARNESST_MODEL_GATEWAY_URL",
        ],
      },
    );
    expect(dep.status).toBe("live");
    const env = deployedEnvs[0];
    expect(env.HARNESST_MODEL_GATEWAY_URL).toContain("/api/gateway/v1");
    expect(env.HARNESST_MODEL_GATEWAY_URL).not.toBe("http://evil");
    expect(verifyGatewayToken(env.HARNESST_MODEL_GATEWAY_TOKEN)).toBe(ORG);
    expect(env).not.toHaveProperty("HARNESST_SANDBOX_ENV");
  });

  it("lets a codex-only org (no OpenRouter key) deploy — the gateway token satisfies the credential check", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c2".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets(),
        providerDeploymentEnv: async () => ({}),
        hasCodexConnection: async () => true,
      },
    );
    expect(dep.status).toBe("live");
    expect(deployedEnvs[0].OPENROUTER_API_KEY).toBeUndefined();
    expect(deployedEnvs[0].HARNESST_MODEL_GATEWAY_TOKEN).toBeTruthy();
  });

  it("injects the gateway env even without a Codex connection — runtime model-config rides on it", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c3".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "smuggled" }),
        providerDeploymentEnv: async () => ({
          HARNESST_PROVIDER_OPENROUTER_ABCDEFGHIJKL_API_KEY: "k",
          OPENROUTER_API_KEY: "k",
        }),
        hasCodexConnection: async () => false,
      },
    );
    const { verifyGatewayToken } = await import("~/gateway/token.server");
    expect(deployedEnvs[0].HARNESST_MODEL_GATEWAY_URL).toContain("/api/gateway/v1");
    expect(verifyGatewayToken(deployedEnvs[0].HARNESST_MODEL_GATEWAY_TOKEN)).toBe(
      ORG,
    );
  });

  it("still fails the credential check for an org with no model source — the always-on gateway token is not a credential", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c4".repeat(20) },
      store,
    );
    const result = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" } }),
        secrets: fakeSecrets(),
        providerDeploymentEnv: async () => ({}),
        hasCodexConnection: async () => false,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.errorDetail).toContain("No model provider credential");
  });
});

describe("setTrafficSplit", () => {
  it("applies weights within the environment and clamps negatives to 0", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "2".repeat(40) },
      store,
    );
    const deps = {
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live", url: "http://y" },
      }),
      secrets: fakeSecrets(),
    };
    const d1 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );
    const d2 = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      deps,
    );

    await setTrafficSplit(
      ENV,
      [
        { deploymentId: d1.id, weight: 90 },
        { deploymentId: d2.id, weight: 10 },
      ],
      store,
    );
    let all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d1.id)?.trafficWeight).toBe(90);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(10);

    await setTrafficSplit(ENV, [{ deploymentId: d2.id, weight: -5 }], store);
    all = await listDeployments(ENV, store);
    expect(all.find((d) => d.id === d2.id)?.trafficWeight).toBe(0);
  });
});

describe("shared Discord app env injection (issue #32)", () => {
  const KEYS = [
    "HARNESST_SECRETS_KEY",
    "HARNESST_DISCORD_APPLICATION_ID",
    "HARNESST_DISCORD_BOT_TOKEN",
    "HARNESST_DISCORD_PUBLIC_KEY",
  ] as const;
  const OLD: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) OLD[k] = process.env[k];
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64); // the send-proxy token is HMAC-minted
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (OLD[k] === undefined) delete process.env[k];
      else process.env[k] = OLD[k];
    }
  });

  function configureSharedApp() {
    process.env.HARNESST_DISCORD_APPLICATION_ID = "app_shared";
    process.env.HARNESST_DISCORD_BOT_TOKEN = "bot_shared";
    process.env.HARNESST_DISCORD_PUBLIC_KEY = "pub_shared";
  }

  it("injects the public credentials + send URL and strips the bot token, even if a user secret sets it", async () => {
    configureSharedApp();
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "f6".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret trying to smuggle a bot token — harnesst must strip it.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          DISCORD_BOT_TOKEN: "user_bot",
          DISCORD_APPLICATION_ID: "user_app",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.DISCORD_APPLICATION_ID).toBe("app_shared");
    expect(env.DISCORD_PUBLIC_KEY).toBe("pub_shared");
    expect(env.HARNESST_DISCORD_SEND_URL).toMatch(/\/api\/discord\/send$/);
    expect(env).not.toHaveProperty("DISCORD_BOT_TOKEN");
  });

  it("mints HARNESST_TEAM_TOKEN for a single-agent deployment (root 'agent' — no team block) so the send proxy is reachable", async () => {
    configureSharedApp();
    const { verifyDelegationToken } = await import("~/team/token.server");
    const deployedEnvs: Record<string, string>[] = [];
    // The default seeded AGENT has root "agent" — never a team member, so the team block above
    // sets no token; the Discord block must mint one or discord-send-message can't authenticate.
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "b8".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.HARNESST_TEAM_URL).toBeUndefined(); // still not a team member…
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(dep.id); // …but the send token exists
  });

  it("keeps the team block's HARNESST_TEAM_TOKEN for a team member (??= never clobbers)", async () => {
    configureSharedApp();
    const { verifyDelegationToken } = await import("~/team/token.server");
    store.seedAgent({
      id: "pm2",
      projectId: PROJECT,
      name: "pm2",
      root: "agents/pm2/agent",
    });
    store.seedEnvironment({
      id: "env_pm2",
      projectId: PROJECT,
      agentId: "pm2",
      name: "production",
    });
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: "pm2", gitSha: "c9".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: "env_pm2", releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.HARNESST_TEAM_URL).toBeTruthy(); // the team block ran and set the token first
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(dep.id);
    expect(env.HARNESST_DISCORD_SEND_URL).toMatch(/\/api\/discord\/send$/);
  });

  it("leaves user-resolved Discord secrets untouched when the operator app is absent", async () => {
    delete process.env.HARNESST_DISCORD_APPLICATION_ID;
    delete process.env.HARNESST_DISCORD_BOT_TOKEN;
    delete process.env.HARNESST_DISCORD_PUBLIC_KEY;
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "a7".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          DISCORD_BOT_TOKEN: "user_bot",
          DISCORD_APPLICATION_ID: "user_app",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.DISCORD_BOT_TOKEN).toBe("user_bot");
    expect(env.DISCORD_APPLICATION_ID).toBe("user_app");
    expect(env).not.toHaveProperty("HARNESST_DISCORD_SEND_URL");
    // The send proxy is what this test is about, and its absence is the whole story: without a
    // URL to send to, the token cannot reach Discord. (Since WS2 every deployment carries a
    // token for run reporting, so its presence no longer distinguishes anything here.)
  });
});

describe("Google connection env injection (issue #30)", () => {
  // Deploys that broker an access-token-broker provider (the real mayi entry, issue #167) mint
  // a delegation token, which is HMAC-keyed by the secrets key.
  const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
    else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
  });

  it("leaves a self-hoster's manually-set GOOGLE_OAUTH_* untouched when there's no grant to broker", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d1".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // The self-hoster runs their OWN Google client + token — no broker grant exists.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          GOOGLE_OAUTH_CLIENT_ID: "my_client",
          GOOGLE_OAUTH_CLIENT_SECRET: "my_secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "my_token",
        }),
        connectionGrantEnv: async () => ({}), // no operator config / no active grant
      },
    );
    const env = deployedEnvs[0];
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe("my_client");
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBe("my_secret");
    expect(env.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("my_token");
  });

  it("replaces user-set GOOGLE_OAUTH_* with harnesst's brokered creds when a grant is injected", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d2".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret trying to shadow the brokered token — harnesst owns these keys when it brokers.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          GOOGLE_OAUTH_REFRESH_TOKEN: "user_token",
          // Shadowing the granted-scope report (issue #165) is also anti-shadowed away.
          GOOGLE_OAUTH_SCOPES: "user_scopes",
        }),
        connectionGrantEnv: async () => ({
          GOOGLE_OAUTH_CLIENT_ID: "broker_client",
          GOOGLE_OAUTH_CLIENT_SECRET: "broker_secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "broker_token",
          GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/gmail.readonly",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe("broker_client");
    expect(env.GOOGLE_OAUTH_CLIENT_SECRET).toBe("broker_secret");
    expect(env.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("broker_token");
    expect(env.GOOGLE_OAUTH_SCOPES).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });

  it("injects a second provider's <PREFIX>_OAUTH_* trio alongside Google's, replacing user-set values (issue #163)", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d3".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret trying to shadow the second provider's brokered token.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          MAYI_OAUTH_REFRESH_TOKEN: "user_token",
        }),
        connectionGrantEnv: async () => ({
          GOOGLE_OAUTH_CLIENT_ID: "g_client",
          GOOGLE_OAUTH_CLIENT_SECRET: "g_secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "g_token",
          MAYI_OAUTH_CLIENT_ID: "m_client",
          MAYI_OAUTH_CLIENT_SECRET: "m_secret",
          MAYI_OAUTH_REFRESH_TOKEN: "m_token",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.GOOGLE_OAUTH_CLIENT_ID).toBe("g_client");
    expect(env.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("g_token");
    expect(env.MAYI_OAUTH_CLIENT_ID).toBe("m_client");
    expect(env.MAYI_OAUTH_CLIENT_SECRET).toBe("m_secret");
    expect(env.MAYI_OAUTH_REFRESH_TOKEN).toBe("m_token");
  });

  it("injects broker coordinates (HARNESST_API_URL + delegation token) for an access-token-broker provider (issue #167)", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d4".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // User secrets trying to shadow the harnesst-owned broker coordinates and the provider's
        // static deploy constant.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          HARNESST_API_URL: "https://evil.example",
          MAYI_CALLBACK_STATE_KEY_ID: "user_kid",
        }),
        // Brokered delivery (real mayi entry): scopes + deployEnv constants, no OAuth trio.
        connectionGrantEnv: async () => ({
          MAYI_OAUTH_SCOPES: "approval:create approval:read approval:cancel",
          MAYI_CALLBACK_STATE_KEY_ID: "k1",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.MAYI_CALLBACK_STATE_KEY_ID).toBe("k1");
    expect(env.MAYI_OAUTH_SCOPES).toBe("approval:create approval:read approval:cancel");
    // The refresh token NEVER ships for brokered providers.
    expect(env).not.toHaveProperty("MAYI_OAUTH_REFRESH_TOKEN");
    expect(env).not.toHaveProperty("MAYI_OAUTH_CLIENT_ID");
    // Broker coordinates are harnesst-owned: the user-set HARNESST_API_URL is replaced, and the
    // delegation token identifies THIS deployment (same auth story as the Discord send proxy).
    expect(env.HARNESST_API_URL).toMatch(/^http:\/\/host\.docker\.internal:/);
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(dep.id);
  });

  it("strips user-set XERO_OAUTH_* for a capability provider — the marker, not <PREFIX>_OAUTH_*, names it (issue #166)", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d6".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A leftover self-managed Xero connector's secrets: capability delivery means the
        // container must hold NO Xero credential material at all (acceptance criterion 3).
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          XERO_OAUTH_CLIENT_ID: "user_client",
          XERO_OAUTH_CLIENT_SECRET: "user_secret",
          XERO_OAUTH_REFRESH_TOKEN: "user_token",
          XERO_OAUTH_SCOPES: "user_scopes",
          HARNESST_CAPABILITY_PROVIDERS: "user_marker",
        }),
        // Capability delivery (real xero entry): ONLY the harnesst-owned marker, no OAuth vars.
        connectionGrantEnv: async () => ({ HARNESST_CAPABILITY_PROVIDERS: "xero" }),
      },
    );
    const env = deployedEnvs[0];
    for (const suffix of ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "SCOPES"]) {
      expect(env).not.toHaveProperty(`XERO_OAUTH_${suffix}`);
    }
    expect(env.HARNESST_CAPABILITY_PROVIDERS).toBe("xero");
    // The capability tools' coordinates ride along, same as the token broker's.
    expect(env.HARNESST_API_URL).toMatch(/^http:\/\/host\.docker\.internal:/);
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(dep.id);
  });

  it("does not inject broker coordinates for refresh-token providers (google regression, issue #167)", async () => {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d5".repeat(20) },
      store,
    );
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
        connectionGrantEnv: async () => ({
          GOOGLE_OAUTH_CLIENT_ID: "g_client",
          GOOGLE_OAUTH_CLIENT_SECRET: "g_secret",
          GOOGLE_OAUTH_REFRESH_TOKEN: "g_token",
          GOOGLE_OAUTH_SCOPES: "s",
        }),
      },
    );
    const env = deployedEnvs[0];
    expect(env.GOOGLE_OAUTH_REFRESH_TOKEN).toBe("g_token");
    // The regression this pins is the BROKER coordinate: a refresh-token provider must not be
    // handed HARNESST_API_URL, so nothing in the image tries to broker Google at runtime.
    expect(env).not.toHaveProperty("HARNESST_API_URL");
    // (HARNESST_TEAM_TOKEN is no longer a signal here — since WS2 every deployment carries one
    // for run reporting, and with no HARNESST_API_URL there is no broker for it to call.)
  });
});

describe("deploy-time scope-coverage validation (issue #69)", () => {
  const LOCK = JSON.stringify({
    version: 1,
    installs: [
      {
        id: "sheets",
        type: "connection",
        name: "Sheets",
        version: "1.0.0",
        hash: "h",
        registry: "fixture",
        member: null,
        files: ["agent/tools/sheets.ts"],
        auth: [
          {
            provider: "google",
            kind: "oauth2",
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    // agentLock only runs when the project has full repo coordinates.
    store.seedProject({
      id: PROJECT,
      orgId: ORG,
      repoOwner: "acme",
      repoName: "agent",
      repoInstallationId: "inst_1",
    });
  });

  it("passes the lock's required google scopes through to connectionGrantEnv", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "aa".repeat(20) },
      store,
    );
    const seen: (ReadonlyMap<string, string[]> | null | undefined)[] = [];
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" } }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
        agentLock: async () => LOCK,
        connectionGrantEnv: async (_scope, requiredScopes) => {
          seen.push(requiredScopes);
          return {};
        },
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.get("google")).toEqual([
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
  });

  it("fails the deploy when connectionGrantEnv rejects an under-scoped grant", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "bb".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" } }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
        agentLock: async () => LOCK,
        connectionGrantEnv: async (_scope, requiredScopes) => {
          if (requiredScopes?.get("google")?.length)
            throw new Error("missing required permission(s): spreadsheets");
          return {};
        },
      },
    );
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toContain("missing required permission");
  });
});

describe("generated-secret mint-once (issue #163)", () => {
  // A lock-declared `generated` secret: nobody types it — harnesst mints it at first deploy.
  const LOCK = JSON.stringify({
    version: 1,
    installs: [
      {
        id: "mayi-approvals",
        type: "connection",
        name: "May I? approvals",
        version: "1.0.0",
        hash: "h",
        registry: "fixture",
        member: null,
        files: [],
        secrets: [{ name: "MAYI_STATE_KEY", generated: true }],
      },
    ],
  });

  beforeEach(() => {
    // agentLock only runs when the project has full repo coordinates.
    store.seedProject({
      id: PROJECT,
      orgId: ORG,
      repoOwner: "acme",
      repoName: "agent",
      repoInstallationId: "inst_1",
    });
  });

  /**
   * A stateful SecretsProvider: set() persists to the exact (agent, env, name) rows that get()
   * reads back, and resolve() layers those rows over `base` (values from OTHER cascade scopes),
   * like the DB. `exactRows` pre-seeds stored (agent, env, name) rows.
   */
  function mintingSecrets(
    base: Record<string, string>,
    exactRows: Record<string, string> = {},
  ) {
    const stored: Record<string, string> = { ...exactRows };
    const setCalls: { key: string; value: string }[] = [];
    const provider: SecretsProvider = {
      name: "fake",
      async set(ref, value) {
        stored[ref.key] = value;
        setCalls.push({ key: ref.key, value });
      },
      async get(ref) {
        return stored[ref.key] ?? null;
      },
      async delete() {},
      async listNames() {
        return [];
      },
      async resolve() {
        return { ...base, ...stored };
      },
    };
    return { provider, setCalls };
  }

  it("mints once at first deploy and reuses the identical value on the next", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "cc".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const { provider, setCalls } = mintingSecrets({ OPENROUTER_API_KEY: "k" });
    const depsFor = () => ({
      store,
      deployTarget: fakeDeployTarget({
        health: { status: "live" as const },
        deployedEnvs,
      }),
      secrets: provider,
      agentLock: async () => LOCK,
    });

    await deployRelease({ environmentId: ENV, releaseId: release.id }, depsFor());
    await deployRelease({ environmentId: ENV, releaseId: release.id }, depsFor());

    // Exactly one mint: 32 random bytes base64url (43 chars), persisted through the seam.
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe("MAYI_STATE_KEY");
    expect(setCalls[0].value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Both containers received the SAME value — stable across redeploys.
    expect(deployedEnvs).toHaveLength(2);
    expect(deployedEnvs[0].MAYI_STATE_KEY).toBe(setCalls[0].value);
    expect(deployedEnvs[1].MAYI_STATE_KEY).toBe(setCalls[0].value);
  });

  it("suppresses the mint only for an existing exact (agent, env, name) row", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "dd".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    const { provider, setCalls } = mintingSecrets(
      { OPENROUTER_API_KEY: "k" },
      { MAYI_STATE_KEY: "already-minted" },
    );

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: provider,
        agentLock: async () => LOCK,
      },
    );

    expect(setCalls).toHaveLength(0);
    expect(deployedEnvs[0].MAYI_STATE_KEY).toBe("already-minted");
  });

  it("mints despite a same-named value from another scope level — generated material is nobody's credential", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ab".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    // A user/shared/agent-scoped MAYI_STATE_KEY resolves from the cascade, but no exact
    // (agent, env, name) row exists — harnesst must still mint, and the mint must win.
    const { provider, setCalls } = mintingSecrets({
      OPENROUTER_API_KEY: "k",
      MAYI_STATE_KEY: "user-shadow-attempt",
    });

    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: provider,
        agentLock: async () => LOCK,
      },
    );

    expect(setCalls).toHaveLength(1);
    expect(deployedEnvs[0].MAYI_STATE_KEY).toBe(setCalls[0].value);
    expect(deployedEnvs[0].MAYI_STATE_KEY).not.toBe("user-shadow-attempt");
  });

  it("fails the deploy when the lock fetch fails — required generated secrets can't be determined", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ba".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" } }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
        agentLock: async () => {
          throw new Error("GitHub 502");
        },
      },
    );
    expect(dep.status).toBe("failed");
    expect(dep.errorDetail).toContain("harnesst-lock.json");
    expect(dep.errorDetail).toContain("GitHub 502");
  });

  it("deploys with nothing to mint when the repo simply has no lock file", async () => {
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "cd".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" } }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k" }),
        agentLock: async () => null,
      },
    );
    expect(dep.status).toBe("live");
  });
});

describe("EVE_PUBLIC_ORIGIN injection (issue #163)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("injects the per-environment ingress URL, overriding a user-set value, when HARNESST_PUBLIC_ORIGIN is set", async () => {
    vi.stubEnv("HARNESST_PUBLIC_ORIGIN", "https://harnesst.example.com");
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ee".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        // A user secret must not shadow the derived origin when harnesst injects it.
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          EVE_PUBLIC_ORIGIN: "https://user.example",
        }),
      },
    );
    expect(deployedEnvs[0].EVE_PUBLIC_ORIGIN).toBe(
      envIngressUrl("https://harnesst.example.com", ENV),
    );
  });

  it("passes a user-set EVE_PUBLIC_ORIGIN through when HARNESST_PUBLIC_ORIGIN is unset", async () => {
    vi.stubEnv("HARNESST_PUBLIC_ORIGIN", "");
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "ff".repeat(20) },
      store,
    );
    const deployedEnvs: Record<string, string>[] = [];
    await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({
          health: { status: "live" },
          deployedEnvs,
        }),
        secrets: fakeSecrets({
          OPENROUTER_API_KEY: "k",
          EVE_PUBLIC_ORIGIN: "https://self-managed.example",
        }),
      },
    );
    expect(deployedEnvs[0].EVE_PUBLIC_ORIGIN).toBe(
      "https://self-managed.example",
    );
  });
});

describe("channel park env injection (WS1)", () => {
  const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
  const OLD_RELAY = process.env.HARNESST_TEAM_RELAY_URL;

  /** A lock naming the github channel install — the only signal harnesst gates the env on. */
  function lockWith(
    id: string,
    member: string | null = null,
    type: "channel" | "tool" | "hook" | "skill" = "channel",
  ) {
    return JSON.stringify({
      version: 1,
      installs: [
        {
          id,
          type,
          name: id,
          version: "0.3.0",
          hash: "h",
          registry: "fixture",
          member,
          files: [`channels/${id}.ts`],
        },
      ],
    });
  }

  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
    process.env.HARNESST_TEAM_RELAY_URL = "https://harnesst.example";
    store.seedProject({
      id: PROJECT,
      orgId: ORG,
      repoOwner: "acme",
      repoName: "agent",
      // agentLock only runs with full repo coordinates.
      repoInstallationId: "inst_1",
    });
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
    else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
    if (OLD_RELAY === undefined) delete process.env.HARNESST_TEAM_RELAY_URL;
    else process.env.HARNESST_TEAM_RELAY_URL = OLD_RELAY;
  });

  async function deployWith(input: {
    lock?: string;
    secrets?: Record<string, string>;
  }): Promise<Record<string, string>> {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "c1".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" }, deployedEnvs }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k", ...(input.secrets ?? {}) }),
        ...(input.lock ? { agentLock: async () => input.lock! } : {}),
      },
    );
    expect(dep.status).toBe("live");
    return deployedEnvs[0];
  }

  it("wires the park URL and a delegation token when the lock installs the github channel", async () => {
    const env = await deployWith({ lock: lockWith("github") });

    expect(env.HARNESST_FOH_PARK_URL).toBe("https://harnesst.example/api/foh/park");
    // The channel's answer route is otherwise unauthenticated: it compares the presented bearer
    // against this baked token, so the two MUST be the same value.
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(
      (await listDeployments(ENV, store))[0].id,
    );
  });

  it("leaves the park env off an agent with no park-capable channel installed", async () => {
    const env = await deployWith({ lock: lockWith("discord") });

    expect(env).not.toHaveProperty("HARNESST_FOH_PARK_URL");
  });

  it("leaves the park env off a repo with no lock at all", async () => {
    const env = await deployWith({});

    expect(env).not.toHaveProperty("HARNESST_FOH_PARK_URL");
  });

  it("ignores a non-channel install that merely shares the channel's id", async () => {
    // `findInstall` matches on id + member only. A tool (or hook, or skill) a user happens to
    // call `github` has no channel-homed session and no answer route, so baking a park URL and a
    // delegation token into its container would hand park rights to code that cannot use them
    // for anything except naming somebody else's session.
    const env = await deployWith({ lock: lockWith("github", null, "tool") });

    expect(env).not.toHaveProperty("HARNESST_FOH_PARK_URL");
  });

  it("strips a user secret of the same name before setting its own (anti-shadowing)", async () => {
    // A user-set HARNESST_FOH_PARK_URL would otherwise aim every parked question at a URL of
    // the user's choosing, carrying the agent's delegation token with it.
    const env = await deployWith({
      lock: lockWith("github"),
      secrets: { HARNESST_FOH_PARK_URL: "https://attacker.example/collect" },
    });

    expect(env.HARNESST_FOH_PARK_URL).toBe("https://harnesst.example/api/foh/park");
  });

  it("removes the park URL when the channel is uninstalled and the agent redeployed", async () => {
    const first = await deployWith({ lock: lockWith("github") });
    expect(first.HARNESST_FOH_PARK_URL).toBeTruthy();

    const second = await deployWith({ lock: JSON.stringify({ version: 1, installs: [] }) });

    expect(second).not.toHaveProperty("HARNESST_FOH_PARK_URL");
  });
});

/**
 * WS2 — run-reporting env. The hook baked into every image is inert without these two vars, so
 * this is the wiring that decides whether channel work is visible at all. Unlike the park env it
 * is UNGATED: no lock, no channel, no team membership.
 */
describe("run reporting env injection (WS2)", () => {
  const OLD_KEY = process.env.HARNESST_SECRETS_KEY;
  const OLD_RELAY = process.env.HARNESST_TEAM_RELAY_URL;

  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = "a".repeat(64);
    process.env.HARNESST_TEAM_RELAY_URL = "https://harnesst.example";
    store.seedProject({
      id: PROJECT,
      orgId: ORG,
      repoOwner: "acme",
      repoName: "agent",
      repoInstallationId: "inst_1",
    });
  });
  afterEach(() => {
    if (OLD_KEY === undefined) delete process.env.HARNESST_SECRETS_KEY;
    else process.env.HARNESST_SECRETS_KEY = OLD_KEY;
    if (OLD_RELAY === undefined) delete process.env.HARNESST_TEAM_RELAY_URL;
    else process.env.HARNESST_TEAM_RELAY_URL = OLD_RELAY;
  });

  async function deployWith(
    secrets: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const deployedEnvs: Record<string, string>[] = [];
    const release = await createRelease(
      { projectId: PROJECT, agentId: AGENT, gitSha: "d1".repeat(20) },
      store,
    );
    const dep = await deployRelease(
      { environmentId: ENV, releaseId: release.id },
      {
        store,
        deployTarget: fakeDeployTarget({ health: { status: "live" }, deployedEnvs }),
        secrets: fakeSecrets({ OPENROUTER_API_KEY: "k", ...secrets }),
      },
    );
    expect(dep.status).toBe("live");
    return deployedEnvs[0];
  }

  it("wires the runs URL and a delegation token into a plain, channel-less deployment", async () => {
    const env = await deployWith();

    expect(env.HARNESST_RUNS_URL).toBe("https://harnesst.example/api/agent/runs");
    // The endpoint authenticates the deployment by this token alone — it must name THIS one.
    expect(verifyDelegationToken(env.HARNESST_TEAM_TOKEN)).toBe(
      (await listDeployments(ENV, store))[0].id,
    );
  });

  it("strips a user secret of the same name before setting its own (anti-shadowing)", async () => {
    // Left standing, this would post every turn's full transcript — and the agent's delegation
    // token — to a URL of the user's choosing.
    const env = await deployWith({
      HARNESST_RUNS_URL: "https://attacker.example/collect",
    });

    expect(env.HARNESST_RUNS_URL).toBe("https://harnesst.example/api/agent/runs");
  });
});
