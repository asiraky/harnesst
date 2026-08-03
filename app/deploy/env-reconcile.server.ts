/**
 * Desired/live reconciliation for process environment.
 *
 * Containers cannot mutate process env after creation. Writers therefore bump the affected
 * environment's monotonic desired revision and enqueue this durable reconciler. Deployments
 * capture that revision immediately before resolving env, making races with an in-flight deploy
 * observable instead of silently freezing stale credentials forever.
 */
import type { DataStore } from "~/data/ports";
import { enqueue } from "~/jobs/queue.server";
import { getRuntime } from "~/seams/index.server";

const RETRY_DELAY_MS = 2_500;
const IN_FLIGHT = new Set(["pending", "building"]);

export interface EnvInvalidationDeps {
  store: DataStore;
  enqueue: typeof enqueue;
  ensureWorkerStarted: () => void;
}

function invalidationDeps(): EnvInvalidationDeps {
  const store = getRuntime().data;
  return {
    store,
    enqueue,
    ensureWorkerStarted: () => {
      void import("~/jobs/worker.server").then((m) => m.ensureWorkerStarted());
    },
  };
}

/** Persist and queue invalidation for every environment owned by the given agents. */
export async function invalidateAgentEnvironments(
  input: {
    agentIds: string[];
    environmentId?: string | null;
    createdBy?: string | null;
  },
  deps: EnvInvalidationDeps = invalidationDeps(),
): Promise<{ environmentIds: string[] }> {
  const agentIds = [...new Set(input.agentIds.filter(Boolean))];
  if (agentIds.length === 0) return { environmentIds: [] };

  deps.ensureWorkerStarted();
  const environments = (
    await Promise.all(
      agentIds.map((agentId) => deps.store.environments.listByAgent(agentId)),
    )
  )
    .flat()
    .filter((environment) =>
      input.environmentId ? environment.id === input.environmentId : true,
    );

  for (const environment of environments) {
    const revision = await deps.store.environments.bumpEnvRevision(
      environment.id,
    );
    if (revision === null) continue;
    await deps.enqueue(
      "reconcile_environment_env",
      {
        environmentId: environment.id,
        createdBy: input.createdBy ?? null,
      },
      undefined,
      deps.store,
    );
  }
  return { environmentIds: environments.map((environment) => environment.id) };
}

/** Invalidate ordinary deployed agents across an org (for org-scoped provider credentials). */
export async function invalidateOrganizationEnvironments(
  input: { orgId: string; createdBy?: string | null },
  deps: EnvInvalidationDeps = invalidationDeps(),
): Promise<{ environmentIds: string[] }> {
  const projects = await deps.store.projects.listByOrg(input.orgId);
  const agents = (
    await Promise.all(
      projects.map((project) => deps.store.agents.listByProject(project.id)),
    )
  )
    .flat()
    .filter((agent) => agent.kind === "member");
  return invalidateAgentEnvironments(
    {
      agentIds: agents.map((agent) => agent.id),
      createdBy: input.createdBy,
    },
    deps,
  );
}

export type EnvReconcileResult =
  | { status: "missing" | "not-deployed" | "stopped" | "current" }
  | { status: "covered"; deploymentId: string }
  | { status: "waiting"; deploymentId: string }
  | { status: "redeploying"; deploymentId: string };

export interface EnvReconcileDeps {
  store: DataStore;
  queueDeploy: (input: {
    environmentId: string;
    releaseId: string;
    rollback?: boolean;
    createdBy?: string | null;
  }) => Promise<{ id: string }>;
  enqueue: typeof enqueue;
}

function reconcileDeps(): EnvReconcileDeps {
  const store = getRuntime().data;
  return {
    store,
    queueDeploy: (input) =>
      import("~/deploy/controller.server").then((m) =>
        m.queueDeploy(input, store),
      ),
    enqueue,
  };
}

/** One reconciliation tick. Stopped instances stay scaled to zero and refresh on their next wake. */
export async function reconcileEnvironmentEnv(
  input: { environmentId: string; createdBy?: string | null },
  deps: EnvReconcileDeps = reconcileDeps(),
): Promise<EnvReconcileResult> {
  const environment = await deps.store.environments.findById(
    input.environmentId,
  );
  if (!environment) return { status: "missing" };

  const rows = await deps.store.deployments.listByEnvironment(environment.id);
  const live = rows.find((deployment) => deployment.status === "live");
  if (live && live.envRevision >= environment.envRevision)
    return { status: "current" };

  const inFlight = rows.find((deployment) => IN_FLIGHT.has(deployment.status));
  if (inFlight) {
    if (inFlight.envRevision >= environment.envRevision) {
      return { status: "covered", deploymentId: inFlight.id };
    }
    await deps.enqueue(
      "reconcile_environment_env",
      input,
      { runAt: new Date(Date.now() + RETRY_DELAY_MS) },
      deps.store,
    );
    return { status: "waiting", deploymentId: inFlight.id };
  }

  if (!live) {
    return {
      status: rows.some((deployment) => deployment.status === "stopped")
        ? "stopped"
        : "not-deployed",
    };
  }

  const deployment = await deps.queueDeploy({
    environmentId: environment.id,
    releaseId: live.releaseId,
    rollback: true,
    createdBy: input.createdBy ?? null,
  });
  return { status: "redeploying", deploymentId: deployment.id };
}

/** Boot repair for a crash between revision bump and job insertion. */
export async function reconcileAllEnvironmentEnv(
  deps: EnvReconcileDeps = reconcileDeps(),
): Promise<{ checked: number; stale: number }> {
  const environments = await deps.store.environments.listAll();
  let stale = 0;
  for (const environment of environments) {
    const result = await reconcileEnvironmentEnv(
      { environmentId: environment.id },
      deps,
    );
    if (
      !["current", "not-deployed", "stopped", "missing"].includes(result.status)
    )
      stale++;
  }
  return { checked: environments.length, stale };
}
