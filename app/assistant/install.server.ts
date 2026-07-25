/**
 * Marketplace installation for the embedded assistant.
 *
 * The assistant edits its conversation checkout directly for ordinary authoring, but catalog
 * templates must go through harnesst: `planInstall` owns composition, lock provenance, dependency
 * merges, sandbox setup, and conflict detection, while the control plane owns secret storage.
 * This module is the token-authenticated counterpart to the install wizard's action and uses the
 * same planner, draft staging, and secret primitives.
 */
import type { Agent, DataStore } from "~/data/ports";
import { selectedCapabilityGroupIds } from "~/capabilities/enablement";
import { stageDeletions, stageDraft, listDrafts } from "~/drafts/drafts.server";
import { fetchAgentSource, readAgentFile } from "~/github/repo.server";
import {
  findAppCredentialConflict,
  listAppCredentialRows,
} from "~/github/app-manifest.server";
import {
  catalogLocator,
  packageJsonPathForRoot,
  planInstall,
  type InstallTarget,
} from "~/marketplace/install.server";
import { findInstall, overlayLock, selectedGroupIds } from "~/marketplace/lock";
import { resolveTemplate } from "~/marketplace/compose.server";
import {
  TEMPLATE_TYPES,
  isTemplateSlug,
  type TemplateType,
} from "~/marketplace/manifest";
import { ownsWorkspaceModelReference } from "~/models/union.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import {
  planInstallSecretOps,
  writePendingSecret,
  type InstallSecretOp,
} from "~/project/secrets.server";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import type { AuthoringProject } from "~/assistant/authoring.server";
import { getRuntime } from "~/seams/index.server";
import { listSharedSecrets, setAttachment } from "~/seams/oss/secret-store";
import { decodeKey, fingerprint, seal } from "~/seams/oss/secretbox";
import type { CatalogSource, SecretsProvider } from "~/seams/types";

interface SecretChangeSet {
  /** Secrets the human must still supply (excludes harnesst-handled ones). */
  required: string[];
  /**
   * Secrets harnesst sets or mints itself (manifest `provisioned`/`generated`) — never requested from
   * the user. Reported separately from `required` so the assistant doesn't ask for them.
   */
  provisioned: string[];
  set: string[];
  attached: string[];
  skipped: string[];
}

export interface AssistantInstallInput {
  type?: unknown;
  id?: unknown;
  /** Existing target member, or the new member name for an agent template. */
  member?: unknown;
  authSelections?: unknown;
  capabilitySelections?: unknown;
  /** Optional write-only secret values, keyed by manifest secret name. */
  secretValues?: unknown;
}

export type AssistantInstallResult =
  | {
      ok: true;
      id: string;
      type: TemplateType;
      member: string;
      isUpdate: boolean;
      writes: string[];
      deletions: string[];
      conflicts: [];
      warnings: string[];
      secrets: SecretChangeSet;
    }
  | {
      ok: false;
      error: string;
      conflicts?: string[];
      writes?: string[];
      deletions?: string[];
      warnings?: string[];
      secrets?: SecretChangeSet;
    };

interface InstallSecretContext {
  project: AuthoringProject;
  target: InstallTarget;
  agent: Agent | null;
  ops: InstallSecretOp[];
}

export interface AssistantInstallDeps {
  store: DataStore;
  catalog: CatalogSource;
  fetchSource: typeof fetchAgentSource;
  readFile: typeof readAgentFile;
  listDrafts: typeof listDrafts;
  stageWrite: typeof stageDraft;
  stageDeletes: typeof stageDeletions;
  sharedSecretNames(projectId: string): Promise<string[]>;
  workspaceModel(orgId: string): Promise<{
    model: string | null;
    effort: Awaited<
      ReturnType<typeof getWorkspaceAssistantSelection>
    >["effort"];
  }>;
  credentialConflict(
    projectId: string,
    agentId: string | null,
    ops: InstallSecretOp[],
  ): Promise<string | null>;
  applySecretOps(context: InstallSecretContext): Promise<void>;
}

async function activeWorkspaceDefaultModel(orgId: string) {
  const selection = await getWorkspaceAssistantSelection(orgId).catch(() => ({
    model: null,
    effort: null,
  }));
  return selection.model &&
    (await ownsWorkspaceModelReference(orgId, selection.model))
    ? selection
    : { model: null, effort: null };
}

function secretValue(ops: InstallSecretOp[], name: string): string | undefined {
  const op = ops.find(
    (candidate) => candidate.kind === "set" && candidate.name === name,
  );
  return op?.kind === "set" ? op.value : undefined;
}

async function defaultCredentialConflict(
  projectId: string,
  agentId: string | null,
  ops: InstallSecretOp[],
): Promise<string | null> {
  const slug = secretValue(ops, "GITHUB_APP_SLUG");
  const appId = secretValue(ops, "GITHUB_APP_ID");
  if (!slug && !appId) return null;
  const conflict = findAppCredentialConflict(
    await listAppCredentialRows(projectId),
    agentId,
    { slug, appId },
  );
  return conflict
    ? `Another agent in this project ("${conflict.agentName}") already uses this GitHub App (${conflict.key} matches). Every agent needs its own GitHub App.`
    : null;
}

async function defaultApplySecretOps(
  { project, target, agent, ops }: InstallSecretContext,
  secrets: SecretsProvider,
): Promise<void> {
  if (agent) {
    for (const op of ops) {
      if (op.kind === "set") {
        await secrets.set(
          {
            projectId: project.id,
            agentId: agent.id,
            environmentId: null,
            key: op.name,
          },
          op.value,
          { sandboxExposed: op.sandbox, updatedBy: null },
        );
      } else if (op.kind === "attach") {
        await setAttachment({
          projectId: project.id,
          agentId: agent.id,
          key: op.name,
          attached: true,
          sandboxExposed: op.sandbox,
          createdBy: null,
        });
      }
    }
    return;
  }

  if (target.kind !== "new-member") return;
  const actionable = ops.filter((op) => op.kind !== "skip");
  if (actionable.length === 0) return;
  const key = decodeKey(process.env.EDEN_SECRETS_KEY);
  for (const op of actionable) {
    if (op.kind === "set") {
      await writePendingSecret({
        projectId: project.id,
        memberName: target.name,
        key: op.name,
        sealed: seal(key, op.value),
        fingerprint: fingerprint(op.value),
        sandboxExposed: op.sandbox,
        attachShared: false,
        createdBy: null,
      });
    } else {
      await writePendingSecret({
        projectId: project.id,
        memberName: target.name,
        key: op.name,
        sealed: { ciphertext: "", iv: "", authTag: "" },
        fingerprint: null,
        sandboxExposed: op.sandbox,
        attachShared: true,
        createdBy: null,
      });
    }
  }
}

export function defaultAssistantInstallDeps(): AssistantInstallDeps {
  const runtime = getRuntime();
  return {
    store: runtime.data,
    catalog: runtime.catalog,
    fetchSource: fetchAgentSource,
    readFile: readAgentFile,
    listDrafts,
    stageWrite: stageDraft,
    stageDeletes: stageDeletions,
    sharedSecretNames: async (projectId) =>
      (await listSharedSecrets(projectId)).map((secret) => secret.key),
    workspaceModel: activeWorkspaceDefaultModel,
    credentialConflict: defaultCredentialConflict,
    applySecretOps: (context) =>
      defaultApplySecretOps(context, runtime.secrets),
  };
}

function stringArrayRecord(value: unknown): Record<string, string[]> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !Array.isArray(entry) ||
      entry.some((item) => typeof item !== "string")
    ) {
      return null;
    }
    result[key] = entry;
  }
  return result;
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function planAssistantSecretOps(
  secrets: NonNullable<
    Awaited<ReturnType<typeof resolveTemplate>>["manifest"]["secrets"]
  >,
  values: Record<string, string>,
  sharedNames: string[],
): InstallSecretOp[] {
  const form = new FormData();
  const shared = new Set(sharedNames);
  for (const secret of secrets) {
    if (Object.hasOwn(values, secret.name)) {
      form.set(`secretmode:${secret.name}`, "value");
      form.set(`secret:${secret.name}`, values[secret.name]);
    } else if (shared.has(secret.name)) {
      form.set(`secretmode:${secret.name}`, "shared");
    } else {
      form.set(`secretmode:${secret.name}`, "skip");
    }
  }
  return planInstallSecretOps({ secrets, form, sharedNames });
}

/** Plan and stage one catalog install for the assistant's token-scoped project. */
export async function installMarketplaceTemplate(
  project: AuthoringProject,
  input: AssistantInstallInput,
  deps: AssistantInstallDeps = defaultAssistantInstallDeps(),
): Promise<AssistantInstallResult> {
  const type = typeof input.type === "string" ? input.type : "";
  if (!TEMPLATE_TYPES.includes(type as TemplateType)) {
    return {
      ok: false,
      error: "Install needs a valid marketplace template type.",
    };
  }
  const templateType = type as TemplateType;
  const id = typeof input.id === "string" ? input.id : "";
  if (!isTemplateSlug(id)) {
    return {
      ok: false,
      error: "Install needs a valid marketplace template id.",
    };
  }
  const member = typeof input.member === "string" ? input.member.trim() : "";
  if (!member) return { ok: false, error: "Install needs a target member." };

  const authSelections = stringArrayRecord(input.authSelections);
  const capabilitySelections = stringArrayRecord(input.capabilitySelections);
  const secretValues = stringRecord(input.secretValues);
  if (!authSelections || !capabilitySelections || !secretValues) {
    return {
      ok: false,
      error:
        "Selections must map providers to string arrays, and secretValues must map names to strings.",
    };
  }

  try {
    const repo = { owner: project.repoOwner, repo: project.repoName };
    const [template, source, drafts, workspaceModel] = await Promise.all([
      resolveTemplate(deps.catalog, templateType, id),
      deps.fetchSource(project.repoInstallationId, repo),
      deps.listDrafts(project.id, deps.store),
      templateType === "agent"
        ? deps.workspaceModel(project.orgId)
        : Promise.resolve({ model: null, effort: null }),
    ]);
    const context = await resolveSyncedAgentContext(
      project.id,
      null,
      source.paths,
      deps.store,
    );
    const draftPaths = drafts.map((draft) => ({
      path: draft.path,
      content: draft.content,
    }));
    const lock = overlayLock(
      source.files["eden-lock.json"] ?? null,
      draftPaths,
    );

    let target: InstallTarget;
    let secretAgent: Agent | null = null;
    if (templateType === "agent") {
      if (!context.isTeam) {
        return {
          ok: false,
          error:
            "Agent templates install as a new member, but this is a single-agent repo.",
        };
      }
      if (!workspaceModel.model) {
        return {
          ok: false,
          error:
            "Choose a connected workspace default model before installing an agent template.",
        };
      }
      target = { kind: "new-member", name: member };
    } else {
      secretAgent =
        context.roster.find((agent) => agent.name === member) ?? null;
      if (!secretAgent) {
        return {
          ok: false,
          error: `No project member named "${member}" exists.`,
        };
      }
      target = {
        kind: "member",
        memberName: context.isTeam ? secretAgent.name : null,
        root: secretAgent.root,
      };
    }

    // Match the wizard's update semantics: omitted selections retain the lock snapshot instead
    // of silently reverting to newly published template defaults.
    const installMember =
      target.kind === "new-member" ? target.name : target.memberName;
    const existingInstall = findInstall(
      lock,
      template.manifest.id,
      installMember,
    );
    for (const auth of template.auths) {
      const stored = existingInstall?.auth?.find(
        (entry) => entry.provider === auth.provider,
      );
      if (
        auth.scopeGroups?.length &&
        !(auth.provider in authSelections) &&
        stored?.scopeGroups
      ) {
        authSelections[auth.provider] = selectedGroupIds(stored);
      }
      if (
        auth.capabilityGroups?.length &&
        !(auth.provider in capabilitySelections) &&
        stored?.capabilityGroups
      ) {
        capabilitySelections[auth.provider] =
          selectedCapabilityGroupIds(stored);
      }
    }

    let packageJson: string | null = null;
    if (target.kind === "member") {
      const packagePath = packageJsonPathForRoot(target.root);
      const draft = drafts.find((candidate) => candidate.path === packagePath);
      packageJson =
        draft !== undefined
          ? draft.content
          : await deps.readFile(project.repoInstallationId, repo, packagePath);
    }

    const plan = planInstall({
      template,
      registry: catalogLocator(),
      repoPaths: source.paths,
      drafts: draftPaths,
      packageJson,
      lock,
      rosterNames: context.roster.map((agent) => agent.name),
      model: workspaceModel.model,
      effort: workspaceModel.effort,
      target,
      authSelections,
      capabilitySelections,
    });
    // Issue #47/#163: provisioned secrets are set by a guided harnesst flow and generated ones are
    // minted by harnesst at first deploy — the user never supplies either, so they are reported apart
    // from `required` (the wizard filters them out of its user-facing list the same way).
    const requiredSecrets = plan.secrets
      .filter((secret) => !secret.provisioned && !secret.generated)
      .map((secret) => secret.name);
    const provisionedSecrets = plan.secrets
      .filter((secret) => secret.provisioned || secret.generated)
      .map((secret) => secret.name);
    const changeSet = {
      writes: plan.writes.map((write) => write.path),
      deletions: plan.deletions,
      warnings: plan.warnings,
      secrets: {
        required: requiredSecrets,
        provisioned: provisionedSecrets,
        set: [],
        attached: [],
        skipped: [],
      },
    };
    if (plan.conflicts.length > 0) {
      return {
        ok: false,
        error: `Can't install because ${plan.conflicts.length} conflict(s) block this install.`,
        conflicts: plan.conflicts,
        ...changeSet,
      };
    }

    const sharedNames =
      (template.manifest.secrets?.length ?? 0) > 0
        ? await deps.sharedSecretNames(project.id).catch(() => [])
        : [];
    const secretOps = planAssistantSecretOps(
      template.manifest.secrets ?? [],
      secretValues,
      sharedNames,
    );
    const credentialError = await deps.credentialConflict(
      project.id,
      secretAgent?.id ?? null,
      secretOps,
    );
    if (credentialError)
      return { ok: false, error: credentialError, ...changeSet };

    for (const write of plan.writes) {
      await deps.stageWrite(
        {
          projectId: project.id,
          path: write.path,
          content: write.content,
          createdBy: null,
        },
        deps.store,
      );
    }
    if (plan.deletions.length > 0) {
      await deps.stageDeletes(
        { projectId: project.id, paths: plan.deletions, createdBy: null },
        deps.store,
      );
    }
    await deps.applySecretOps({
      project,
      target,
      agent: secretAgent,
      ops: secretOps,
    });

    return {
      ok: true,
      id,
      type: templateType,
      member,
      isUpdate: plan.isUpdate,
      conflicts: [],
      ...changeSet,
      secrets: {
        required: requiredSecrets,
        provisioned: provisionedSecrets,
        set: secretOps.filter((op) => op.kind === "set").map((op) => op.name),
        attached: secretOps
          .filter((op) => op.kind === "attach")
          .map((op) => op.name),
        // Provisioned/generated secrets also plan as `skip` ops; they are reported under
        // `provisioned`, so keep them out of `skipped` to avoid listing them twice.
        skipped: secretOps
          .filter(
            (op) => op.kind === "skip" && !provisionedSecrets.includes(op.name),
          )
          .map((op) => op.name),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
