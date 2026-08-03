/**
 * Auto-redeploy after connect/reconnect (issue #69). Verifies the decision logic against injected
 * fakes: it redeploys every LIVE environment (image reused) so a fresh grant reaches the running
 * container, records desired env even when the agent is stopped, and surfaces reconciliation
 * errors instead of throwing.
 */
import { describe, expect, it, vi } from "vitest";

import { redeployAfterConnect, type RedeployAfterConnectDeps } from "~/connections/redeploy.server";
import type { DeploymentWithRelease, Environment } from "~/data/ports";

const PROJECT = "proj_1";
const AGENT = "agent_1";

function env(id: string, name: string): Environment {
  return { id, name, agentId: AGENT } as unknown as Environment;
}

function liveDep(releaseId: string): DeploymentWithRelease {
  return {
    id: `dep_${releaseId}`,
    status: "live",
    envRevision: 0,
    trafficWeight: 100,
    url: "http://x",
    errorDetail: null,
    createdAt: new Date(),
    releaseId,
    version: "v1",
    gitSha: "a".repeat(40),
  };
}

function deps(over: Partial<RedeployAfterConnectDeps> = {}): RedeployAfterConnectDeps {
  return {
    listAgentEnvironments: async () => [env("env_1", "production")],
    listDeployments: async () => [liveDep("rel_1")],
    invalidate: async () => ({ environmentIds: [] }),
    ...over,
  };
}

describe("redeployAfterConnect", () => {
  it("returns not-deployed but invalidates desired env for a future stopped-instance wake", async () => {
    const invalidate = vi.fn(async () => ({ environmentIds: [] }));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({ listDeployments: async () => [], invalidate }),
    );
    expect(out).toEqual({ status: "not-deployed" });
    expect(invalidate).toHaveBeenCalledWith({
      agentIds: [AGENT],
      createdBy: null,
    });
  });

  it("invalidates and reports the live environment", async () => {
    const invalidate = vi.fn(async () => ({ environmentIds: ["env_1"] }));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT, createdBy: "user_1" },
      deps({ invalidate }),
    );
    expect(out).toEqual({ status: "redeployed", envNames: ["production"] });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      agentIds: [AGENT],
      createdBy: "user_1",
    });
  });

  it("returns error with the message when invalidation throws", async () => {
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({
        invalidate: async () => {
          throw new Error("queue is down");
        },
      }),
    );
    expect(out).toEqual({ status: "error", message: "queue is down" });
  });

  it("redeploys every live environment and returns all their names", async () => {
    const invalidate = vi.fn(async () => ({
      environmentIds: ["env_stg", "env_prod"],
    }));
    const out = await redeployAfterConnect(
      { projectId: PROJECT, agentId: AGENT },
      deps({
        listAgentEnvironments: async () => [env("env_stg", "staging"), env("env_prod", "production")],
        listDeployments: async (environmentId) =>
          environmentId === "env_stg" ? [liveDep("rel_stg")] : [liveDep("rel_prod")],
        invalidate,
      }),
    );
    expect(out).toEqual({
      status: "redeployed",
      envNames: ["staging", "production"],
    });
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
