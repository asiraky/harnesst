/**
 * Leaked schedule-sandbox reaper (issue #118).
 *
 * In prod, eve's hourly schedule fires and creates a session sandbox container each time — but the
 * cron turn stalls BEFORE its first model/tool step: no command is ever exec'd in the sandbox
 * (`docker top` shows only the keeper `sleep 2147483647`), no run row ever reaches harnesst, and the
 * idle `Up` sandbox containers accumulate forever. eve owns the stall (harnesst policy: never patch or
 * fork eve — see docs/upstream/eve-cron-stall-report.md); harnesst's job is to (a) stop the containers
 * leaking and (b) make the failure class visible without docker archaeology.
 *
 * Scope — deliberately narrow. This reaps ONLY containers carrying BOTH
 *   eve.sandbox.role=session  AND  eve.sandbox.tag.channel=schedule
 * that also mount a harnesst-owned home volume (a Mount whose Name starts `harnesst-home-`). Schedule
 * sessions are one-shot fire-and-forget — nothing ever resumes them, so a stalled/finished one is
 * always safe to remove. Every OTHER channel (playground / discord / assistant) can be resumed and
 * is never touched, and template-build containers (a different role) are out of scope too.
 *
 * TRIPWIRE (same shape as the eve-docker shim's): the label names are eve's, not harnesst's. If a future
 * eve upgrade renames `eve.sandbox.role` / `eve.sandbox.tag.channel`, the `ps` filter simply matches
 * nothing and the sweep becomes a no-op — leaks would return, but nothing breaks. Graceful
 * degradation over a hard dependency on private label strings.
 *
 * Signals (all docker-observable + harnesst's own DB — the Workflow world DBs are empty on this host, so
 * a "session has no steps" query is not viable):
 *   - RUNNING candidate, older than the ceiling, with EMPTY ExecIDs → the stall signature. An
 *     in-flight `docker exec` (ExecIDs non-empty) is real work and spares the container. Reaping one
 *     of these ALSO records a synthetic `failed` run so the stall shows up in the Runs UI.
 *   - EXITED candidate, finished longer ago than the ceiling → GC only (it may be a legitimately
 *     finished turn; removed silently, no synthetic run). Closes the schedule slice of the PRD M6.1
 *     sandbox-GC punt.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ingestRun } from "~/observability/store.server";
import type { DataStore } from "~/data/ports";
import { getRuntime } from "~/seams/index.server";
import { homeVolumeName } from "~/seams/oss/deploy.localdocker.server";

const exec = promisify(execFile);

/** How often the reaper sweeps for leaked schedule sandboxes. */
export const SANDBOX_REAP_SWEEP_MS = Number(
  process.env.HARNESST_SANDBOX_REAP_SWEEP_MS || 5 * 60 * 1000,
);

/**
 * Age (running: since Created; exited: since FinishedAt) past which a leaked schedule sandbox is
 * reaped. Generous by default so a legitimately slow first step is never mistaken for a stall.
 */
export const SANDBOX_REAP_CEILING_MS = Number(
  process.env.HARNESST_SANDBOX_REAP_CEILING_MS || 45 * 60 * 1000,
);

const SESSION_ROLE_LABEL = "eve.sandbox.role=session";
const SCHEDULE_CHANNEL_LABEL = "eve.sandbox.tag.channel=schedule";
const HOME_VOLUME_PREFIX = "harnesst-home-";
/** Docker's zero value for an unset FinishedAt — treat as "never finished". */
const DOCKER_ZERO_TIME = "0001-01-01T00:00:00Z";

/** The subset of `docker inspect` fields the sweep reads. */
interface InspectedContainer {
  Id: string;
  Name: string;
  Created: string;
  State?: { Status?: string; FinishedAt?: string };
  ExecIDs?: string[] | null;
  Config?: { Labels?: Record<string, string> | null };
  Mounts?: { Name?: string }[];
}

type DockerRunner = (args: string[]) => Promise<string>;
type RecordRun = (projectId: string, payload: Parameters<typeof ingestRun>[1]) => Promise<void>;

async function realDocker(args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface SandboxReaperDeps {
  store: DataStore;
  runDocker: DockerRunner;
  recordRun: RecordRun;
  now?: () => Date;
}

function reaperDeps(): SandboxReaperDeps {
  return {
    store: getRuntime().data,
    runDocker: realDocker,
    recordRun: ingestRun,
  };
}

export interface SandboxReapResult {
  scanned: number;
  reaped: number;
  recorded: number;
  spared: number;
  /** Set when docker was unavailable / the sweep soft-failed; nothing was reaped. */
  error?: string;
}

/** The harnesst-home volume mounted by this sandbox, if any (its owning environment's home). */
function homeVolumeOf(c: InspectedContainer): string | null {
  for (const m of c.Mounts ?? []) {
    if (m.Name && m.Name.startsWith(HOME_VOLUME_PREFIX)) return m.Name;
  }
  return null;
}

/** ms since a container's Created (running) or effective FinishedAt (exited), or null if unparseable. */
function ageMs(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/**
 * One sweep: list schedule session sandboxes, inspect them, reap the leaked ones, and record a
 * synthetic failed run for each reaped RUNNING (stalled) sandbox whose home volume maps to a known
 * environment. Never throws — docker being unavailable is a soft-fail, so the interval keeps ticking.
 */
export async function sweepLeakedSandboxes(
  deps: SandboxReaperDeps = reaperDeps(),
): Promise<SandboxReapResult> {
  const { store, runDocker, recordRun } = deps;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const empty: SandboxReapResult = { scanned: 0, reaped: 0, recorded: 0, spared: 0 };

  let ids: string[];
  try {
    const out = await runDocker([
      "ps",
      "-a",
      "--filter",
      `label=${SESSION_ROLE_LABEL}`,
      "--filter",
      `label=${SCHEDULE_CHANNEL_LABEL}`,
      "--format",
      "{{.ID}}",
    ]);
    ids = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[reaper] sandbox sweep skipped: docker ps failed: ${msg}`);
    return { ...empty, error: msg };
  }
  if (ids.length === 0) return empty;

  let inspected: InspectedContainer[];
  try {
    const out = await runDocker(["inspect", ...ids]);
    inspected = JSON.parse(out) as InspectedContainer[];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[reaper] sandbox sweep skipped: docker inspect failed: ${msg}`);
    return { ...empty, error: msg };
  }

  // Map every environment's home-volume name back to the environment, so a reaped stalled sandbox
  // can be attributed to its project. Best-effort — an unknown volume is still reaped, just silently.
  const envByVolume = new Map<string, { id: string; projectId: string }>();
  try {
    for (const env of await store.environments.listAll()) {
      envByVolume.set(homeVolumeName(env.id), { id: env.id, projectId: env.projectId });
    }
  } catch (error) {
    // A DB hiccup must not strand the docker GC — we just lose run attribution for this sweep.
    console.warn(
      `[reaper] could not load environments for run attribution: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  interface Reapable {
    c: InspectedContainer;
    volume: string;
    running: boolean;
    ageMinutes: number;
  }
  const toReap: Reapable[] = [];
  let spared = 0;

  for (const c of inspected) {
    const volume = homeVolumeOf(c);
    if (!volume) {
      // Not a harnesst-owned sandbox (another checkout's, or an unmounted one) — leave it alone.
      spared++;
      continue;
    }
    const status = c.State?.Status ?? "";
    if (status === "running") {
      const execIds = c.ExecIDs ?? [];
      const age = ageMs(c.Created, now);
      // A live `docker exec` is real work in flight — spare it. A stalled cron sandbox never has one.
      if (execIds.length > 0 || age == null || age <= SANDBOX_REAP_CEILING_MS) {
        spared++;
        continue;
      }
      toReap.push({ c, volume, running: true, ageMinutes: Math.round(age / 60000) });
    } else {
      // Exited: age from FinishedAt, falling back to Created when docker left it at the zero time.
      const finished = c.State?.FinishedAt;
      const src = finished && finished !== DOCKER_ZERO_TIME ? finished : c.Created;
      const age = ageMs(src, now);
      if (age == null || age <= SANDBOX_REAP_CEILING_MS) {
        spared++;
        continue;
      }
      toReap.push({ c, volume, running: false, ageMinutes: Math.round(age / 60000) });
    }
  }

  if (toReap.length === 0) {
    return { scanned: inspected.length, reaped: 0, recorded: 0, spared };
  }

  try {
    await runDocker(["rm", "-f", ...toReap.map((r) => r.c.Id)]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[reaper] docker rm -f failed for ${toReap.length} sandbox(es): ${msg}`);
    return { scanned: inspected.length, reaped: 0, recorded: 0, spared, error: msg };
  }

  let recorded = 0;
  for (const r of toReap) {
    const labels = r.c.Config?.Labels ?? {};
    const sessionId = labels["eve.sandbox.tag.sessionId"];
    const channel = labels["eve.sandbox.tag.channel"] ?? "schedule";
    const agent = labels["eve.sandbox.tag.agent"];
    console.log(
      `[reaper] reaped ${r.running ? "stalled" : "exited"} schedule sandbox ${r.c.Name} ` +
        `(channel=${channel} session=${sessionId ?? "?"} age=${r.ageMinutes}m)`,
    );

    // Synthetic run ONLY for a reaped RUNNING sandbox: that is the in-flight-stall signature. An
    // exited one may be a legitimately finished turn, so it is GC'd silently (no run row).
    if (!r.running) continue;
    const env = envByVolume.get(r.volume);
    if (!env || !sessionId) continue; // unknown env / no session id → reaped, but not attributable

    try {
      await recordRun(env.projectId, {
        externalRunId: `reaped:${sessionId}`,
        channel,
        status: "failed",
        startedAt: r.c.Created,
        finishedAt: new Date(now).toISOString(),
        error:
          `Scheduled run produced no activity for ${r.ageMinutes} minutes before its sandbox was ` +
          `reaped; the turn stalled before its first step (issue #118).`,
        metadata: { reapedSandbox: true, container: r.c.Name, agent },
        session: { externalSessionId: sessionId, channel, trigger: "schedule" },
      });
      recorded++;
    } catch (error) {
      // Best-effort telemetry: a recording failure must never fail the sweep (the container is gone).
      console.warn(
        `[reaper] failed to record synthetic run for ${r.c.Name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { scanned: inspected.length, reaped: toReap.length, recorded, spared };
}

function startSandboxReaper(): { stop: () => void } {
  let running = false;
  const interval = setInterval(async () => {
    if (running) return; // never stack sweeps
    running = true;
    try {
      await sweepLeakedSandboxes();
    } catch (err) {
      // sweepLeakedSandboxes soft-fails internally; this only catches an unexpected programming error.
      console.error("[reaper] sandbox sweep threw:", err);
    } finally {
      running = false;
    }
  }, SANDBOX_REAP_SWEEP_MS);
  interval.unref?.();
  console.log(
    `[reaper] sandbox reaper started (sweep ${SANDBOX_REAP_SWEEP_MS}ms, ceiling ${SANDBOX_REAP_CEILING_MS}ms)`,
  );
  return { stop: () => clearInterval(interval) };
}

const globalForReaper = globalThis as unknown as {
  __harnesstSandboxReaper?: { stop: () => void };
};

/**
 * Start the sandbox reaper once per process. Gated OFF unless the deploy target is local-docker
 * (only that target spawns host sandbox containers harnesst can see) and not explicitly disabled. Safe
 * to call from any server module; called from ensureWorkerStarted so every start site gets it.
 */
export function ensureSandboxReaperStarted(): void {
  if (process.env.HARNESST_DISABLE_SANDBOX_REAPER === "1") return;
  if (getRuntime().deployTarget.name !== "local-docker") return;
  globalForReaper.__harnesstSandboxReaper ??= startSandboxReaper();
}
