/**
 * The built-in assistant's instance lifecycle. The assistant deploys
 * on the SAME substrate as any eve agent — an internal environment, a synthesized release per
 * template content-hash, and a Docker deployment via the DeployTarget — but it builds from the
 * bundled local `assistant-template/` (not a GitHub tarball) and is injected with NO user
 * secrets. Long work (build + deploy) runs through the jobs queue (`assistant_deploy`); the UI
 * shows a provisioning state until the instance is live.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
  assembleBundle,
  defaultAuthoringDeps,
  type AuthoringProject,
} from "~/assistant/authoring.server";
import type { Agent, DataStore, Environment, Release } from "~/data/ports";
import { buildAssistantImage } from "~/deploy/eve-image.server";
import {
  recoverLiveDeployment,
  wakeStoppedDeployment,
} from "~/deploy/liveness.server";
import { isVersionLabelCollision } from "~/deploy/versioning";
import { enqueue } from "~/jobs/queue.server";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";
import type { ReasoningEffort } from "~/models/reasoning";
import {
  getActiveModelConnection,
  getProviderDeploymentEnv,
  hasActiveCodexConnection,
} from "~/models/provider-connections.server";
import {
  parseProviderModelReference,
  providerConnectionEnvName,
} from "~/models/provider-reference";
import { gatewayBaseUrl } from "~/gateway/url.server";
import { mintGatewayToken } from "~/gateway/token.server";
import { getRuntime } from "~/seams/index.server";
import { mintAssistantToken } from "./token.server";

/** Internal environment + roster name for the assistant. */
const ASSISTANT_ENV = "assistant";
const ASSISTANT_NAME = "assistant";
const ASSISTANT_ROOT = ".harnesst/assistant";

/** Where the bundled template lives (mirrors the CatalogSource fixture reading <cwd>/catalog). */
export function assistantTemplateDir(): string {
  return (
    process.env.HARNESST_ASSISTANT_TEMPLATE_DIR ??
    path.join(process.cwd(), "assistant-template")
  );
}

/** The fixed, harnesst-owned layer — rendered read-only on the config page so it's inspectable. */
export interface AssistantFixedLayer {
  instructions: string;
  tools: string[];
}

let cachedFixedLayer: AssistantFixedLayer | null = null;

export async function assistantFixedLayer(): Promise<AssistantFixedLayer> {
  if (cachedFixedLayer) return cachedFixedLayer;
  const dir = assistantTemplateDir();
  const instructions = await readFile(
    path.join(dir, "agent", "instructions.md"),
    "utf8",
  ).catch(() => "");
  const tools = await readdir(path.join(dir, "agent", "tools"))
    .then((names) =>
      names
        .filter((n) => n.endsWith(".ts"))
        .map((n) => n.replace(/\.ts$/, ""))
        .sort(),
    )
    .catch(() => []);
  cachedFixedLayer = { instructions, tools };
  return cachedFixedLayer;
}

let cachedHash: string | null = null;

/** Content hash of the bundled template — the assistant's release identity + image tag. */
export async function assistantTemplateHash(): Promise<string> {
  if (cachedHash) return cachedHash;
  const dir = assistantTemplateDir();
  const files: string[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Skip build artifacts / installed deps that aren't part of the source identity.
      if (
        ["node_modules", ".eve", ".output", ".git", ".workflow-data"].includes(
          e.name,
        )
      )
        continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else files.push(child);
    }
  }
  await walk("");
  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, rel)));
    hash.update("\0");
  }
  cachedHash = hash.digest("hex").slice(0, 16);
  return cachedHash;
}

function assistantImageRef(hash: string): string {
  return `harnesst-assistant:${hash}`;
}

/** gitSha marker for a template-hash release (not a real repo commit — see docs §3). */
function templateGitSha(hash: string, configKey: string): string {
  return `tmpl-${hash}-c${configKey}`;
}

/**
 * Short fingerprint of the org's workspace assistant selection (model + effort), folded into the
 * release marker. A container's env is fixed when it is created, so a changed selection can never
 * reach a running (or stopped) instance — it needs a NEW deployment. Making the selection part of
 * the release identity lets ensure/peek read a model change as a stale deployment and re-provision
 * transparently, instead of pinning the org to whatever model was baked at first deploy.
 */
async function workspaceConfigKey(orgId: string): Promise<string> {
  const selection = await getWorkspaceAssistantSelection(orgId).catch(() => ({
    model: null as string | null,
    effort: null as string | null,
  }));
  return createHash("sha256")
    .update(`${selection.model ?? ""}|${selection.effort ?? ""}`)
    .digest("hex")
    .slice(0, 8);
}

// ── Agent + environment ───────────────────────────────────────────────────────

export interface AssistantAgent {
  agent: Agent;
  environment: Environment;
}

/**
 * Ensure the project's built-in assistant agent row (kind 'assistant') and its internal
 * environment exist. Collision-safe: if a legacy roster member already owns the name "assistant"
 * (pre-reservation repos), the internal row falls back to "assistant-internal".
 */
export async function ensureAssistantAgent(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantAgent> {
  let agent = await store.agents.findAssistant(projectId);
  if (!agent) {
    const roster = await store.agents.listByProject(projectId);
    const name = roster.some((a) => a.name === ASSISTANT_NAME)
      ? "assistant-internal"
      : ASSISTANT_NAME;
    agent = await store.agents.createAssistant({
      projectId,
      name,
      root: ASSISTANT_ROOT,
    });
  }
  await store.environments.ensureDefault(projectId, agent.id); // guarantees ≥1 env
  const envs = await store.environments.listByAgent(agent.id);
  const environment =
    envs.find((e) => e.name === ASSISTANT_ENV) ??
    (await renameFirstEnv(envs[0], store));
  return { agent, environment };
}

/** The assistant environment is named "assistant"; rename the seeded "default" to it. */
async function renameFirstEnv(
  env: Environment,
  store: DataStore,
): Promise<Environment> {
  if (env.name === ASSISTANT_ENV) return env;
  await store.environments.rename(env.id, ASSISTANT_ENV).catch(() => {});
  const refreshed = await store.environments.findById(env.id);
  return refreshed ?? env;
}

// ── Deploy env assembly (no user secrets, ever) ────────────────────────────────

function harnesstApiUrl(): string {
  if (process.env.HARNESST_ASSISTANT_API_URL)
    return process.env.HARNESST_ASSISTANT_API_URL;
  const port =
    process.env.PORT ??
    (process.env.NODE_ENV === "production" ? "3000" : "5173");
  return `http://host.docker.internal:${port}`;
}

/** Exported for tests: the harnesst-owned env an assistant instance is deployed with (no user secrets). */
export async function assistantEnv(input: {
  orgId: string;
  deploymentId: string;
  /** Published per-project override; null/undefined inherits the workspace default. */
  modelOverride?: string | null;
  /** Explicit effort paired with modelOverride; null delegates to the provider default. */
  effortOverride?: ReasoningEffort | null;
}): Promise<Record<string, string>> {
  const overrideModel = input.modelOverride?.trim() || null;
  const selection = overrideModel
    ? { model: overrideModel, effort: input.effortOverride ?? null }
    : await getWorkspaceAssistantSelection(input.orgId).catch(() => ({
        model: null,
        effort: null,
      }));
  const configuredModel = selection.model;
  if (!configuredModel) {
    throw new Error(
      "No assistant model is configured. Connect a model provider and select a workspace " +
        "default or assistant model in Settings.",
    );
  }
  const model = configuredModel;
  const selected = parseProviderModelReference(model);
  const [providerEnv, hasCodex, selectedConnection] = await Promise.all([
    getProviderDeploymentEnv(input.orgId),
    hasActiveCodexConnection(input.orgId),
    selected
      ? getActiveModelConnection(input.orgId, selected.connectionId)
      : Promise.resolve(null),
  ]);
  const selectedEnvName =
    selected && selected.provider !== "codex"
      ? providerConnectionEnvName(selected.provider, selected.connectionId)
      : null;
  const hasSelectedCredential = selected
    ? selected.provider === "codex"
      ? selectedConnection?.provider === "codex"
      : selectedConnection?.provider === selected.provider &&
        Boolean(selectedEnvName && providerEnv[selectedEnvName])
    : Boolean(providerEnv.OPENROUTER_API_KEY); // pre-Phase-2 bare OpenRouter model
  if (!hasSelectedCredential) {
    throw new Error(
      "The assistant's selected model provider connection is not active. Connect it in " +
        "Org settings → Model providers, then select an available assistant model.",
    );
  }
  // Built fresh (no user secrets to shadow); only the harnesst-owned keys are set.
  const env: Record<string, string> = {
    ...providerEnv,
    HARNESST_ASSISTANT_MODEL: model,
    HARNESST_API_URL: harnesstApiUrl(),
    HARNESST_ASSISTANT_TOKEN: mintAssistantToken(input.deploymentId),
  };
  if (selection.effort) env.HARNESST_ASSISTANT_EFFORT = selection.effort;
  if (hasCodex) {
    env.HARNESST_MODEL_GATEWAY_URL = gatewayBaseUrl();
    env.HARNESST_MODEL_GATEWAY_TOKEN = mintGatewayToken(input.orgId);
  }
  return env;
}

/**
 * Ensure the release row for the current template hash exists — reuse the one recorded for this
 * hash, or synthesize a new one. Pure metadata (no image build), so it's cheap enough to run
 * synchronously in a request handler when we need a release id up front.
 */
async function ensureAssistantRelease(
  projectId: string,
  agent: Agent,
  hash: string,
  configKey: string,
  store: DataStore,
): Promise<Release> {
  const gitSha = templateGitSha(hash, configKey);
  const existing = await store.releases.findByCommit(agent.id, gitSha);
  if (existing) return existing;
  try {
    return await store.releases.insert({
      projectId,
      agentId: agent.id,
      version: `t${(await store.releases.countByAgent(agent.id)) + 1}`,
      gitSha,
      changelog: `Assistant template ${hash}`,
    });
  } catch (error) {
    // Two concurrent provisions race on the version label (#31); the winner recorded this same
    // template hash, so adopt its row rather than failing the request.
    if (!isVersionLabelCollision(error)) throw error;
    const raced = await store.releases.findByCommit(agent.id, gitSha);
    if (raced) return raced;
    throw error;
  }
}

// ── Provisioning (the assistant_deploy job body) ───────────────────────────────

export interface AssistantDeployPayload {
  projectId: string;
  [key: string]: unknown;
}

/**
 * The `assistant_deploy` job body: ensure agent/env/release/image, then deploy the instance.
 * Idempotent — takes over any pending deployment for the env and reuses a built image.
 */
export async function runAssistantDeploy(
  payload: AssistantDeployPayload,
  store: DataStore = getRuntime().data,
): Promise<{ status: string; url: string | null; deploymentId: string }> {
  const runtime = getRuntime();
  const project = await store.projects.findById(payload.projectId);
  if (!project) throw new Error("Project not found for assistant deploy.");
  const { agent, environment } = await ensureAssistantAgent(project.id, store);

  const hash = await assistantTemplateHash();
  const imageRef = assistantImageRef(hash);

  // Reuse the release for this template hash + workspace selection, or synthesize one. The image
  // stays keyed on the template hash alone — a model change reuses the built image and only the
  // container env differs.
  const configKey = await workspaceConfigKey(project.orgId);
  let release = await ensureAssistantRelease(
    project.id,
    agent,
    hash,
    configKey,
    store,
  );

  // Take over a pending/building row, else create one (visible immediately).
  const existing = await store.deployments.listByEnvironment(environment.id);
  const takeover = existing.find(
    (d) => d.status === "pending" || d.status === "building",
  );
  const dep = takeover
    ? await store.deployments.update(takeover.id, { status: "building" })
    : await store.deployments.insert({
        environmentId: environment.id,
        releaseId: release.id,
        status: "building",
        trafficWeight: 100,
      });

  try {
    // Build the shared image if this release hasn't recorded one yet (docker layer cache makes a
    // repeat build across projects cheap).
    if (!release.imageRef) {
      const built = await buildAssistantImage({
        imageRef,
        templateDir: assistantTemplateDir(),
      });
      await store.releases.setImageRef(release.id, built.imageRef);
      release = { ...release, imageRef: built.imageRef };
    }

    const bundle = await assembleBundle(
      project as AuthoringProject,
      defaultAuthoringDeps(),
    );
    const env = await assistantEnv({
      orgId: project.orgId,
      deploymentId: dep.id,
      modelOverride: bundle.model,
      effortOverride: bundle.effort,
    });
    const health = await runtime.deployTarget.deploy({
      deploymentId: dep.id,
      imageRef: release.imageRef ?? imageRef,
      env,
      worldKey: environment.id,
    });
    if (health.status !== "live") {
      await store.deployments.update(dep.id, {
        status: "failed",
        errorDetail:
          health.detail ?? "assistant instance did not become healthy",
      });
      return { status: "failed", url: null, deploymentId: dep.id };
    }
    // Demote any other live rows in the env (single live assistant), then mark live.
    for (const other of existing) {
      if (other.id !== dep.id && other.status === "live") {
        await runtime.deployTarget.stop(other.id).catch(() => {});
        await store.deployments.update(other.id, {
          status: "stopped",
          trafficWeight: 0,
        });
      }
    }
    await store.deployments.update(dep.id, {
      status: "live",
      url: health.url ?? null,
    });
    return { status: "live", url: health.url ?? null, deploymentId: dep.id };
  } catch (error) {
    await store.deployments.update(dep.id, {
      status: "failed",
      errorDetail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Is `err` the unique-violation raised by `deployments_env_inflight_uq` (at most one
 * pending/building deployment per environment)? Drizzle wraps the driver error, so walk the
 * cause chain rather than matching the top-level message (same shape as isVersionLabelCollision).
 */
function isInflightDeploymentCollision(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: string; constraint_name?: string };
    if (
      pg.code === "23505" &&
      pg.constraint_name === "deployments_env_inflight_uq"
    ) {
      return true;
    }
  }
  return false;
}

// ── The entry the UI / stream route calls ──────────────────────────────────────

export interface AssistantInstance {
  status: "live" | "provisioning" | "failed";
  url: string | null;
  deploymentId: string | null;
  environmentId: string;
  releaseId: string | null;
  version: string | null;
  /** The release's template-hash marker (`templateGitSha` — not a repo commit). */
  gitSha: string | null;
  agentId: string;
  error?: string | null;
}

/**
 * Ensure a live assistant instance for a turn. Fast paths: a live deployment on the current
 * template image is returned immediately; a stopped one is woken with `start()`. Otherwise an
 * `assistant_deploy` job is queued and a `provisioning` status is returned so the UI can show
 * "setting up your assistant…" and poll.
 */
export async function ensureAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantInstance> {
  const runtime = getRuntime();
  const { agent, environment } = await ensureAssistantAgent(projectId, store);
  const project = await store.projects.findById(projectId);
  if (!project) throw new Error("Project not found for assistant instance.");
  const hash = await assistantTemplateHash();
  const configKey = await workspaceConfigKey(project.orgId);
  const currentSha = templateGitSha(hash, configKey);

  const deployments = await store.deployments.listByEnvironment(environment.id);
  const base = {
    environmentId: environment.id,
    agentId: agent.id,
  };

  // A live deployment on the CURRENT template → verify it, waking a definitely-stopped target.
  const live = deployments.find(
    (d) => d.status === "live" && d.gitSha === currentSha,
  );
  if (live) {
    const recovered = await recoverLiveDeployment(live, {
      store,
      deployTarget: runtime.deployTarget,
    });
    if (recovered?.url) {
      return {
        ...base,
        status: "live",
        url: recovered.url,
        deploymentId: recovered.id,
        releaseId: recovered.releaseId,
        version: recovered.version,
        gitSha: recovered.gitSha,
      };
    }
  }

  // A stopped deployment on the current template → wake it.
  const stopped = deployments.find(
    (d) => d.status === "stopped" && d.gitSha === currentSha,
  );
  if (stopped) {
    const recovered = await wakeStoppedDeployment(stopped, {
      store,
      deployTarget: runtime.deployTarget,
    });
    if (recovered?.url) {
      return {
        ...base,
        status: "live",
        url: recovered.url,
        deploymentId: recovered.id,
        releaseId: recovered.releaseId,
        version: recovered.version,
        gitSha: recovered.gitSha,
      };
    }
  }

  // Already provisioning?
  const pending = deployments.find(
    (d) => d.status === "pending" || d.status === "building",
  );
  if (pending) {
    return {
      ...base,
      status: "provisioning",
      url: null,
      deploymentId: pending.id,
      releaseId: pending.releaseId,
      version: pending.version,
      gitSha: pending.gitSha,
    };
  }

  // Nothing usable (never deployed, image changed after a harnesst upgrade, or previous failure):
  // create the `pending` deployment row synchronously, THEN queue the build+deploy. The worker's
  // runAssistantDeploy only *takes over* a pending/building row — it doesn't create one — so
  // without this, a loader re-read right after the provision click still saw "idle" until the
  // worker got around to inserting the row, and the UI flickered back to the empty state (#17).
  // Persisting `pending` up front means peekAssistantInstance reports "provisioning" immediately.
  const release = await ensureAssistantRelease(
    projectId,
    agent,
    hash,
    configKey,
    store,
  );
  let dep;
  try {
    dep = await store.deployments.insert({
      environmentId: environment.id,
      releaseId: release.id,
      status: "pending",
      trafficWeight: 100,
    });
  } catch (error) {
    // Lost the insert race (#31): a concurrent request created its `pending` row (and, right
    // after, enqueued the deploy — the enqueue below stays AFTER the insert so the winner is
    // always the one that queued a job). Adopt the winner's row instead of failing — no second
    // row, no second job.
    if (!isInflightDeploymentCollision(error)) throw error;
    const raced = (
      await store.deployments.listByEnvironment(environment.id)
    ).find((d) => d.status === "pending" || d.status === "building");
    if (!raced) {
      // The winner's row left pending/building in the gap between our insert and this re-read.
      // Vanishingly rare (a deploy takes far longer than a DB round-trip); surface a clear
      // error — the next turn re-enters this function and finds whatever state the winner left.
      throw new Error(
        "Assistant provisioning raced a concurrent request that already completed; retry.",
        { cause: error },
      );
    }
    return {
      ...base,
      status: "provisioning",
      url: null,
      deploymentId: raced.id,
      releaseId: raced.releaseId,
      version: raced.version,
      gitSha: raced.gitSha,
    };
  }
  await enqueue(
    "assistant_deploy",
    { projectId } satisfies AssistantDeployPayload,
    undefined,
    store,
  );
  return {
    ...base,
    status: "provisioning",
    url: null,
    deploymentId: dep.id,
    releaseId: release.id,
    version: release.version,
    gitSha: release.gitSha,
  };
}

/** A read-only snapshot for the loader — NO side effects (no enqueue, no wake, no build). */
export interface AssistantSnapshot {
  status: "live" | "provisioning" | "resumable" | "failed" | "idle";
  agentId: string | null;
  environmentId: string | null;
  /** Human stage label while provisioning (e.g. "Building the assistant image…"); null otherwise. */
  provisionStage: string | null;
  /** ISO timestamp the current provisioning deployment started, for an elapsed timer; null otherwise. */
  provisionStartedAt: string | null;
  /** Present only when live. */
  target: {
    deploymentId: string;
    environmentId: string;
    releaseId: string;
    url: string;
    version: string;
    environmentName: string;
    /** The release's template-hash marker (`templateGitSha` — not a repo commit). */
    gitSha: string;
  } | null;
}

/**
 * Report the assistant instance's current status without provisioning or waking it (loader-safe).
 * `idle` means the assistant was never set up — the UI offers first-run setup. `resumable` means
 * a previous instance exists but isn't currently usable as-is (stopped container, live row whose
 * release marker predates a harnesst upgrade or a workspace model change, or a live row missing its
 * url) — the UI treats this as ready, and the next turn wakes or re-provisions it via
 * `ensureAssistantInstance`.
 */
export async function peekAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<AssistantSnapshot> {
  const idle = { provisionStage: null, provisionStartedAt: null } as const;
  const agent = await store.agents.findAssistant(projectId);
  if (!agent)
    return {
      status: "idle",
      agentId: null,
      environmentId: null,
      target: null,
      ...idle,
    };
  const envs = await store.environments.listByAgent(agent.id);
  const env = envs.find((e) => e.name === ASSISTANT_ENV) ?? envs[0];
  if (!env)
    return {
      status: "idle",
      agentId: agent.id,
      environmentId: null,
      target: null,
      ...idle,
    };
  const base = { agentId: agent.id, environmentId: env.id, ...idle };

  const project = await store.projects.findById(projectId);
  if (!project) return { ...base, status: "idle", target: null };
  const currentSha = templateGitSha(
    await assistantTemplateHash(),
    await workspaceConfigKey(project.orgId),
  );
  const deployments = await store.deployments.listByEnvironment(env.id);
  const live = deployments.find(
    (d) => d.status === "live" && d.url && d.gitSha === currentSha,
  );
  if (live && live.url) {
    return {
      ...base,
      status: "live",
      target: {
        deploymentId: live.id,
        environmentId: env.id,
        releaseId: live.releaseId,
        url: live.url,
        version: live.version,
        environmentName: ASSISTANT_ENV,
        gitSha: live.gitSha,
      },
    };
  }
  const active = deployments.find(
    (d) => d.status === "pending" || d.status === "building",
  );
  if (active) {
    return {
      ...base,
      status: "provisioning",
      target: null,
      provisionStage:
        active.status === "building"
          ? "Building the assistant image…"
          : "Preparing the build…",
      provisionStartedAt: active.createdAt.toISOString(),
    };
  }
  // A current-template stopped/container-without-url row is still recoverable even when older
  // failed attempts coexist with it. Prefer that positive signal over failure.
  const currentResumable = deployments.find(
    (d) =>
      (d.status === "live" || d.status === "stopped") &&
      d.gitSha === currentSha,
  );
  if (currentResumable) {
    return { ...base, status: "resumable", target: null };
  }
  // A failed attempt for the CURRENT desired image is a terminal readiness signal. This must win
  // over an older live/stopped image: after an upgrade/model change fails, that stale row cannot
  // make the newly observed provisioning state look merely resumable forever (#256).
  const failedCurrent = deployments.find(
    (d) => d.status === "failed" && d.gitSha === currentSha,
  );
  if (failedCurrent) {
    return { ...base, status: "failed", target: null };
  }
  // Anything ensureAssistantInstance can transparently replace on the next turn — a live/stopped
  // row on a pre-upgrade template sha — must NOT read as "never set up": that regressed
  // long-standing projects into the first-run setup flow after a harnesst release.
  const resumable = deployments.find(
    (d) => d.status === "live" || d.status === "stopped",
  );
  if (resumable) {
    return { ...base, status: "resumable", target: null };
  }
  if (
    deployments.length > 0 &&
    deployments.every((d) => d.status === "failed")
  ) {
    return { ...base, status: "failed", target: null };
  }
  return { ...base, status: "idle", target: null };
}

/**
 * Restart the assistant instance so it re-fetches its config bundle and rebuilds (used by the
 * refresh-on-merge hook when `.harnesst/assistant/**` changes). Best-effort stop → start on the
 * current live/stopped deployment; a missing instance is a no-op (it provisions on next use).
 */
export async function restartAssistantInstance(
  projectId: string,
  store: DataStore = getRuntime().data,
): Promise<boolean> {
  const runtime = getRuntime();
  const agent = await store.agents.findAssistant(projectId);
  if (!agent) return false;
  const envs = await store.environments.listByAgent(agent.id);
  const env = envs.find((e) => e.name === ASSISTANT_ENV) ?? envs[0];
  if (!env) return false;
  const deployments = await store.deployments.listByEnvironment(env.id);
  const target = deployments.find(
    (d) => d.status === "live" || d.status === "stopped",
  );
  if (!target) return false;
  await runtime.deployTarget.stop(target.id).catch(() => {});
  const health = await runtime.deployTarget.start(target.id).catch(() => null);
  if (health?.status === "live") {
    await store.deployments.update(target.id, {
      status: "live",
      url: health.url ?? null,
    });
    return true;
  }
  await store.deployments
    .update(target.id, { status: "stopped", trafficWeight: 0 })
    .catch(() => {});
  return false;
}
