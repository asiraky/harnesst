/**
 * Deploy controller + release registry (Deploy pillar, M2 — PRD §7.4/§7.7, ARCH §3.1/§3.9).
 *
 * Orchestrates the pipeline over the seams: cut an immutable Release (merge commit +
 * content-addressed image), deploy it to an environment — a clean cutover that demotes the
 * previously live version once the new one is healthy — and fast-rollback by re-pointing to a
 * prior Release. The weighted traffic split (setTrafficSplit + the ingress splitter) stays in
 * the data model for later, but the product model is one live Release per environment.
 *
 * Persistence goes through the `DataStore` seam (data/ports.ts) and infra through the
 * DeployTarget/SecretsProvider seams, all injected with `getRuntime()` defaults — so every
 * function here is unit-testable against in-memory fakes with no database or docker.
 *
 * The DeployTarget's build/deploy need the eve+docker toolchain; where it's unavailable the
 * controller still records the Release + deployment rows and marks the deployment `failed` with
 * the tooling error, so the control plane and UI work end-to-end without real infra.
 */
import { randomBytes } from "node:crypto";

import type { DataStore, Deployment, Release } from "~/data/ports";
import {
  overlayLock,
  requiredScopesByProvider,
  type HarnesstLock,
} from "~/marketplace/lock";
import { lockSecretsForMember } from "~/project/secrets.server";
import { listProviders } from "~/connections/providers.server";
import { envIngressUrl } from "~/lib/ingress";
import { enqueue } from "~/jobs/queue.server";
import { getRuntime } from "~/seams/index.server";
import type { DeployTarget, SecretScope, SecretsProvider } from "~/seams/types";
import { teammateRoster } from "~/team/roster.server";
import { mintDelegationToken } from "~/team/token.server";
import { getDiscordAppConfig } from "~/discord/config.server";
import { gatewayBaseUrl } from "~/gateway/url.server";
import { mintGatewayToken } from "~/gateway/token.server";
import { modelDirectiveSecret } from "~/models/model-directive.server";
import {
  DEPLOYMENT_DRAIN_CEILING_MS,
  scheduleDeploymentDrain,
  stopDeploymentInfra,
} from "./drain.server";
import { isVersionLabelCollision, versionLabel } from "./versioning";

export type { Release, Deployment } from "~/data/ports";

/** Everything deployRelease/rollbackTo touch: persistence + the two infra seams. */
export interface DeployDeps {
  store: DataStore;
  deployTarget: DeployTarget;
  secrets: SecretsProvider;
  /** All active API-key connection env for the org (exact vars + deterministic aliases). */
  providerDeploymentEnv?: (orgId: string) => Promise<Record<string, string>>;
  /** Per-deployment verifier secret for signed playground model directives. */
  modelDirectiveSecret?: (deploymentId: string) => string;
  /** Whether the org has an active Codex connection — gates model-gateway env injection (#28). */
  hasCodexConnection?: (orgId: string) => Promise<boolean>;
  /** Names of secrets marked "available in the agent's sandbox shell" for a deploy scope. */
  sandboxExposedNames?: (scope: SecretScope) => Promise<string[]>;
  /**
   * Env for the agent's active auth-brokered connection grants (issues #30, #163): per provider,
   * the operator client creds + the sealed refresh token (`<PREFIX>_OAUTH_*`), so the shipped eve
   * connections self-refresh tokens. `{}` when there are no grants; THROWS (failing the deploy)
   * when a grant is dead or (when `requiredScopes` is supplied) under-scoped for the installed
   * connectors (issue #69).
   */
  connectionGrantEnv?: (
    scope: SecretScope,
    requiredScopes?: ReadonlyMap<string, string[]> | null,
  ) => Promise<Record<string, string>>;
  /**
   * Committed `eden-lock.json` content at a release's commit — the generated-secret mint
   * (issue #163) and deploy-time scope-coverage validation (issue #69) both read it. null when
   * the repo has no lock file; a fetch failure THROWS (failing the deploy) — without the lock
   * harnesst can't know which generated secrets the agent requires, and deploys are repeatable.
   */
  agentLock?: (input: {
    installationId: string;
    owner: string;
    repo: string;
    ref: string;
  }) => Promise<string | null>;
}

function deployDeps(): DeployDeps {
  const r = getRuntime();
  return {
    store: r.data,
    deployTarget: r.deployTarget,
    secrets: r.secrets,
    providerDeploymentEnv: (orgId) =>
      import("~/models/provider-connections.server").then((m) =>
        m.getProviderDeploymentEnv(orgId),
      ),
    modelDirectiveSecret,
    hasCodexConnection: (orgId) =>
      import("~/models/provider-connections.server").then((m) =>
        m.hasActiveCodexConnection(orgId),
      ),
    sandboxExposedNames: (scope) =>
      import("~/seams/oss/secret-store").then((m) =>
        m.listSandboxExposedNames(scope),
      ),
    connectionGrantEnv: (scope, requiredScopes) =>
      import("~/connections/deploy.server").then((m) =>
        m.connectionGrantEnv(scope, fetch, undefined, requiredScopes),
      ),
    // A missing lock FILE resolves null; a failed FETCH rejects (deployRelease fails the deploy).
    agentLock: ({ installationId, owner, repo, ref }) =>
      import("~/github/repo.server")
        .then((m) => m.fetchAgentSource(installationId, { owner, repo, ref }))
        .then((s) => s.files["eden-lock.json"] ?? null),
  };
}

/**
 * `hasCodex` stands in for a runnable Codex model source: the gateway URL/token themselves are
 * ALWAYS injected now (they also carry runtime model-config resolution), so their presence no
 * longer implies a Codex connection.
 */
function hasModelCredential(
  env: Record<string, string>,
  hasCodex: boolean,
): boolean {
  return Boolean(
    Object.keys(env).some((name) =>
      /^EDEN_PROVIDER_(?:ANTHROPIC|OPENAI|OPENROUTER)_[A-Z]{12}_API_KEY$/.test(
        name,
      ),
    ) ||
    env.ANTHROPIC_API_KEY ||
    env.OPENAI_API_KEY ||
    env.OPENROUTER_API_KEY ||
    env.AI_GATEWAY_API_KEY ||
    env.VERCEL_OIDC_TOKEN ||
    hasCodex,
  );
}

/** Exact connection credentials and routing coordinates reserved to harnesst. */
function isReservedModelEnvName(name: string): boolean {
  return (
    /^EDEN_PROVIDER_.*_API_KEY$/.test(name) ||
    name === "EDEN_MODEL_GATEWAY_URL" ||
    name === "EDEN_MODEL_GATEWAY_TOKEN" ||
    name === "EDEN_MODEL_DIRECTIVE_SECRET"
  );
}

async function cleanupNewDeploymentInfra(
  deployTarget: DeployTarget,
  deploymentId: string,
): Promise<string | null> {
  try {
    await stopDeploymentInfra(deployTarget, deploymentId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Record an immutable Release for an agent at a git commit. Image is built lazily at deploy
 * time (imageRef stays null until then). Concurrent creates (e.g. two webhook deliveries) race
 * on the version label; the (agent, version) unique constraint catches it and we retry with a
 * fresh count.
 */
export async function createRelease(
  input: {
    projectId: string;
    agentId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<Release> {
  // Each attempt depends on the previous one failing (fresh count after a collision), so
  // retries recurse rather than loop. N concurrent creates resolve one winner per round —
  // allow N-ish rounds.
  const attempt = async (round: number): Promise<Release> => {
    const count = await store.releases.countByAgent(input.agentId);
    try {
      return await store.releases.insert({
        ...input,
        version: versionLabel(count),
      });
    } catch (err) {
      if (!isVersionLabelCollision(err) || round >= 8) throw err;
      return attempt(round + 1);
    }
  };
  return attempt(0);
}

/**
 * Find-or-create the Release for a merge commit (D9: the merge SHA is the version identity).
 * Idempotent per (agent, gitSha) so the two merge triggers — the in-app Merge button and the
 * GitHub webhook — converge on one Release no matter which fires first (or if both do). Returns
 * whether this call created it, so a caller can act (e.g. audit) only on first creation.
 */
export async function ensureReleaseForCommit(
  input: {
    projectId: string;
    agentId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ release: Release; created: boolean }> {
  const existing = await store.releases.findByCommit(
    input.agentId,
    input.gitSha,
  );
  if (existing) return { release: existing, created: false };
  const release = await createRelease(input, store);
  return { release, created: true };
}

/**
 * Cut Releases for EVERY roster member at a merge commit (a team merge is atomic across
 * members — PRD §7.9; per-member change detection is a later optimization, PRD §12).
 */
export async function ensureReleasesForCommit(
  input: {
    projectId: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<{ release: Release; created: boolean }[]> {
  // Repo-commit releases are per member; the built-in assistant is versioned by template hash,
  // not by repo commits, so it is excluded here.
  const roster = (await store.agents.listByProject(input.projectId)).filter(
    (a) => a.kind === "member",
  );
  return Promise.all(
    roster.map((agent) =>
      ensureReleaseForCommit({ ...input, agentId: agent.id }, store),
    ),
  );
}

/** Deployments for an environment, newest first, joined to their release version. */
export function listDeployments(
  environmentId: string,
  store: DataStore = getRuntime().data,
) {
  return store.deployments.listByEnvironment(environmentId);
}

/**
 * Deploy a Release to an environment: build the image if needed, run it via the DeployTarget,
 * and record a deployment row with the resulting health/status. Injects the environment's
 * resolved secrets as container env at start.
 */
export async function deployRelease(
  input: {
    environmentId: string;
    releaseId: string;
    /** Existing `queued` row to take over (from queueDeploy); otherwise one is created. */
    deploymentId?: string;
    /** Force a fresh image build even when the Release already has an imageRef. */
    rebuild?: boolean;
    trafficWeight?: number;
    createdBy?: string | null;
  },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  const { store, deployTarget, secrets } = deps;
  // Release and environment lookups are independent — fetch them together.
  const [release, env] = await Promise.all([
    store.releases.findById(input.releaseId),
    store.environments.findById(input.environmentId),
  ]);
  if (!release) throw new Error("Release not found.");
  if (!env) throw new Error("Environment not found.");
  // The project/agent/roster lookups and the building-row upsert don't depend on each other.
  const [project, agent, allAgents, dep] = await Promise.all([
    store.projects.findById(release.projectId),
    store.agents.findById(release.agentId),
    store.agents.listByProject(release.projectId),
    input.deploymentId
      ? store.deployments.update(input.deploymentId, {
          status: "building",
          trafficWeight: input.trafficWeight ?? 100,
        })
      : store.deployments.insert({
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          status: "building",
          trafficWeight: input.trafficWeight ?? 100,
          createdBy: input.createdBy ?? null,
        }),
  ]);

  // A team member (an `agents/<name>/agent` root — never the single-agent repo's "agent") gets
  // harnesst's delegation wiring: the ask-teammate tool baked into its image (D2) and the relay
  // coordinates + roster injected as env (D3). A team of one is a member too — the tool ships
  // and the env is set; EDEN_TEAMMATES is simply an empty roster.
  // Roster for teammate wiring is real members only (never the built-in assistant).
  const roster = allAgents.filter((a) => a.kind === "member");
  const isTeamMember =
    !!agent && agent.kind === "member" && agent.root !== "agent";

  try {
    const scope: SecretScope = {
      projectId: release.projectId,
      agentId: release.agentId,
      environmentId: input.environmentId,
    };
    const envVars = await secrets.resolve(scope);

    // Committed `eden-lock.json` at THIS release's commit — fetched ONCE and shared by the
    // generated-secret mint below and the connection scope-coverage check further down (issue
    // #69). A repo without a lock FILE is fine (nothing to mint or validate), but a failed
    // FETCH fails the deploy: without the lock harnesst can't know which generated secrets the
    // agent requires, and silently launching without them ships a broken container. Deploys
    // are repeatable — redeploying retries. (A corrupt lock still degrades to empty inside
    // overlayLock; the next install rewrites it cleanly.) Attribution matches the route
    // loaders': a team member is keyed by name, the single-agent root by null.
    let lock: HarnesstLock | null = null;
    if (
      deps.agentLock &&
      project?.repoOwner &&
      project.repoName &&
      project.repoInstallationId
    ) {
      let lockJson: string | null;
      try {
        lockJson = await deps.agentLock({
          installationId: project.repoInstallationId,
          owner: project.repoOwner,
          repo: project.repoName,
          ref: release.gitSha,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not fetch eden-lock.json at ${release.gitSha.slice(0, 7)} (${detail}) — the deploy needs it to mint generated secrets and validate connection scopes. Redeploy to retry.`,
        );
      }
      lock = overlayLock(lockJson, []);
    }
    const member = isTeamMember && agent ? agent.name : null;

    // Generated secrets (issue #163): lock-declared `generated` secrets are minted ONCE per
    // (agent, environment) — 32 random bytes base64url, sealed into secret_values via the normal
    // secrets seam — and reused verbatim on every later deploy. The mint gate is the EXACT
    // (agent, environment, name) row, never the resolved cascade: generated material is nobody's
    // credential, so a user/shared/agent-scoped value of the same name can neither pre-seed nor
    // shadow it (the injected value is always the stored row, regenerated only if that row is
    // deleted). Two concurrent first deploys of the same env can race; last write wins, resolved
    // by the next redeploy.
    if (lock && agent) {
      const generatedNames = lockSecretsForMember(lock, agent.name, isTeamMember)
        .flatMap((e) => e.secrets.filter((s) => s.generated).map((s) => s.name));
      for (const name of new Set(generatedNames)) {
        if (isReservedModelEnvName(name)) continue;
        const ref = {
          projectId: release.projectId,
          agentId: release.agentId,
          environmentId: input.environmentId,
          key: name,
        };
        const existing = await secrets.get(ref);
        const value = existing ?? randomBytes(32).toString("base64url");
        if (existing === null) {
          await secrets.set(ref, value, {
            updatedBy: input.createdBy ?? undefined,
          });
        }
        envVars[name] = value;
      }
    }

    // Legacy/plain Eve model strings call Vercel AI Gateway. harnesst-authored model choices use
    // OpenRouter wiring, but keep this fallback so older repos still run if configured.
    for (const key of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const) {
      const value = process.env[key];
      if (!envVars[key] && value) envVars[key] = value;
    }

    // Exact model credentials are harnesst-owned: a user secret cannot impersonate another workspace
    // connection. Standard provider aliases retain the ordinary secret-cascade override contract
    // for legacy/custom code; harnesst's qualified generated wiring consumes exact vars only.
    for (const key of Object.keys(envVars)) {
      if (isReservedModelEnvName(key)) delete envVars[key];
    }
    if (project && deps.providerDeploymentEnv) {
      const providerEnv = await deps.providerDeploymentEnv(project.orgId);
      for (const [key, value] of Object.entries(providerEnv)) {
        if (/^EDEN_PROVIDER_.*_API_KEY$/.test(key) || !envVars[key]) {
          envVars[key] = value;
        }
      }
    }

    // harnesst gateway coordinates (issue #28 + runtime model-config): EVERY deploy gets the
    // org-scoped URL + token — the generated eden-model.ts resolves the workspace's configured
    // model through `<url>/model-config` at runtime, and a `codex/<connection>/<slug>` model
    // runs on the connected subscription through `<url>/chat/completions`. harnesst-owned (anti-
    // shadowing like EDEN_SANDBOX_ENV): strip any user-set values first, then set.
    delete envVars.EDEN_MODEL_GATEWAY_URL;
    delete envVars.EDEN_MODEL_GATEWAY_TOKEN;
    if (project) {
      envVars.EDEN_MODEL_GATEWAY_URL = gatewayBaseUrl();
      envVars.EDEN_MODEL_GATEWAY_TOKEN = mintGatewayToken(project.orgId);
    }
    delete envVars.EDEN_MODEL_DIRECTIVE_SECRET;
    if (project && deps.modelDirectiveSecret) {
      envVars.EDEN_MODEL_DIRECTIVE_SECRET = deps.modelDirectiveSecret(dep.id);
    }

    // A Codex-only org has no API key in env — its model source is the gateway itself.
    const hasCodex = Boolean(
      project && (await deps.hasCodexConnection?.(project.orgId)),
    );
    if (
      project &&
      deps.providerDeploymentEnv &&
      !hasModelCredential(envVars, hasCodex)
    ) {
      throw new Error(
        "No model provider credential is available for this deployment. Connect Anthropic, OpenAI Platform, OpenRouter, or OpenAI Codex in Org settings -> Model providers, then redeploy.",
      );
    }

    // EDEN_SANDBOX_ENV (sandbox exposure convention): the comma-joined NAMES of the secrets
    // the human marked "available in the agent's sandbox shell"; the scaffolded sandbox.ts
    // forwards exactly those vars into the sandbox env (~/eve/templates). harnesst-owned and set
    // AFTER the secret resolve, so a user secret named EDEN_SANDBOX_ENV can never smuggle its
    // own allowlist. Names only — never values — and only names that actually resolved to an
    // injected env var (exposing a secret that doesn't exist in scope forwards nothing).
    delete envVars.EDEN_SANDBOX_ENV;
    const exposed = deps.sandboxExposedNames
      ? await deps.sandboxExposedNames(scope)
      : [];
    // A dummy exposed secret must not squat on a name harnesst later overwrites with a real provider
    // credential (or Codex gateway token), which would leak that credential into the sandbox.
    const allowlist = exposed.filter(
      (name) => !isReservedModelEnvName(name) && name in envVars,
    );
    if (allowlist.length > 0) envVars.EDEN_SANDBOX_ENV = allowlist.join(",");

    // Team delegation (D3): a team member gets the relay coordinates, an HMAC token identifying
    // THIS deployment, and its roster — all harnesst-owned, so stripped from user secrets first (the
    // same anti-shadowing rule as EDEN_SANDBOX_ENV) then set. Discovery (EDEN_TEAMMATES) is env;
    // authorization is enforced live at the relay, so a roster here is never permission-filtered.
    for (const key of [
      "EDEN_TEAM_URL",
      "EDEN_TEAM_TOKEN",
      "EDEN_TEAMMATES",
      "EDEN_DELEGATION_TIMEOUT_MS",
    ]) {
      delete envVars[key];
    }
    if (isTeamMember && project && agent) {
      // Default relay port matches harnesst's production host (3000) and Vite dev server (5173,
      // vite.config.ts). PORT wins when set.
      envVars.EDEN_TEAM_URL =
        process.env.EDEN_TEAM_RELAY_URL ??
        `http://host.docker.internal:${process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173")}`;
      envVars.EDEN_TEAM_TOKEN = mintDelegationToken(dep.id);
      const teammates = await teammateRoster({
        project: {
          repoOwner: project.repoOwner ?? "",
          repoName: project.repoName ?? "",
          repoInstallationId: project.repoInstallationId ?? "",
        },
        roster,
        selfAgentId: agent.id,
      });
      envVars.EDEN_TEAMMATES = JSON.stringify(teammates);
      // Keep the tool's fetch budget aligned with the relay's when an operator overrides it.
      if (process.env.EDEN_DELEGATION_TIMEOUT_MS) {
        envVars.EDEN_DELEGATION_TIMEOUT_MS =
          process.env.EDEN_DELEGATION_TIMEOUT_MS;
      }
    }

    // Shared Discord app (issue #32): the bot token can act in every connected server across
    // all tenants, so it NEVER reaches an instance — instances get only the public credentials
    // (application id + public key, used for inbound Ed25519 verification) plus the URL of the
    // control-plane send proxy. All bot-token operations happen control-plane-side. Only when the
    // operator has configured the shared app: legacy self-managed-app users are left untouched.
    // Anti-shadowing (as with EDEN_SANDBOX_ENV / EDEN_TEAM_*): delete user-set keys, then set.
    const discord = getDiscordAppConfig();
    if (discord) {
      for (const key of [
        "DISCORD_BOT_TOKEN",
        "DISCORD_APPLICATION_ID",
        "DISCORD_PUBLIC_KEY",
        "EDEN_DISCORD_SEND_URL",
      ]) {
        delete envVars[key];
      }
      envVars.DISCORD_APPLICATION_ID = discord.applicationId;
      envVars.DISCORD_PUBLIC_KEY = discord.publicKey;
      // Same control-plane base-URL derivation as EDEN_TEAM_URL above.
      const controlPlaneBase =
        process.env.EDEN_TEAM_RELAY_URL ??
        `http://host.docker.internal:${process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173")}`;
      envVars.EDEN_DISCORD_SEND_URL = `${controlPlaneBase}/api/discord/send`;
      // The send proxy authenticates the CALLER DEPLOYMENT with the same delegation token the
      // team relay uses, so single-agent deployments (not team members — no EDEN_TEAM_* above)
      // need one too. The team relay independently authorizes, so this grants no team powers.
      envVars.EDEN_TEAM_TOKEN ??= mintDelegationToken(dep.id);
    }

    // Auth-brokered connections (issues #30, #163): for every provider this agent holds an active
    // grant for, inject the operator client creds + sealed refresh token (`<PREFIX>_OAUTH_*`) so
    // the shipped eve connections can self-refresh access tokens at runtime. The provider validates
    // each grant once (a dead grant THROWS here, failing the deploy with a reconnect message).
    // harnesst OWNS a provider's keys only when it actually brokers that connection: like the Discord
    // block above, anti-shadowing runs ONLY per injected provider — so a self-hoster's manually-set
    // GOOGLE_OAUTH_* (their own client + token, no broker) passes through untouched. No-op when
    // there are no grants / no operator config.
    // Deploy-time scope coverage (issue #69): the committed lock at THIS release's commit (fetched
    // once above; a fetch failure already failed the deploy) names the scopes the installed
    // connectors require, per provider. When the repo has no lock file, coverage is simply
    // skipped (grant liveness still runs).
    const requiredConnectionScopes: Map<string, string[]> | null = lock
      ? requiredScopesByProvider(lock, member)
      : null;
    const grantEnv = deps.connectionGrantEnv
      ? await deps.connectionGrantEnv(scope, requiredConnectionScopes)
      : {};
    if (Object.keys(grantEnv).length > 0) {
      let hasBrokeredProvider = false;
      // Capability providers (issue #166) inject NO <PREFIX>_OAUTH_* vars at all — their only
      // trace in grantEnv is the EDEN_CAPABILITY_PROVIDERS marker, so anti-shadowing must read
      // it to know harnesst brokered them: a user secret like XERO_OAUTH_REFRESH_TOKEN (a leftover
      // self-managed connector) must not survive into a container whose whole safety story is
      // "the instance holds no vendor credential".
      const capabilityProviderIds = new Set(
        (grantEnv.EDEN_CAPABILITY_PROVIDERS ?? "").split(",").filter(Boolean),
      );
      for (const def of listProviders()) {
        // Only the providers harnesst actually brokered this deploy — a present <PREFIX>_OAUTH_SCOPES
        // or refresh token marks one (access-token-broker providers ship scopes but no refresh
        // token, issue #167; both deliveries set scopes), and capability providers are named by
        // the marker.
        if (
          !(`${def.envPrefix}_OAUTH_SCOPES` in grantEnv) &&
          !(`${def.envPrefix}_OAUTH_REFRESH_TOKEN` in grantEnv) &&
          !capabilityProviderIds.has(def.id)
        ) {
          continue;
        }
        for (const suffix of [
          "CLIENT_ID",
          "CLIENT_SECRET",
          "REFRESH_TOKEN",
          "SCOPES",
        ]) {
          delete envVars[`${def.envPrefix}_OAUTH_${suffix}`];
        }
        // The provider's static deploy constants (issue #167) are harnesst-owned too.
        for (const key of Object.keys(def.deployEnv ?? {})) {
          delete envVars[key];
        }
        if (def.credentialDelivery === "access-token-broker") {
          hasBrokeredProvider = true;
        }
      }
      for (const [key, value] of Object.entries(grantEnv)) {
        envVars[key] = value;
      }
      // Broker coordinates (issues #167/#166): an access-token-broker provider's instance
      // fetches its tokens from the control plane, and a capability provider's per-operation
      // tools POST there (`/api/capabilities/...`) — both need the base URL plus a
      // deployment-scoped delegation token (the SAME auth story as the team relay and Discord
      // send proxy — the token grants no team powers, authorization happens per surface).
      // Capability providers inject NO per-provider env at all, so their marker
      // (EDEN_CAPABILITY_PROVIDERS, harnesst-owned — grantEnv overwrites any user-set value) is the
      // deploy's signal. EDEN_API_URL is harnesst-owned when injected (anti-shadowing);
      // EDEN_TEAM_TOKEN was already stripped from user secrets by the team block above.
      if (hasBrokeredProvider || "EDEN_CAPABILITY_PROVIDERS" in grantEnv) {
        delete envVars.EDEN_API_URL;
        envVars.EDEN_API_URL =
          process.env.EDEN_TEAM_RELAY_URL ??
          `http://host.docker.internal:${process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173")}`;
        envVars.EDEN_TEAM_TOKEN ??= mintDelegationToken(dep.id);
      }
    }

    // Public origin (issue #163): instances that receive inbound webhooks need their
    // per-environment public ingress URL to construct callback URLs. Operator-level env (deploys
    // can be webhook-driven with no meaningful request origin). Anti-shadowing only when
    // injecting — unset means a user-set EVE_PUBLIC_ORIGIN passes through (local dev /
    // self-managed ingress).
    const publicOriginConfig = process.env.EDEN_PUBLIC_ORIGIN?.trim();
    if (publicOriginConfig) {
      delete envVars.EVE_PUBLIC_ORIGIN;
      envVars.EVE_PUBLIC_ORIGIN = envIngressUrl(
        publicOriginConfig,
        input.environmentId,
      );
    }

    let imageRef = release.imageRef;
    const shouldBuild = input.rebuild || !imageRef;
    if (shouldBuild) {
      if (!project?.repoOwner || !project.repoName) {
        throw new Error(
          "Cannot build release: project is not connected to a GitHub repo.",
        );
      }
      const built = await deployTarget.build({
        projectId: release.projectId,
        repo: { owner: project.repoOwner, repo: project.repoName },
        ref: release.gitSha,
        installationId: project.repoInstallationId,
        agentRoot: agent?.root,
        injectTeammateTool: isTeamMember,
      });
      imageRef = built.imageRef;
      await store.releases.setImageRef(release.id, built.imageRef);
    }

    const health = await deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: imageRef ?? "",
      env: envVars,
      // World database is keyed by ENVIRONMENT, not deployment: every deploy of this env
      // reuses one world, so sessions and their sandboxes survive redeploys.
      worldKey: env.id,
    });

    if (health.status !== "live") {
      const cleanupError = await cleanupNewDeploymentInfra(
        deployTarget,
        dep.id,
      );
      return store.deployments.update(dep.id, {
        status: health.status,
        url: health.url ?? null,
        errorDetail:
          health.status === "failed"
            ? [health.detail, cleanupError && `cleanup failed: ${cleanupError}`]
                .filter(Boolean)
                .join("; ") || null
            : cleanupError
              ? `cleanup failed: ${cleanupError}`
              : null,
      });
    }

    // Cutover: a deployment that lands live becomes THE live version of this environment. Every
    // other live deployment — any release — is DRAINED, not stopped. Flipping the old row to
    // `draining` (a) removes it from every `status === "live"` routing query, so all new inbound
    // work goes to the new deployment immediately, and (b) closes `ingestRunStart`'s run-start
    // gate, so no new `running` row can attach to it — while its container keeps running to finish
    // in-flight turns. The drain watcher (drain.server.ts) stops the container once the runs table
    // shows it idle or the 15-minute ceiling passes; only THEN is the container-cleanup scheduled.
    // The old version keeps serving until this moment, so a failed deploy never takes anything down.
    // (The weighted multi-version splitter survives in the data model, but the product model is
    // single-live-per-environment for now.)
    const siblings = await store.deployments.listByEnvironment(
      input.environmentId,
    );
    const superseded = siblings.filter(
      (d) => d.id !== dep.id && d.status === "live",
    );
    try {
      await Promise.all(
        superseded.map((d) =>
          store.deployments.update(d.id, {
            status: "draining",
            trafficWeight: 0,
            errorDetail: null,
          }),
        ),
      );
    } catch (error) {
      const cleanupError = await cleanupNewDeploymentInfra(
        deployTarget,
        dep.id,
      );
      const detail = error instanceof Error ? error.message : String(error);
      return store.deployments.update(dep.id, {
        status: "failed",
        url: health.url ?? null,
        errorDetail: [
          `cutover failed while draining the previous deployment: ${detail}`,
          cleanupError && `new deployment cleanup failed: ${cleanupError}`,
        ]
          .filter(Boolean)
          .join("; "),
      });
    }

    const updated = await store.deployments.update(dep.id, {
      status: health.status,
      url: health.url ?? null,
      errorDetail: null,
    });
    if (project) {
      await store.audit.record({
        orgId: project.orgId,
        actorUserId: input.createdBy ?? null,
        action: "deploy",
        target: release.version,
        meta: { environmentId: input.environmentId, status: updated.status },
      });
    }
    // Hand each drained sibling to the watcher with the ceiling encoded as an absolute deadline
    // anchored at cutover — so every re-poll of the job shares one 15-minute window regardless of
    // how long individual ticks take. The watcher stops the container and schedules its cleanup.
    const drainDeadline = new Date(Date.now() + DEPLOYMENT_DRAIN_CEILING_MS);
    await Promise.all(
      superseded.map((d) =>
        scheduleDeploymentDrain(store, d.id, drainDeadline),
      ),
    );
    return updated;
  } catch (error) {
    await cleanupNewDeploymentInfra(deployTarget, dep.id);
    // Record WHY it failed — a bare `failed` row is undebuggable (and while the eve
    // toolchain is young, build failures are the expected failure mode).
    const detail = error instanceof Error ? error.message : String(error);
    return store.deployments.update(dep.id, {
      status: "failed",
      errorDetail: detail,
    });
  }
}

/**
 * Fast rollback (D9): deploy a prior Release again at full weight. The prior image is reused
 * (no rebuild) when it's already been built, and deployRelease's cutover demotes the current
 * version only once the rollback is actually live — a failed rollback leaves it serving.
 */
export async function rollbackTo(
  input: {
    environmentId: string;
    releaseId: string;
    deploymentId?: string;
    createdBy?: string | null;
  },
  deps: DeployDeps = deployDeps(),
): Promise<Deployment> {
  return deployRelease({ ...input, trafficWeight: 100 }, deps);
}

/**
 * Queue a deploy (or rollback) the way the UI needs it: create the deployment row in `pending`
 * status FIRST — so the click has an immediately-visible result — then enqueue the job that
 * takes the row through building → live/failed. Without this, the row only appeared when the
 * worker picked the job up, which read as "the button did nothing".
 */
export async function queueDeploy(
  input: {
    environmentId: string;
    releaseId: string;
    rollback?: boolean;
    rebuild?: boolean;
    createdBy?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<Deployment> {
  const dep = await store.deployments.insert({
    environmentId: input.environmentId,
    releaseId: input.releaseId,
    status: "pending",
    trafficWeight: 100,
    createdBy: input.createdBy ?? null,
  });
  await enqueue(
    input.rollback ? "rollback_release" : "deploy_release",
    {
      environmentId: input.environmentId,
      releaseId: input.releaseId,
      deploymentId: dep.id,
      rebuild: input.rebuild ?? false,
      createdBy: input.createdBy ?? null,
    },
    undefined,
    store,
  );
  return dep;
}

/**
 * Set the weighted, session-sticky traffic split across an environment's deployments (D9/D10).
 * Weights are relative integers the ingress splitter normalizes; the human decides them.
 */
export async function setTrafficSplit(
  environmentId: string,
  weights: { deploymentId: string; weight: number }[],
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.deployments.setWeights(environmentId, weights);
}

/** Remove an environment's failed deployment rows (post-mortem clutter in the UI). */
export function clearFailedDeployments(
  environmentId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  return store.deployments.deleteFailed(environmentId);
}

/** Find the project connected to a repo (for webhook-driven deploys). */
export function findProjectByRepo(
  owner: string,
  repo: string,
  store: DataStore = getRuntime().data,
) {
  return store.projects.findByRepo(owner, repo);
}
