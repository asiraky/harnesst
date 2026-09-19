/** Explicit opt-in to live workspace/parent inheritance. No migration runs on reads. */
import type { DataStore } from "~/data/ports";
import { agentForPath } from "~/db/queries.server";
import {
  ensureModelProviderDependencies,
  orgResolverAgentName,
  usesOrgModelResolver,
} from "~/eve/agentModule";
import {
  orgModelModulePath,
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import { subagentRootFor } from "~/eve/parse";
import { resetAgentModelSource } from "~/eve/reset-model";
import { readModelResetFile } from "~/github/read-model-reset-file.server";
import { ensureWorkerStarted } from "~/jobs/worker.server";
import { packageJsonPathForRoot } from "~/marketplace/install.server";
import {
  removeAgentModelOverrides,
  type ModelTargetKey,
} from "~/models/agent-model-config.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { startPublish } from "~/publish/pipeline.server";
import { draftSnapshotFingerprint } from "~/publish/draft-snapshot";
import { getRuntime } from "~/seams/index.server";
import type { StageModelInput } from "~/models/stage-model.server";

export interface ModelResetTarget {
  root: string;
  deploymentRoot: string;
  memberName: string;
  subagentPath?: string;
}

export interface ResetModelsInput {
  project: StageModelInput["project"] & { liveEnvironmentName?: string | null };
  /** Server-resolved scope. A member reset contains only that member, a team reset all declared targets. */
  targets: ModelResetTarget[];
  createdBy: string | null;
  originUrl: string;
}

export type ResetModelsResult =
  | { ok: true; mode: "applied"; cacheSeconds: 30 }
  | { ok: true; mode: "publishing"; taskId: string; cacheSeconds: 30 }
  | { ok: false; error: string };

export interface ResetModelsDeps {
  readFile: typeof readModelResetFile;
  getWorkspaceSelection: typeof getWorkspaceAssistantSelection;
  removeOverrides: typeof removeAgentModelOverrides;
  publish: typeof startPublish;
  startWorker: typeof ensureWorkerStarted;
}

/**
 * Plan against the committed files, validate every target, then mutate. Existing drafts are
 * accepted only when they exactly match this reset's plan (a retry); an unrelated change must
 * never hitch a ride on the automatic publish. Deployment work uses the normal publish task,
 * whose presentation waits for the actual deployment rows, not merely the source commit.
 */
export async function resetModelsToWorkspaceDefault(
  input: ResetModelsInput,
  store: DataStore = getRuntime().data,
  overrides: Partial<ResetModelsDeps> = {},
): Promise<ResetModelsResult> {
  const deps: ResetModelsDeps = {
    readFile: readModelResetFile,
    getWorkspaceSelection: getWorkspaceAssistantSelection,
    removeOverrides: removeAgentModelOverrides,
    publish: startPublish,
    startWorker: ensureWorkerStarted,
    ...overrides,
  };
  let resetChangesStaged = false;
  try {
    const workspace = await deps.getWorkspaceSelection(input.project.orgId);
    if (!workspace.model) {
      return {
        ok: false,
        error:
          "Configure a workspace default model in workspace Connections settings before resetting agents.",
      };
    }
    if (!input.targets.length)
      return { ok: false, error: "There are no agents to reset." };
    const running = await store.workspaceTasks.findRunningBySubject(
      input.project.id,
      "publish",
    );
    if (running)
      return {
        ok: false,
        error:
          "A publish is already running. Wait for it to finish, then reset again.",
      };

    const repo = {
      owner: input.project.repoOwner,
      repo: input.project.repoName,
    };
    const cache = new Map<string, string | null>();
    const read = async (path: string, ref?: string) => {
      const key = `${ref ?? "HEAD"}:${path}`;
      if (!cache.has(key))
        cache.set(
          key,
          await deps.readFile(
            input.project.repoInstallationId,
            { ...repo, ref },
            path,
          ),
        );
      return cache.get(key)!;
    };
    const resetRoots = new Set(input.targets.map((target) => target.root));
    for (const target of input.targets) {
      const segments = (target.subagentPath ?? "").split("/").filter(Boolean);
      for (let depth = 0; depth < segments.length; depth++) {
        const ancestor = subagentRootFor(
          target.deploymentRoot,
          segments.slice(0, depth),
        );
        if (resetRoots.has(ancestor)) continue;
        const source = await read(`${ancestor}/agent.ts`);
        if (source !== null && !usesOrgModelResolver(source)) {
          const label = [target.memberName, ...segments.slice(0, depth)].join(
            " / ",
          );
          return {
            ok: false,
            error: `Reset ${label} first, or use the team reset. This parent still selects its model in code, so this subagent cannot inherit its selection through workspace configuration yet.`,
          };
        }
      }
    }
    const planned = new Map<string, string>();
    const changes = new Map<string, string>();
    const keys: ModelTargetKey[] = [];
    const roots = new Set<string>();
    const agents = await store.agents.listByProject(input.project.id);
    const environments = await store.environments.listByProject(
      input.project.id,
    );
    for (const target of input.targets) {
      const member = await read(`${target.deploymentRoot}/agent.ts`);
      const name =
        (member && orgResolverAgentName(member)) || target.memberName;
      const path = `${target.root}/agent.ts`;
      const before = await read(path);
      const subagentPath = target.subagentPath ?? "";
      let after: string;
      try {
        // A reset changes model selection only. In particular, adding a description to an
        // instruction-only subagent would change the delegation metadata eve derives for it.
        after =
          before === null
            ? scaffoldOrgModelAgentModule(name, { subagentPath })
            : resetAgentModelSource(before, name, subagentPath);
      } catch (error) {
        const label = [
          target.memberName,
          ...subagentPath.split("/").filter(Boolean),
        ].join(" / ");
        return {
          ok: false,
          error: `Cannot reset ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      planned.set(path, after);
      if (after !== before) changes.set(path, after);
      roots.add(target.deploymentRoot);
      keys.push({ projectId: input.project.id, agentName: name, subagentPath });

      // A prior publish may have committed successfully but failed to replace a legacy runtime.
      // Inspect the serving releases too; retry must rebuild them instead of declaring completion.
      const agent = agents.find(
        (a) => a.root === target.deploymentRoot && a.kind === "member",
      );
      if (agent) {
        const memberEnvironments = environments.filter(
          (env) => env.agentId === agent.id,
        );
        const configuredEnvironmentExists = memberEnvironments.some(
          (env) => env.name === input.project.liveEnvironmentName,
        );
        const inspectedEnvironments = configuredEnvironmentExists
          ? memberEnvironments.filter(
              (env) => env.name === input.project.liveEnvironmentName,
            )
          : memberEnvironments;
        for (const env of inspectedEnvironments) {
          const deployments = await store.deployments.listByEnvironment(env.id);
          if (
            deployments.some(
              (d) => d.status === "pending" || d.status === "building",
            )
          ) {
            return {
              ok: false,
              error:
                "An agent deployment is still starting. Wait for it to finish, then reset again.",
            };
          }
          for (const deployment of deployments.filter(
            (d) => d.status === "live" && d.trafficWeight > 0,
          )) {
            try {
              const live = await read(path, deployment.gitSha);
              if (
                live === null ||
                resetAgentModelSource(live, name, subagentPath) !== live
              )
                changes.set(path, after);
            } catch {
              // HEAD already passed conversion validation. An unavailable historical revision
              // or custom legacy runtime means redeploy HEAD, not reject that valid repair.
              changes.set(path, after);
            }
          }
        }
      }
    }
    for (const root of roots) {
      const modulePath = orgModelModulePath(root);
      const module = orgModelModuleSource();
      const currentModule = await read(modulePath);
      planned.set(modulePath, module);
      if (currentModule !== module) changes.set(modulePath, module);
      const packagePath = packageJsonPathForRoot(root);
      const currentPackage = await read(packagePath);
      let nextPackage: string;
      try {
        nextPackage = ensureModelProviderDependencies(currentPackage);
      } catch {
        return {
          ok: false,
          error: `${packagePath} is not valid JSON. Fix it before resetting models.`,
        };
      }
      planned.set(packagePath, nextPackage);
      if (nextPackage !== currentPackage) changes.set(packagePath, nextPackage);
    }
    const drafts = await store.drafts.listByProject(input.project.id);
    if (drafts.some((draft) => planned.get(draft.path) !== draft.content)) {
      return {
        ok: false,
        error:
          "Publish or discard existing saved changes before resetting models. Reset automatically publishes its own changes.",
      };
    }
    // Identical drafts from a failed reset remain publishable even when GitHub already has some
    // of the files. No second invocation can report applied while these drafts await deployment.
    for (const draft of drafts) changes.set(draft.path, draft.content!);
    const stagedSnapshot = await store.drafts.compareAndStage(
      input.project.id,
      drafts,
      [...changes].map(([path, content]) => ({
        projectId: input.project.id,
        agentId: agentForPath(agents, path)?.id ?? null,
        path,
        content,
        createdBy: input.createdBy,
      })),
    );
    if (stagedSnapshot === null) {
      return {
        ok: false,
        error:
          "Saved changes changed while preparing the reset. Review them, then retry; no reset changes were staged.",
      };
    }
    resetChangesStaged = changes.size > 0;
    await deps.removeOverrides(input.project.orgId, keys);
    if (!changes.size) return { ok: true, mode: "applied", cacheSeconds: 30 };
    deps.startWorker();
    const task = await deps.publish(
      {
        projectId: input.project.id,
        originUrl: input.originUrl,
        createdBy: input.createdBy,
        envName: input.project.liveEnvironmentName,
        resetDraftFingerprint: draftSnapshotFingerprint(stagedSnapshot),
      },
      store,
    );
    return {
      ok: true,
      mode: "publishing",
      taskId: task.taskId,
      cacheSeconds: 30,
    };
  } catch (error) {
    return {
      ok: false,
      error: resetChangesStaged
        ? `Reset did not finish: ${error instanceof Error ? error.message : String(error)}. Any saved reset changes are retained; retry the reset or open publish progress.`
        : `Reset could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
