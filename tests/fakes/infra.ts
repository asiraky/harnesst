/**
 * Fakes for the infra seams the deploy controller drives (DeployTarget, SecretsProvider), so
 * deployRelease can be unit-tested without docker or a secrets store.
 */
import type {
  DeployTarget,
  InstanceHealth,
  SecretsProvider,
} from "~/seams/types";

/**
 * A DeployTarget whose deploy() resolves to `health` — or, if constructed with an error,
 * throws it (to exercise the controller's failure-recording path, like the real container
 * target does when docker is unavailable).
 */
export function fakeDeployTarget(
  opts: {
    health?: InstanceHealth;
    deployError?: string;
    buildImageRef?: string;
    stopError?: string;
    /** Captures the image refs produced by build(), for cache/rebuild assertions. */
    builtRefs?: string[];
    /** Captures the env each deploy() received, for injection assertions. */
    deployedEnvs?: Record<string, string>[];
    /** Captures stopped deployment ids for cleanup/cutover assertions. */
    stoppedIds?: string[];
    /** Captures destroyed deployment ids for cleanup/cutover assertions. */
    destroyedIds?: string[];
    /** Captures each deploy()'s worldKey, for the durability (env-keyed world) invariant. */
    deployedWorldKeys?: string[];
    /** Captures worldKeys passed to destroyWorld() on env/repo teardown. */
    destroyedWorlds?: string[];
    /** False simulates a cached image built before a requested platform capability shipped. */
    imageSupports?: boolean;
    /** Captures whether each deploy requested the session-workspace boundary. */
    isolatedWorkspaces?: boolean[];
  } = {},
): DeployTarget {
  const stopped = new Set<string>();
  return {
    name: "fake",
    async build() {
      const imageRef = opts.buildImageRef ?? "img:fake";
      opts.builtRefs?.push(imageRef);
      return { imageRef, digest: "sha256:fake" };
    },
    async imageSupports() {
      return opts.imageSupports ?? true;
    },
    async deploy(req): Promise<InstanceHealth> {
      opts.deployedEnvs?.push(req.env);
      opts.deployedWorldKeys?.push(req.worldKey);
      opts.isolatedWorkspaces?.push(req.isolateSessionWorkspace === true);
      if (opts.deployError) throw new Error(opts.deployError);
      return opts.health ?? { status: "live", url: "http://fake.local" };
    },
    async stop(id) {
      if (opts.stopError) throw new Error(opts.stopError);
      opts.stoppedIds?.push(id);
      stopped.add(id);
    },
    async destroy(id) {
      opts.destroyedIds?.push(id);
      stopped.add(id);
    },
    async destroyWorld(worldKey) {
      opts.destroyedWorlds?.push(worldKey);
    },
    async start() {
      return { status: "live" };
    },
    async health(id) {
      if (stopped.has(id)) return { status: "stopped" };
      return opts.health ?? { status: "live" };
    },
  };
}

/** A no-op SecretsProvider that resolves an (optional) fixed env map. */
export function fakeSecrets(env: Record<string, string> = {}): SecretsProvider {
  return {
    name: "fake",
    async set() {},
    async get() {
      return null;
    },
    async delete() {},
    async listNames() {
      return [];
    },
    async resolve() {
      return env;
    },
  };
}
