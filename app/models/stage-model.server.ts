/**
 * Model staging for Settings' "Model" section. Two module generations exist:
 *
 *  - **Workspace-resolver modules** (`model: harnesstAgentModel('<name>')` from the generated
 *    `harnesst-model.ts`): the file carries no model at all — it resolves the org's configured
 *    model at runtime. A model save writes the org's per-agent override map (harnesst DB) and
 *    touches NOTHING in the repo: no drafts, no publish, no redeploy.
 *  - **Legacy dynamic-wrapper modules**: rewrite the member's `agent.ts` through `setModel`
 *    (the chosen model becomes the `defineDynamic` fallback, so the agent honors the
 *    playground's per-conversation directive) and keep its `package.json` provider/eve
 *    dependencies compatible — both saved as drafts the header Publish control takes live.
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
  scaffoldAgentModule,
  setModel,
  usesOrgModelResolver,
} from "~/eve/agentModule";
import type { ReasoningEffort } from "~/models/reasoning";
import { packageJsonPathForRoot } from "~/marketplace/install.server";
import { setAgentModelOverride } from "~/models/agent-model-config.server";
import { findWorkspaceModel } from "~/models/union.server";
import { getRuntime } from "~/seams/index.server";

export interface StageModelInput {
  project: {
    id: string;
    orgId: string;
    repoInstallationId: string;
    repoOwner: string;
    repoName: string;
  };
  /** The member's agent root, e.g. "agent" or "agents/planner/agent". */
  root: string;
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
  | { ok: true; mode: "staged" | "applied" }
  | { ok: false; error: string };

/** GitHub reads + the model-catalog lookup + the override writer, injected for zero-I/O tests. */
export interface StageModelDeps extends FileViewDeps {
  lookupModel: typeof findWorkspaceModel;
  /** Injected in tests; defaults to the real org override map. */
  setOverride?: typeof setAgentModelOverride;
}

/**
 * Apply the model change for one member. A workspace-resolver module records the choice in the
 * org's per-agent override map (the running agent picks it up on its next step). A legacy module
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
  const path = `${input.root}/agent.ts`;
  const view = await resolveFileView(input.project, path, store, deps);

  // Workspace-resolver module: the model choice is org configuration, not repo content. Write
  // the override keyed by the name the module resolves itself (and its subagents) by.
  if (view.content && usesOrgModelResolver(view.content)) {
    const agentName = orgResolverAgentName(view.content);
    if (!agentName) {
      return {
        ok: false,
        error:
          "This agent resolves its model from the workspace configuration, but its " +
          "harnesstAgentModel(...) call has no readable agent name — fix agent.ts first.",
      };
    }
    await (deps?.setOverride ?? setAgentModelOverride)(
      input.project.orgId,
      agentName,
      { model: input.model, effort: input.effort ?? null },
    );
    return { ok: true, mode: "applied" };
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

  const pkgPath = packageJsonPathForRoot(input.root);
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
