/**
 * Local-dev DeployTarget: build + run each instance as a Docker container on this host,
 * against the local Postgres (Workflow World), reachable at a mapped localhost port.
 *
 * This is the runnable OSS deploy path for `npm run dev` (HARNESST_DEPLOY_TARGET=local-docker).
 * It's the honest, minimal version of the managed Nomad/gVisor substrate: same DeployTarget
 * seam, plain `docker run` instead of an orchestrator.
 *
 * Pipeline (contract validated end-to-end against eve):
 *   build   fetch repo tarball @ commit (GitHub App) → docker multi-stage build (npm ci +
 *           `eve build` run inside linux) → runtime image booting `eve start` (which prewarms
 *           sandbox templates — see eve-image.server.ts) + a build-stage image that keeps
 *           node_modules (for the world migration CLI)
 *   deploy  provision the environment's Workflow world DB → run `workflow-postgres-setup`
 *           from the build-stage image → docker run -d with WORKFLOW_POSTGRES_URL + secret
 *           env, the host Docker socket mounted, on a mapped 127.0.0.1 port → health-check
 *   stop/start  docker stop/start (scale-to-zero)
 *
 * Two runtime facts this target now honors (both eve semantics):
 *   - Real sandboxes. eve's `defaultBackend()` gives an agent a real Docker sandbox only when
 *     a docker CLI + reachable daemon are present, else it silently degrades to `just-bash`
 *     (a pure-JS bash that can't run git/node/npm). We ship the client binary in the image
 *     (eve-image.server.ts) and mount `/var/run/docker.sock`, so the eve runtime spawns sibling
 *     sandbox containers on the host daemon (docker-outside-of-docker). The MODEL's bash runs
 *     INSIDE those sandbox containers, which have NO socket — only the runtime process (eve +
 *     repo-authored tool code) can reach the host daemon.
 *   - Durable worlds. The Workflow world DB is keyed by ENVIRONMENT, not deployment, so every
 *     redeploy of an environment reuses one world — eve reattaches each durable session's
 *     long-lived sandbox container, and sessions + their /workspace filesystems survive.
 *
 * The repo must be deployable off-Vercel: `@workflow/world-postgres` (at the beta line
 * matching its eve version) as a dependency, and agent.ts declaring
 * `experimental.workflow.world` + `build.externalDependencies` for it.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import postgres from "postgres";

import {
  commandErrorText,
  normalizeDockerCliError,
} from "~/deploy/docker.server";
import {
  buildEveImage,
  buildStageTagFor,
  buildStagedTree,
} from "~/deploy/eve-image.server";
import type {
  BuildRequest,
  BuiltArtifact,
  DeployRequest,
  DeployTarget,
  InstanceHealth,
  WorldSessionSummary,
} from "~/seams/types";

const exec = promisify(execFile);

/** Port the eve/Nitro server listens on inside the container. */
const INSTANCE_PORT = Number(process.env.HARNESST_INSTANCE_PORT ?? 3000);
/**
 * Port the assistant checkout sidecar listens on inside the container. Only
 * the assistant image runs a sidecar; regular agent images ignore the
 * extra published port. Kept in sync with `HARNESST_AUX_PORT` the sidecar reads.
 */
const AUX_PORT = Number(process.env.HARNESST_AUX_PORT ?? 3100);
/** How the container reaches the host's Postgres (Docker Desktop). */
const DB_HOST_FROM_CONTAINER =
  process.env.HARNESST_DB_HOST_FROM_CONTAINER ?? "host.docker.internal";
/**
 * Health-wait budgets. The image boots via `eve start` (eve-image.server.ts), which prewarms
 * sandbox templates BEFORE the server binds its port — a deploy's first boot may pull
 * ghcr.io/vercel/eve, run a template-build container, execute the agent's bootstrap(), and
 * seed workspace files: legitimately minutes, not seconds. A wake (`docker start`) re-runs
 * prewarm but hits the cached-template fast path — an image inspect — so it only needs time
 * for the Nitro server itself (plus a template rebuild in the rare exposed-env-changed case,
 * which the next deploy would absorb anyway). Both env-overridable for slow hosts.
 */
export const DEPLOY_HEALTH_TIMEOUT_MS = Number(
  process.env.HARNESST_DEPLOY_HEALTH_TIMEOUT_MS ?? 10 * 60 * 1000,
);
export const WAKE_HEALTH_TIMEOUT_MS = Number(
  process.env.HARNESST_WAKE_HEALTH_TIMEOUT_MS ?? 120 * 1000,
);

const containerName = (deploymentId: string) => `harnesst-inst-${deploymentId}`;

/**
 * Postgres database name for an environment's Workflow world. Keyed by the (stable) worldKey,
 * NOT a deployment id — that's the whole durability fix. Sanitize to a legal identifier
 * (lowercase, [a-z0-9_] only), then append a short sha1 slice of the RAW key so distinct keys
 * that sanitize to the same string can't collide onto one database.
 */
export const worldDbName = (worldKey: string): string => {
  const sanitized = worldKey
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
  const slug = createHash("sha1").update(worldKey).digest("hex").slice(0, 8);
  return `harnesst_env_${sanitized}_${slug}`;
};

/**
 * Docker named-volume for an environment's agent home (`/workspace/home`, mounted by the
 * eve-docker shim onto every session sandbox — see eve-image.server.ts). Keyed by the same stable
 * worldKey as the world DB, so one environment has exactly one home that outlives its sessions and
 * redeploys and dies only with the environment (destroyWorld). Same shape as worldDbName but the
 * volume charset is wider ([a-zA-Z0-9_.-]); sanitize lowercase, cap 24, then append a sha1 slice of
 * the RAW key so keys that sanitize alike can't collide onto one volume. Docker auto-creates it on
 * first sandbox use — no provisioning step.
 */
export const homeVolumeName = (worldKey: string): string => {
  const sanitized = worldKey
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 24);
  const slug = createHash("sha1").update(worldKey).digest("hex").slice(0, 8);
  return `harnesst-home-${sanitized}-${slug}`;
};

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("docker", args, {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    throw normalizeDockerCliError(error, `run \`docker ${args[0] ?? ""}\``);
  }
}

type DockerRunner = (args: string[]) => Promise<string>;

function isMissingDockerObject(error: unknown): boolean {
  return /No such (container|object)|not found/i.test(commandErrorText(error));
}

/** Control-plane Postgres connection info, for provisioning per-instance databases. */
function controlPlaneUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL not set.");
  return new URL(raw);
}

/** Create the environment's world database if absent; return the URL the container uses. */
async function provisionWorldDb(worldKey: string): Promise<string> {
  const cp = controlPlaneUrl();
  const dbName = worldDbName(worldKey);
  const admin = postgres(cp.toString(), { max: 1 });
  try {
    const existing =
      await admin`select 1 from pg_database where datname = ${dbName}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
  // URL the *container* uses: same creds, host reachable from inside Docker, world DB.
  const url = new URL(cp.toString());
  url.hostname = DB_HOST_FROM_CONTAINER;
  url.port = cp.port || "5432";
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * List the durable eve sessions in an environment's Workflow world (issue #119). The world is a
 * Postgres database on the SAME control-plane server (host stays as-is — this runs on the control
 * plane, not inside a container, so unlike `provisionWorldDb` it does NOT swap to
 * DB_HOST_FROM_CONTAINER). Sessions are `workflow.workflow_runs` rows named
 * `workflow//eve//workflowEntry`; eve tags them with framework-owned `$eve.*` attributes. The
 * table's timestamps are `timestamp WITHOUT time zone` in UTC, so read them `at time zone 'utc'`
 * for correct Dates. A world may not exist yet (never deployed) or predate the table — treat
 * `invalid_catalog_name` (3D000) and `undefined_table` (42P01) as "no sessions", returning [].
 */
async function listWorldSessions(
  worldKey: string,
  opts?: { since?: Date },
): Promise<WorldSessionSummary[]> {
  const cp = controlPlaneUrl();
  const url = new URL(cp.toString());
  url.pathname = `/${worldDbName(worldKey)}`;
  const sql = postgres(url.toString(), { max: 1 });
  try {
    const since = opts?.since ?? null;
    // `timestamp WITHOUT time zone AT TIME ZONE 'utc'` yields a timestamptz for the stored UTC
    // wall-clock instant, which postgres.js hands back as a correct JS Date — no manual parsing.
    const rows = await sql<
      {
        id: string;
        trigger: string | null;
        title: string | null;
        status: string;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      select
        id,
        attributes->>'$eve.trigger' as trigger,
        attributes->>'$eve.title' as title,
        status,
        (created_at at time zone 'utc') as created_at,
        (updated_at at time zone 'utc') as updated_at
      from workflow.workflow_runs
      where name = 'workflow//eve//workflowEntry'
        and coalesce(attributes->>'$eve.type', 'session') = 'session'
        ${since ? sql`and created_at >= ${since.toISOString()}::timestamp` : sql``}
      order by created_at asc
    `;
    return rows.map((r) => ({
      sessionId: r.id,
      trigger: r.trigger ?? undefined,
      title: r.title ?? undefined,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "3D000" || code === "42P01") return []; // world absent / no runs table yet
    throw error;
  } finally {
    await sql.end();
  }
}

async function dropWorldDb(worldKey: string): Promise<void> {
  const cp = controlPlaneUrl();
  const admin = postgres(cp.toString(), { max: 1 });
  try {
    await admin.unsafe(
      `drop database if exists "${worldDbName(worldKey)}" (force)`,
    );
  } catch {
    // best-effort cleanup
  } finally {
    await admin.end();
  }
}

async function removeIfExists(name: string): Promise<void> {
  try {
    await docker(["rm", "-f", name]);
  } catch (error) {
    if (isMissingDockerObject(error)) return;
    throw error;
  }
}

async function inspectRunning(name: string): Promise<boolean | null> {
  try {
    const state = await docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      name,
    ]);
    return state === "true";
  } catch (error) {
    if (isMissingDockerObject(error)) return null;
    throw error;
  }
}

/**
 * Run the Workflow World's schema migrations against the instance DB, using the build-stage
 * image (the migration CLI + SQL files are not traced into the runtime .output).
 * Skipped when no build-stage image exists (e.g. a plain test image), since such an image
 * cannot be an eve agent needing a World.
 */
export const WORLD_POSTGRES_SETUP_SCRIPT =
  "node_modules/@workflow/world-postgres/bin/setup.js";

const WORLD_POSTGRES_REACHABILITY_SCRIPT = `
const url = new URL(process.env.WORKFLOW_POSTGRES_URL);
const target = url.hostname + ":" + (url.port || "5432");
const socket = require("node:net").createConnection({
  host: url.hostname,
  port: Number(url.port || 5432),
});
socket.setTimeout(5000);
socket.once("connect", () => socket.end());
socket.once("timeout", () =>
  socket.destroy(new Error("timed out connecting to " + target)),
);
socket.once("error", (error) => {
  console.error(
    "[deploy] cannot reach Postgres at " + target + ": " + error.message,
  );
  process.exitCode = 1;
});
`;

export async function runWorldMigrations(
  imageRef: string,
  dbUrl: string,
  runDocker: DockerRunner = docker,
): Promise<void> {
  const buildTag = buildStageTagFor(imageRef);
  try {
    await runDocker(["image", "inspect", buildTag]);
  } catch {
    return; // no build-stage image — nothing to migrate
  }

  try {
    await runDocker([
      "run",
      "--rm",
      buildTag,
      "test",
      "-f",
      WORLD_POSTGRES_SETUP_SCRIPT,
    ]);
  } catch {
    console.warn(
      `[deploy] ${WORLD_POSTGRES_SETUP_SCRIPT} not found in ${buildTag}; skipping Workflow world migrations.`,
    );
    return;
  }

  await runDocker([
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `WORKFLOW_POSTGRES_URL=${dbUrl}`,
    buildTag,
    "node",
    "-e",
    WORLD_POSTGRES_REACHABILITY_SCRIPT,
  ]);

  await runDocker([
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `WORKFLOW_POSTGRES_URL=${dbUrl}`,
    buildTag,
    "node",
    WORLD_POSTGRES_SETUP_SCRIPT,
  ]);
}

/**
 * Poll the instance's HTTP endpoint until it responds or the timeout elapses.
 * If Docker reports the container has already exited, stop waiting immediately:
 * a dead instance cannot become healthy, and the logs now contain the useful error.
 */
async function waitForHealth(
  url: string,
  timeoutMs: number,
  stillRunning?: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    if (stillRunning && !(await stillRunning())) return false;
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

/**
 * Tail of a container's logs, for health-failure errors: when `eve start`'s prewarm (or the
 * server) dies, the REAL cause — a failed bootstrap, a bad image, a missing env — is in the
 * logs, and "container did not become healthy" alone is undebuggable from harnesst's UI.
 */
async function containerLogsTail(name: string, lines = 40): Promise<string> {
  try {
    // Container stderr comes back on stderr — capture both streams, in that order.
    const { stdout, stderr } = await exec(
      "docker",
      ["logs", "--tail", String(lines), name],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return (
      [stderr.trim(), stdout.trim()].filter(Boolean).join("\n") ||
      "(no container logs)"
    );
  } catch (error) {
    return `(could not read container logs: ${commandErrorText(error)})`;
  }
}

export const localDockerTarget: DeployTarget = {
  name: "local-docker",

  async build(req: BuildRequest): Promise<BuiltArtifact> {
    if (!req.installationId) {
      throw new Error(
        `local-docker build for ${req.repo.owner}/${req.repo.repo}@${req.ref.slice(0, 7)} ` +
          "needs a GitHub App installation on the repo to fetch its source.",
      );
    }
    return buildEveImage({
      projectId: req.projectId,
      repo: req.repo,
      ref: req.ref,
      installationId: req.installationId,
      agentRoot: req.agentRoot,
      injectTeammateTool: req.injectTeammateTool,
    });
  },

  async checkBuild(req) {
    if (!req.installationId) {
      return { ok: true as const, skipped: true }; // can't fetch source — don't block publish
    }
    return buildStagedTree({
      projectId: req.projectId,
      repo: req.repo,
      ref: req.ref,
      installationId: req.installationId,
      overlay: req.overlay,
      agentRoot: req.agentRoot,
      taskId: req.taskId,
      injectTeammateTool: req.injectTeammateTool,
    });
  },

  async deploy(req: DeployRequest): Promise<InstanceHealth> {
    if (!req.imageRef) {
      return {
        status: "failed",
        detail: "no image to run (build did not produce one)",
      };
    }
    const name = containerName(req.deploymentId);
    await removeIfExists(name);

    // Keyed by environment (req.worldKey), so a redeploy reuses the same world — sessions and
    // their sandbox containers survive. During a cutover the old-live and new deployments
    // briefly share this world DB; that is eve's normal multi-instance mode (Vercel runs many
    // function instances against one world), so concurrent access here is expected, not a race.
    const dbUrl = await provisionWorldDb(req.worldKey);
    await runWorldMigrations(req.imageRef, dbUrl);
    // The Postgres World reads WORKFLOW_POSTGRES_URL; DATABASE_URL kept for authored tools.
    const envArgs = Object.entries({
      ...req.env,
      WORKFLOW_POSTGRES_URL: dbUrl,
      DATABASE_URL: dbUrl,
      PORT: String(INSTANCE_PORT),
      // Point eve at the shim (eve-image.server.ts) and tell it which volume is this
      // environment's agent home. AFTER the req.env spread so user secrets can never shadow them.
      EVE_DOCKER_PATH: "/usr/local/bin/eve-docker",
      HARNESST_HOME_VOLUME: homeVolumeName(req.worldKey),
      // The assistant checkout sidecar binds this port inside the container; the published mapping
      // below uses the same value, so `auxEndpoint` can find it. Ignored by non-assistant images.
      HARNESST_AUX_PORT: String(AUX_PORT),
    }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    await docker([
      "run",
      "-d",
      // A real init as PID 1: the CMD is the eve bin directly (it handles SIGTERM, but an
      // init both guarantees signal delivery and reaps the zombies its child tree can leave).
      "--init",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      // Docker-outside-of-docker: the eve runtime reaches the host daemon over this socket to
      // spawn sibling sandbox containers, which is what lets defaultBackend() pick the real
      // Docker sandbox instead of just-bash. Standard socket path on Docker Desktop/OrbStack/Colima.
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      // Mount the environment's agent-home volume into the INSTANCE too (the eve-docker shim only
      // mounts it into session sandboxes). The assistant sidecar clones per-conversation checkouts
      // under /workspace/home/checkouts so both the instance and the model's sandbox see one shared
      // tree. Benign for non-assistant instances (nothing writes there).
      "-v",
      `${homeVolumeName(req.worldKey)}:/workspace/home`,
      "-p",
      `127.0.0.1:0:${INSTANCE_PORT}`,
      // Second published port for the assistant checkout sidecar (loopback-bound on the host).
      "-p",
      `127.0.0.1:0:${AUX_PORT}`,
      ...envArgs,
      req.imageRef,
    ]);

    const hostPort = await docker([
      "inspect",
      "--format",
      `{{(index (index .NetworkSettings.Ports "${INSTANCE_PORT}/tcp") 0).HostPort}}`,
      name,
    ]);
    const url = `http://127.0.0.1:${hostPort}`;

    const healthy = await waitForHealth(
      url,
      DEPLOY_HEALTH_TIMEOUT_MS,
      async () => (await inspectRunning(name)) === true,
    );
    if (healthy) return { status: "live", url };
    return {
      status: "failed",
      url,
      detail:
        `container did not become healthy within ${DEPLOY_HEALTH_TIMEOUT_MS / 1000}s. ` +
        `Last container logs:\n${await containerLogsTail(name)}`,
    };
  },

  async stop(deploymentId: string): Promise<void> {
    const name = containerName(deploymentId);
    const before = await inspectRunning(name);
    if (before === null || before === false) return;
    await docker(["stop", name]);
    const after = await inspectRunning(name);
    if (after === true) {
      throw new Error(`container ${name} is still running after docker stop`);
    }
  },

  async start(deploymentId: string): Promise<InstanceHealth> {
    const name = containerName(deploymentId);
    await docker(["start", name]);
    const hostPort = await docker([
      "inspect",
      "--format",
      `{{(index (index .NetworkSettings.Ports "${INSTANCE_PORT}/tcp") 0).HostPort}}`,
      name,
    ]);
    const url = `http://127.0.0.1:${hostPort}`;
    const healthy = await waitForHealth(
      url,
      WAKE_HEALTH_TIMEOUT_MS,
      async () => (await inspectRunning(name)) === true,
    );
    if (healthy) return { status: "live", url };
    return {
      status: "failed",
      url,
      detail:
        `container did not become healthy within ${WAKE_HEALTH_TIMEOUT_MS / 1000}s. ` +
        `Last container logs:\n${await containerLogsTail(name)}`,
    };
  },

  async health(deploymentId: string): Promise<InstanceHealth> {
    const name = containerName(deploymentId);
    try {
      const running = await inspectRunning(name);
      if (running === null)
        return { status: "stopped", detail: "no container" };
      return { status: running ? "live" : "stopped" };
    } catch (error) {
      return { status: "failed", detail: commandErrorText(error) };
    }
  },

  async auxEndpoint(deploymentId: string): Promise<string | null> {
    // The sidecar's host-published port for this container (127.0.0.1-bound). Absent for images
    // that don't publish AUX_PORT (a pre-sidecar container), or when the container is gone.
    const name = containerName(deploymentId);
    try {
      const hostPort = await docker([
        "inspect",
        "--format",
        `{{with (index .NetworkSettings.Ports "${AUX_PORT}/tcp")}}{{(index . 0).HostPort}}{{end}}`,
        name,
      ]);
      if (!hostPort) return null;
      return `http://127.0.0.1:${hostPort}`;
    } catch {
      return null;
    }
  },

  listWorldSessions,

  async destroy(deploymentId: string): Promise<void> {
    // Per-deployment teardown removes ONLY this deployment's container. The world DB is shared
    // across the environment's deployments now, so dropping it here would orphan siblings'
    // sessions — that is `destroyWorld`'s job, run once after the whole environment is gone.
    await removeIfExists(containerName(deploymentId));
  },

  async destroyWorld(worldKey: string): Promise<void> {
    // Environment/repository teardown, after every deployment's `destroy`: no instance of this
    // environment survives to need its sessions, so tear the whole world down.
    //   1. drop the shared world database (the sessions);
    //   2. reap this env's sibling sandbox containers — they are exactly the ones mounting this
    //      env's home volume, so a `volume=` filter finds them (also a slice of the M6.1 sandbox-GC
    //      punt: those stopped containers were otherwise orphaned);
    //   3. remove the home volume itself.
    // Each step is best-effort and independent — a failure in one must not strand the others.
    await dropWorldDb(worldKey);
    const volume = homeVolumeName(worldKey);
    try {
      const ids = await docker(["ps", "-aq", "--filter", `volume=${volume}`]);
      const containers = ids
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (containers.length > 0) {
        try {
          await docker(["rm", "-f", ...containers]);
        } catch {
          // best-effort: leave the volume rm to still try
        }
      }
    } catch {
      // best-effort: docker unavailable or no matches
    }
    try {
      await docker(["volume", "rm", volume]);
    } catch {
      // best-effort: volume may never have been created, or still referenced
    }
  },
};
