/**
 * Model staging for Settings' "Model" section. Two module generations exist:
 *
 *  - **Workspace-resolver modules** (`model: harnesstAgentModel('<name>')` from the generated
 *    `harnesst/model.ts`): the file carries no model at all — it resolves the org's configured
 *    model at runtime. A model save writes the org's per-target override map (harnesst DB) and
 *    touches NOTHING in the repo: no drafts, no publish, no redeploy.
 *  - **Legacy dynamic-wrapper modules**: rewrite the member's `agent.ts` through `setModel`
 *    (the chosen model becomes the `defineDynamic` fallback, so the agent honors the
 *    playground's per-conversation directive) and keep its `package.json` provider/eve
 *    dependencies compatible — both saved as drafts the header Publish control takes live.
 *
 * The target may be a DECLARED SUBAGENT (issue #344), which changes three things and nothing
 * else: the override row is keyed by the member's resolver name plus the subagent's path, the
 * dependency merge still targets the MEMBER's `package.json` (a subagent has none of its own),
 * and "this equals what I inherit, so drop the row" compares against the PARENT's effective
 * selection rather than the workspace default. A subagent module that still makes the pre-#344
 * one-argument call is upgraded to name its own target (staged as a draft) so the runtime asks
 * for the right thing after the next publish; one with no `agent.ts` at all gets a scaffold.
 */
import type { DataStore } from "~/data/ports";
import {
  resolveFileView,
  stageDraft,
  type FileViewDeps,
} from "~/drafts/drafts.server";
import {
  ensureModelProviderDependencies,
  orgResolverAgentName,
  orgResolverTarget,
  scaffoldAgentModule,
  setModel,
  setOrgResolverSubagentPath,
  usesOrgModelResolver,
} from "~/eve/agentModule";
import { scaffoldOrgModelAgentModule } from "~/eve/org-model-module";
import type { ReasoningEffort } from "~/models/reasoning";
import { packageJsonPathForRoot } from "~/marketplace/install.server";
import {
  inheritanceChain,
  removeAgentModelOverride,
  resolveTargetModel,
  setAgentModelOverride,
} from "~/models/agent-model-config.server";
import { findWorkspaceModel } from "~/models/union.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import { getRuntime } from "~/seams/index.server";

export interface StageModelInput {
  project: {
    id: string;
    orgId: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  };
  /** The TARGET's agent root — the member's, or a declared subagent's directory below it. */
  root: string;
  /**
   * The member root that actually deploys (issue #344): identical to `root` for an agent target,
   * the member root for a subagent target. Dependencies and `package.json` live here — a
   * subagent directory has neither. Defaults to `root`.
   */
  deploymentRoot?: string;
  /** `/`-joined declared-subagent segments below `deploymentRoot`; `""` (default) is the agent. */
  subagentPath?: string;
  /** The member's roster name — the resolver-name fallback when its module is legacy. */
  memberName?: string;
  /** Connected, provider/connection-qualified model ref to use as the fallback. */
  model: string;
  /** Explicit normalized effort; null delegates to the selected provider's default. */
  effort?: ReasoningEffort | null;
  /** Context window to keep when the catalog lookup misses (else `setModel`'s default). */
  fallbackContextWindowTokens?: number | null;
  createdBy: string | null;
}

export type StageModelResult =
  /** "applied": written to org config, live on the agent's next step. "staged": drafted for publish. */
  | {
      ok: true;
      mode: "staged" | "applied";
      /**
       * An "applied" save that ALSO staged the subagent's `agent.ts` (upgrading its pre-#344
       * one-argument resolver call, or scaffolding a missing module): the row is live for
       * new-protocol deployments, but the running one keeps asking for the parent's target
       * until this draft publishes.
       */
      upgraded?: boolean;
    }
  | { ok: false; error: string };

/** GitHub reads + the model-catalog lookup + the override writer, injected for zero-I/O tests. */
export interface StageModelDeps extends FileViewDeps {
  lookupModel: typeof findWorkspaceModel;
  getWorkspaceSelection?: typeof getWorkspaceAssistantSelection;
  /** Injected in tests; defaults to the real org override map. */
  setOverride?: typeof setAgentModelOverride;
  removeOverride?: typeof removeAgentModelOverride;
  /** Injected in tests; resolves what a subagent target would inherit from its parent. */
  resolveTarget?: typeof resolveTargetModel;
}

/**
 * Apply the model change for one target. A workspace-resolver module records the choice in the
 * org's per-target override map (the running agent picks it up on its next step). A legacy module
 * stages `agent.ts` (dynamic wrapper, `model` as the fallback) plus `package.json` when its
 * dependencies need the OpenRouter provider / eve bump. Re-running with the same model is
 * idempotent on both paths.
 */
export async function stageModelChange(
  input: StageModelInput,
  store: DataStore = getRuntime().data,
  deps?: StageModelDeps,
): Promise<StageModelResult> {
  const modelInfo = await (deps?.lookupModel ?? findWorkspaceModel)(
    input.project.orgId,
    input.model,
  );
  if (!modelInfo) {
    return {
      ok: false,
      error:
        "That model is not available from an active provider connection in this workspace.",
    };
  }
  if (input.effort && !modelInfo.supportedEfforts?.includes(input.effort)) {
    return {
      ok: false,
      error: "That reasoning effort is not supported by the selected model.",
    };
  }
  const contextWindowTokens =
    modelInfo.contextWindow ?? input.fallbackContextWindowTokens;
  const deploymentRoot = input.deploymentRoot ?? input.root;
  const subagentPath = input.subagentPath ?? "";
  const path = `${input.root}/agent.ts`;
  const view = await resolveFileView(input.project, path, store, deps);
  // A subagent's resolver identity is its MEMBER's: the row is keyed by the name the member
  // module resolves itself by (falling back to the roster name when that module is legacy), plus
  // the subagent's path.
  const memberView =
    subagentPath === ""
      ? view
      : await resolveFileView(
          input.project,
          `${deploymentRoot}/agent.ts`,
          store,
          deps,
        );
  const resolverName =
    (memberView.content ? orgResolverAgentName(memberView.content) : null) ??
    (subagentPath === "" ? null : (input.memberName ?? null));

  // A subagent that carries its OWN baked model is a legacy module like any other: rewriting it
  // through `setModel` is what actually changes the model it runs, so it takes the legacy path.
  const legacySubagentModule =
    subagentPath !== "" &&
    view.content !== null &&
    !usesOrgModelResolver(view.content);
  // A missing subagent module can only be scaffolded onto the generated `harnesst/model.ts` when
  // the member actually resolves through it; under a legacy member there is no module to import.
  const resolverBacked =
    (view.content !== null && usesOrgModelResolver(view.content)) ||
    (subagentPath !== "" && usesOrgModelResolver(memberView.content));

  // Workspace-resolver module: the model choice is org configuration, not repo content. Write
  // the override keyed by the target the module resolves itself by.
  if (resolverName && resolverBacked && !legacySubagentModule) {
    const selection = {
      model: input.model,
      effort: input.effort ?? null,
    };
    // What this target inherits with no row of its own: the PARENT's effective selection for a
    // subagent, the workspace default for the agent itself. Choosing exactly that is
    // inheritance, not an explicit pin — a redundant row would freeze the target on today's
    // value when the thing it inherits from changes later.
    const parentPath = inheritanceChain(subagentPath)[1] ?? null;
    const inherited =
      parentPath === null
        ? await (deps?.getWorkspaceSelection ?? getWorkspaceAssistantSelection)(
            input.project.orgId,
          )
        : ((await (deps?.resolveTarget ?? resolveTargetModel)(
            input.project.orgId,
            {
              agentName: resolverName,
              subagentPath: parentPath,
              projectId: input.project.id,
            },
          )) ?? { model: null, effort: null });
    const key = {
      agentName: resolverName,
      subagentPath,
      projectId: input.project.id,
    };
    if (
      inherited.model === selection.model &&
      inherited.effort === selection.effort
    ) {
      await (deps?.removeOverride ?? removeAgentModelOverride)(
        input.project.orgId,
        key,
      );
    } else {
      await (deps?.setOverride ?? setAgentModelOverride)(
        input.project.orgId,
        key,
        selection,
      );
    }
    if (subagentPath === "") return { ok: true, mode: "applied" };
    // The row is live for any deployment speaking the two-argument protocol. A subagent whose
    // module still makes the pre-#344 call (or has no module at all) would keep asking for the
    // PARENT's target, so stage the upgrade — it reaches the running agent on the next publish.
    const upgraded =
      view.content === null
        ? scaffoldOrgModelAgentModule(resolverName, { subagentPath })
        : usesOrgModelResolver(view.content) &&
            orgResolverTarget(view.content)?.subagentPath !== subagentPath
          ? setOrgResolverSubagentPath(view.content, subagentPath)
          : null;
    if (upgraded !== null && upgraded !== view.content) {
      await stageDraft(
        {
          projectId: input.project.id,
          path,
          content: upgraded,
          createdBy: input.createdBy,
        },
        store,
      );
      return { ok: true, mode: "applied", upgraded: true };
    }
    return { ok: true, mode: "applied" };
  }
  if (view.content && usesOrgModelResolver(view.content) && !resolverName) {
    return {
      ok: false,
      error:
        "This agent resolves its model from the workspace configuration, but its " +
        "harnesstAgentModel(...) call has no readable agent name — fix agent.ts first.",
    };
  }

  const next = view.content
    ? setModel(view.content, input.model, {
        contextWindowTokens,
        effort: input.effort,
      })
    : scaffoldAgentModule(input.model, {
        contextWindowTokens,
        effort: input.effort,
      });

  // The MEMBER's package.json — a declared subagent directory has none of its own, and its
  // dependencies ship with the member that deploys it.
  const pkgPath = packageJsonPathForRoot(deploymentRoot);
  const pkgView = await resolveFileView(input.project, pkgPath, store, deps);
  let packageJson: string;
  try {
    packageJson = ensureModelProviderDependencies(pkgView.content);
  } catch {
    return {
      ok: false,
      error: `${pkgPath} is not valid JSON — fix it before setting the model.`,
    };
  }

  await Promise.all([
    stageDraft(
      {
        projectId: input.project.id,
        path,
        content: next,
        createdBy: input.createdBy,
      },
      store,
    ),
    packageJson !== pkgView.content
      ? stageDraft(
          {
            projectId: input.project.id,
            path: pkgPath,
            content: packageJson,
            createdBy: input.createdBy,
          },
          store,
        )
      : Promise.resolve(),
  ]);
  return { ok: true, mode: "staged" };
}
