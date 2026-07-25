/**
 * Repository lifecycle (M5.8). Deleting a repository is a FULL harnesst-side teardown (owner
 * decision): every member environment's instances are destroyed (containers via
 * DeployTarget.destroy, stop fallback) and each environment's shared Workflow world DB is
 * dropped (destroyWorld), then the project row is deleted and the FK cascade takes agents,
 * environments, releases, deployments, drafts, secrets, and run history with it. The GitHub
 * repository itself is NEVER touched.
 */
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget } from "~/seams/types";

export interface RepositoryDeps {
  store: DataStore;
  deployTarget: DeployTarget;
}

export const REPOSITORY_TEARDOWN_TIMEOUT_MS = Number(
  process.env.HARNESST_REPOSITORY_TEARDOWN_TIMEOUT_MS ?? 60 * 1000,
);

function repoDeps(): RepositoryDeps {
  const r = getRuntime();
  return { store: r.data, deployTarget: r.deployTarget };
}

async function bestEffortTeardown(
  label: string,
  operation: () => Promise<void>,
): Promise<"ok" | "failed" | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(resolve, REPOSITORY_TEARDOWN_TIMEOUT_MS, "timed_out");
  });
  try {
    const result = await Promise.race([
      operation().then(
        () => "ok" as const,
        (error) => {
          console.warn(
            `[repository.delete] ${label} failed; continuing`,
            error,
          );
          return "failed" as const;
        },
      ),
      timeout,
    ]);
    if (result === "timed_out") {
      console.warn(
        `[repository.delete] ${label} timed out after ${REPOSITORY_TEARDOWN_TIMEOUT_MS}ms; continuing`,
      );
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function deleteRepository(
  input: { projectId: string; createdBy?: string | null },
  deps: RepositoryDeps = repoDeps(),
): Promise<void> {
  const { store, deployTarget } = deps;
  const project = await store.projects.findById(input.projectId);
  if (!project) throw new Error("Repository not found.");

  // Infra first — after the row delete nothing could find the containers/databases again.
  // Best-effort per instance: a half-torn-down deployment must not leave the repository
  // undeletable.
  const envs = await store.environments.listByProject(project.id);
  const teardownResults = await Promise.all(
    envs.map(async (env) => {
      const deployments = await store.deployments.listByEnvironment(env.id);
      const deploymentResults = await Promise.all(
        deployments.map((dep) =>
          bestEffortTeardown(`deployment ${dep.id}`, async () => {
            if (deployTarget.destroy) await deployTarget.destroy(dep.id);
            else await deployTarget.stop(dep.id);
          }),
        ),
      );
      // Per-deployment destroy leaves the environment's shared Workflow world (sessions +
      // sandboxes) — drop it once all of the env's deployments are gone.
      const destroyWorld = deployTarget.destroyWorld;
      const worldResult = destroyWorld
        ? await bestEffortTeardown(`world ${env.id}`, () => destroyWorld(env.id))
        : "ok";
      return [...deploymentResults, worldResult];
    }),
  );
  const teardownIssues = teardownResults
    .flat()
    .filter((r) => r !== "ok").length;

  // Audit before the delete (the audit table is org-scoped and survives the cascade).
  await store.audit.record({
    orgId: project.orgId,
    actorUserId: input.createdBy ?? null,
    action: "repository.delete",
    target: project.name,
    meta: { projectId: project.id, environments: envs.length, teardownIssues },
  });
  await store.projects.deleteById(project.id);

  // The repo's Better Auth team (FOH D9) is not covered by the projects cascade — remove it
  // best-effort after the row delete. Lazy import keeps the Better Auth singleton out of this
  // module's graph for unit tests; deleteProjectTeam itself never throws.
  if (project.teamId) {
    const { deleteProjectTeam } = await import("~/auth/teams.server");
    await deleteProjectTeam(project.orgId, project.teamId);
  }
}
