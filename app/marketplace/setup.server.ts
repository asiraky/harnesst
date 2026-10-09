/**
 * Reads everything the setup wizard needs for one repo into a `SetupInput` (setup-plan.ts) and
 * writes the wizard's secret answers. All state is the real state: the effective lock, the
 * secrets store (or the pending store for members not yet published), the agent's GitHub App and
 * its installations, OAuth grants, and ledger provisioning. Nothing here is wizard-only storage.
 */
import { listGrantsForAgent } from "~/connections/grants.server";
import { invalidateAgentEnvironments } from "~/deploy/env-reconcile.server";
import { listDrafts } from "~/drafts/drafts.server";
import {
  activeAgentGitHubApp,
  agentGitHubAppSettingsUrl,
} from "~/github/agent-apps.server";
import {
  appPermissionsFor,
  listAppInstallations,
  missingAppPermissions,
} from "~/github/app-manifest.server";
import { getAgentSource } from "~/github/cached.server";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import {
  agentRequiredSecretState,
  computeRequiredSecrets,
  handleSecretIntent,
  lockSecretsForMember,
  writePendingSecret,
} from "~/project/secrets.server";
import { getRuntime } from "~/seams/index.server";
import {
  listPendingSecrets,
  listSharedSecrets,
} from "~/seams/oss/secret-store";
import { decodeKey, fingerprint, seal } from "~/seams/oss/secretbox";
import { ledgerAuthorization } from "./ledger-authorization.server";
import {
  githubPermissionsForMember,
  overlayLock,
  requiredScopesByProvider,
  type HarnesstLock,
} from "./lock";
import { getProvisioning } from "./provisioning.server";
import {
  planSetup,
  type SetupInput,
  type SetupMemberState,
  type SetupPlan,
} from "./setup-plan";

type SetupGitHubInstallations = NonNullable<
  NonNullable<SetupMemberState["github"]>["app"]
>["installations"];

interface SetupProject {
  id: string;
  repoInstallationId: Parameters<typeof getAgentSource>[0];
  repoOwner: string;
  repoName: string;
}

export interface SetupMemberRef {
  name: string;
  /** The lock's `member` value: the name in a team repo, null for a single-agent root. */
  lockMember: string | null;
  agentId: string | null;
}

export interface SetupContext {
  isTeam: boolean;
  lock: HarnesstLock;
  members: SetupMemberRef[];
  input: SetupInput;
  plan: SetupPlan;
}

/** Members in scope: published roster ∪ lock members not yet published. */
function memberRefs(
  isTeam: boolean,
  roster: Array<{ id: string; name: string }>,
  lock: HarnesstLock,
): SetupMemberRef[] {
  if (!isTeam) {
    const root = roster[0];
    return root
      ? [{ name: root.name, lockMember: null, agentId: root.id }]
      : [];
  }
  const byName = new Map<string, SetupMemberRef>();
  for (const a of roster)
    byName.set(a.name, { name: a.name, lockMember: a.name, agentId: a.id });
  for (const e of lock.installs)
    if (e.member && !byName.has(e.member))
      byName.set(e.member, {
        name: e.member,
        lockMember: e.member,
        agentId: null,
      });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function missingSecretsFor(
  projectId: string,
  ref: SetupMemberRef,
  isTeam: boolean,
  lock: HarnesstLock,
) {
  if (ref.agentId) {
    const state = await agentRequiredSecretState({
      projectId,
      agentId: ref.agentId,
      memberName: ref.name,
      isTeam,
      lock,
    });
    return state.missing;
  }
  const pending = await listPendingSecrets(projectId, ref.name);
  return computeRequiredSecrets({
    lockSecrets: lockSecretsForMember(lock, ref.name, isTeam),
    setNames: pending.filter((p) => !p.attachShared).map((p) => p.key),
    attachedNames: pending.filter((p) => p.attachShared).map((p) => p.key),
    dismissedNames: [],
  }).missing;
}

/** Whether any install on this member ships the GitHub channel (it carries the App secrets). */
function needsGitHubApp(
  lock: HarnesstLock,
  ref: SetupMemberRef,
  isTeam: boolean,
) {
  return lockSecretsForMember(lock, ref.lockMember ?? ref.name, isTeam).some(
    (e) => e.secrets.some((s) => s.name === "GITHUB_APP_ID"),
  );
}

async function githubStateFor(
  projectId: string,
  ref: SetupMemberRef,
  lock: HarnesstLock,
): Promise<SetupMemberState["github"]> {
  const required = appPermissionsFor(
    githubPermissionsForMember(lock, ref.lockMember),
  );
  if (!ref.agentId) return { required, app: null };
  const secrets = getRuntime().secrets;
  const get = (key: string) =>
    secrets.get({ projectId, agentId: ref.agentId, environmentId: null, key });
  const [slug, appId, privateKey, row] = await Promise.all([
    get("GITHUB_APP_SLUG"),
    get("GITHUB_APP_ID"),
    get("GITHUB_APP_PRIVATE_KEY"),
    activeAgentGitHubApp(projectId, ref.agentId).catch(() => null),
  ]);
  if (!slug || !appId || !privateKey) return { required, app: null };
  const settingsUrl = agentGitHubAppSettingsUrl({
    slug,
    ownerLogin: row?.ownerLogin ?? null,
    ownerType: row?.ownerType ?? null,
  });
  let installations: SetupGitHubInstallations = null;
  try {
    installations = (await listAppInstallations({ appId, privateKey })).map(
      (i) => ({
        account: i.account,
        htmlUrl: i.htmlUrl,
        repositorySelection: i.repositorySelection,
        missing: missingAppPermissions(required, i.permissions),
      }),
    );
  } catch {
    installations = null;
  }
  return { required, app: { slug, settingsUrl, installations } };
}

async function connectionsFor(ref: SetupMemberRef, lock: HarnesstLock) {
  // An empty scope list means every permission group was deselected: not required.
  const providers = [...requiredScopesByProvider(lock, ref.lockMember)]
    .filter(([, scopes]) => scopes.length > 0)
    .map(([provider]) => provider);
  if (providers.length === 0) return [];
  const grants = ref.agentId ? await listGrantsForAgent(ref.agentId) : [];
  return providers.map((provider) => ({
    provider,
    connected: grants.some(
      (g) => g.provider === provider && g.status === "active",
    ),
  }));
}

async function ledgerState(projectId: string): Promise<SetupInput["ledger"]> {
  const row = await getProvisioning(projectId);
  if (!row) return null;
  let mayi = "not_installed";
  try {
    mayi = (await ledgerAuthorization(projectId, "status")).status as string;
  } catch {
    mayi = "unavailable";
  }
  return { status: row.status, mayi };
}

export async function loadSetup(
  project: SetupProject,
  opts: { member?: string | null } = {},
): Promise<SetupContext> {
  const [source, drafts] = await Promise.all([
    getAgentSource(project.repoInstallationId, {
      owner: project.repoOwner,
      repo: project.repoName,
    }),
    listDrafts(project.id),
  ]);
  const ctx = await resolveSyncedAgentContext(project.id, null, source.paths);
  const lock = overlayLock(
    source.files["harnesst-lock.json"] ?? null,
    drafts.map((d) => ({ path: d.path, content: d.content })),
  );
  let refs = memberRefs(ctx.isTeam, ctx.roster, lock);
  if (opts.member) refs = refs.filter((r) => r.name === opts.member);

  const sharedNames = await listSharedSecrets(project.id)
    .then((rows) => [...new Set(rows.map((r) => r.key))])
    .catch(() => [] as string[]);

  const members: SetupMemberState[] = await Promise.all(
    refs.map(async (ref) => ({
      name: ref.name,
      agentId: ref.agentId,
      missingSecrets: await missingSecretsFor(
        project.id,
        ref,
        ctx.isTeam,
        lock,
      ).catch(() => []),
      github: needsGitHubApp(lock, ref, ctx.isTeam)
        ? await githubStateFor(project.id, ref, lock)
        : null,
      connections: await connectionsFor(ref, lock).catch(() => []),
    })),
  );

  const input: SetupInput = {
    members,
    sharedSecretNames: sharedNames,
    hasUnpublishedChanges: drafts.length > 0,
    ledger: await ledgerState(project.id).catch(() => null),
  };
  return {
    isTeam: ctx.isTeam,
    lock,
    members: refs,
    input,
    plan: planSetup(input),
  };
}

/**
 * Answer one secret step. The members it applies to come from the server's own plan, never the
 * form. More than one member (or an existing shared secret) ⇒ one project-level shared value,
 * attached to each; one member ⇒ that member's own value. Unpublished members get the value held
 * sealed (or an attach marker) until publish creates their agent.
 */
export async function answerSecretStep(input: {
  projectId: string;
  setup: SetupContext;
  name: string;
  value: string;
  userId: string;
}): Promise<{ error: string | null }> {
  const step = input.setup.plan.steps.find(
    (s) => s.kind === "secret" && s.name === input.name,
  );
  if (!step || step.kind !== "secret")
    return { error: "That secret is already set." };
  const value = input.value.trim();
  const shared = step.members.length > 1 || step.sharedExists;
  if (!value && !step.sharedExists) return { error: "Enter a value." };
  const refs = input.setup.members.filter((m) => step.members.includes(m.name));
  const deps = { secrets: getRuntime().secrets };

  if (shared) {
    if (value) {
      const result = await handleSecretIntent(
        {
          intent: "shared-secret-set",
          projectId: input.projectId,
          agentId: null,
          environmentId: null,
          key: step.name,
          value,
          exposed: step.sandbox,
          userId: input.userId,
        },
        deps,
      );
      if (!result.ok) return { error: result.error };
    }
    for (const ref of refs) {
      if (ref.agentId) {
        const result = await handleSecretIntent(
          {
            intent: "secret-attach",
            projectId: input.projectId,
            agentId: ref.agentId,
            environmentId: null,
            key: step.name,
            exposed: step.sandbox,
            userId: input.userId,
          },
          deps,
        );
        if (!result.ok) return { error: result.error };
      } else {
        await writePendingSecret({
          projectId: input.projectId,
          memberName: ref.name,
          key: step.name,
          sealed: { ciphertext: "", iv: "", authTag: "" },
          fingerprint: null,
          sandboxExposed: step.sandbox,
          attachShared: true,
          createdBy: input.userId,
        });
      }
    }
    return { error: null };
  }

  const ref = refs[0];
  if (!ref) return { error: "That agent is no longer in this repository." };
  if (ref.agentId) {
    const result = await handleSecretIntent(
      {
        intent: "secret-set",
        projectId: input.projectId,
        agentId: ref.agentId,
        environmentId: null,
        key: step.name,
        value,
        exposed: step.sandbox,
        userId: input.userId,
      },
      deps,
    );
    return { error: result.ok ? null : result.error };
  }
  await writePendingSecret({
    projectId: input.projectId,
    memberName: ref.name,
    key: step.name,
    sealed: seal(decodeKey(process.env.HARNESST_SECRETS_KEY), value),
    fingerprint: fingerprint(value),
    sandboxExposed: step.sandbox,
    attachShared: false,
    createdBy: input.userId,
  });
  return { error: null };
}

/** Exported for the route: invalidation after bulk changes is handled per intent above. */
export { invalidateAgentEnvironments };
