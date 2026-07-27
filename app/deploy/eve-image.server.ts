/**
 * eve repo → Docker image build pipeline (validated end-to-end against eve).
 *
 * Fetch the repo tarball at a commit (GitHub App) → extract to a scratch dir → ensure harnesst's
 * reference multi-stage Dockerfile (respecting one the repo already has) → `docker build`.
 *
 * Two images are produced per build:
 *   <tag>        runtime — the build stage plus the eve-docker shim and the `eve start` CMD
 *   <tag>-build  the full build stage (node_modules incl. @workflow/world-postgres) — kept
 *                because the world's migration CLI (`workflow-postgres-setup`) is NOT traced
 *                into .output; per-instance DB setup runs from this image at deploy time.
 *
 * The build runs entirely inside linux containers, so the host needs Docker but not Node 24
 * or the eve toolchain, and native modules are traced for the right platform.
 *
 * WHY the image boots `eve start`, not `node .output/server/index.mjs`: `eve start` runs eve's
 * sandbox-template prewarm BEFORE the Nitro server binds its port. An agent whose sandbox has a
 * non-null template key — a bootstrap() hook, or workspace resources (a skills/ directory
 * counts) — needs its `eve-sbx-tpl-*` template image built on the daemon; eve's docker backend
 * refuses to create session sandboxes until it exists (SandboxTemplateNotProvisionedError), the
 * runtime's self-heal retry is disabled for built/bundled servers, and `eve build` only prewarms
 * on Vercel. Off-Vercel, `eve start` is the only supported prewarm path — booting the raw Nitro
 * entry left every skills-carrying agent permanently unable to use its bash/file tools.
 *
 * That is also why the final stage inherits the FULL build stage instead of copying .output into
 * a fresh node image: `eve start` needs node_modules, package.json, and the `.eve/compile`
 * artifacts `eve build` wrote in-stage. The deploy pipeline already retains the build stage as
 * the `-build` tag, so the layers are shared and the extra disk cost is ~zero.
 *
 * The runtime image also ships the static Docker CLI *client* (no daemon) at
 * /usr/local/bin/docker. eve's `defaultBackend()` gives an agent a real sandbox only when a
 * docker CLI + a reachable daemon are both present; without the client it silently degrades to
 * `just-bash` (a pure-JS bash that can't run git/node/npm). The deploy target mounts the host's
 * Docker socket (deploy.localdocker.server.ts), so the client + socket together let eve pick the
 * real Docker sandbox backend — no change to customer repos required.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getInstallationOctokit } from "~/github/client.server";
import { lowercaseLegacyId } from "~/lib/id";
import {
  HARNESST_RUN_HOOK_PATH,
  HARNESST_RUN_HOOK_SOURCE,
} from "~/observability/run-hook-template";
import type { BuiltArtifact } from "~/seams/types";
import {
  ASK_TEAMMATE_TOOL_PATH,
  ASK_TEAMMATE_TOOL_SOURCE,
} from "~/team/tool-template";
import {
  assertDockerDaemonReady,
  commandErrorText,
  isDockerUnavailableError,
  normalizeDockerCliError,
} from "./docker.server";

const exec = promisify(execFile);

/**
 * Reference multi-stage Dockerfile for an eve agent. The build stage must keep full
 * node_modules (see module docs); the runtime stage inherits it so `eve start` can prewarm.
 */
const DOCKER_CLI_VERSION = "27.5.1";

/**
 * The `EVE_DOCKER_PATH` shim (M6.2 — agent home across sessions). Baked into the runtime image
 * at /usr/local/bin/eve-docker; the deploy target points eve's `EVE_DOCKER_PATH` at it.
 *
 * WHY a shim, not a real mount option: eve's `docker()` sandbox backend exposes only
 * { image, env, networkPolicy, pullPolicy } — no `mounts` (verified in vercel/eve source). The
 * owner rejected upstreaming a mounts option, so harnesst interposes on the docker CLI eve already
 * shells out to. eve gives each *durable session* a fresh /workspace from a template; there is no
 * per-*agent* filesystem. This shim gives one: it mounts a harnesst-managed named volume at
 * /workspace/home on exactly the session sandbox containers.
 *
 * WHAT it matches: the stable label pair eve stamps on a session container's `docker run` —
 * `--label eve.sandbox.role=session` (each label and value are SEPARATE argv entries). It injects
 * `-v $HARNESST_HOME_VOLUME:/workspace/home` right after the `run` token, argv otherwise untouched.
 * template-build runs (`--label eve.sandbox.role=template-build`) are SHARED across sessions and
 * must NOT capture an agent's volume, so they pass through unmodified — as does every non-`run`
 * verb (start/exec/cp/stop/rm) and any run without the session label or with HARNESST_HOME_VOLUME unset.
 *
 * FAILURE MODE (a deliberate, PRD-documented tripwire): if a future eve upgrade renames that label,
 * this shim simply stops matching — no injection happens, sandboxes still run normally, agent homes
 * just quietly stop mounting. It degrades to the pre-6.2 behaviour rather than breaking deploys.
 *
 * The image's default user is root (`ghcr.io/vercel/eve:latest` sets no USER), so the root-owned
 * /workspace/home mount is already writable — no chown step needed.
 *
 * REAL is overridable via EVE_DOCKER_REAL purely so the unit test can point it at a fake docker;
 * in production it is the static client this same image ships at /usr/local/bin/docker. Pure POSIX
 * sh (runtime is node:24-slim → dash): no bashisms, argv rebuilt with `set --`, `exec` so exit
 * codes and stdio stream through unchanged.
 */
export const EVE_DOCKER_SHIM = `#!/bin/sh
# eve-docker — harnesst's EVE_DOCKER_PATH shim (rationale in eve-image.server.ts).
REAL="\${EVE_DOCKER_REAL:-/usr/local/bin/docker}"

# Scan argv for eve's session-container label pair (separate argv entries). While here, also
# capture the channel/sessionId tag labels so a session-sandbox start is visible in the instance
# log (issue #118: cron turns stall BEFORE their first step, so their sandbox is the only trace).
is_session=0
sbx_channel=""
sbx_session=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--label" ]; then
    [ "$a" = "eve.sandbox.role=session" ] && is_session=1
    case "$a" in
      eve.sandbox.tag.channel=*) sbx_channel="\${a#eve.sandbox.tag.channel=}" ;;
      eve.sandbox.tag.sessionId=*) sbx_session="\${a#eve.sandbox.tag.sessionId=}" ;;
    esac
  fi
  prev="$a"
done

if [ "$1" = "run" ] && [ "$is_session" = "1" ]; then
  # STDERR only: eve reads \`run -d\`'s STDOUT for the container id — never pollute it.
  echo "[harnesst] session sandbox starting: channel=\${sbx_channel} session=\${sbx_session}" >&2
  if [ -n "$HARNESST_HOME_VOLUME" ]; then
    # Inject the agent's home volume immediately after the run token; keep every other arg in order.
    shift
    set -- run -v "$HARNESST_HOME_VOLUME:/workspace/home" "$@"
    exec "$REAL" "$@"
  fi
fi

exec "$REAL" "$@"
`;

// base64 so the multi-line script survives both JS-template and Dockerfile quoting untouched
// (the base64 alphabet has no shell-significant chars); decoded back into place at image build.
const EVE_DOCKER_SHIM_B64 = Buffer.from(EVE_DOCKER_SHIM, "utf8").toString(
  "base64",
);

export const HARNESST_EVE_DOCKERFILE = `# Generated by harnesst (reference eve agent image).
FROM node:24-slim AS build
WORKDIR /app
# Static Docker CLI *client* (no daemon): eve's defaultBackend() needs a docker CLI + a
# reachable daemon (the mounted host socket) to give the agent a real sandbox instead of
# just-bash. Downloaded here; the runtime stage inherits this stage, CLI included. Debian
# arch → download.docker.com arch: amd64→x86_64, arm64→aarch64; fail loudly otherwise.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \\
  && rm -rf /var/lib/apt/lists/* \\
  && case "$(dpkg --print-architecture)" in \\
       amd64) DOCKER_ARCH=x86_64 ;; \\
       arm64) DOCKER_ARCH=aarch64 ;; \\
       *) echo "unsupported arch for docker CLI: $(dpkg --print-architecture)" >&2; exit 1 ;; \\
     esac \\
  && curl -fsSL "https://download.docker.com/linux/static/stable/\${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \\
  && tar -xzf /tmp/docker.tgz -C /tmp \\
  && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \\
  && rm -rf /tmp/docker /tmp/docker.tgz
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm exec -- eve build

# Runtime = the build stage itself (docker CLI, node_modules, .eve/compile, .output all in
# place): \`eve start\` needs the full toolchain to prewarm sandbox templates before the Nitro
# server binds its port (see module docs). The -build tag harnesst also keeps IS this stage, so
# inheriting it shares every heavy layer instead of duplicating them into a fresh image.
FROM build
WORKDIR /app
# eve-docker shim (EVE_DOCKER_PATH): mounts the agent's home volume onto session sandboxes.
# See EVE_DOCKER_SHIM / eve-image.server.ts for why and how it degrades. base64 in, decode out.
RUN echo '${EVE_DOCKER_SHIM_B64}' | base64 -d > /usr/local/bin/eve-docker && chmod 0755 /usr/local/bin/eve-docker
ENV PORT=3000
EXPOSE 3000
# The eve bin directly — npm exec/npm run don't reliably forward SIGTERM as PID 1, and harnesst's
# scale-to-zero is a docker stop. eve's start command handles SIGTERM/SIGINT itself (it
# SIGTERMs the Nitro child, SIGKILL fallback); the deploy target adds --init for reaping.
CMD ["node_modules/.bin/eve", "start"]
`;

const HARNESST_DOCKERIGNORE = `node_modules
.output
.eve
.git
`;

/**
 * The built-in assistant's image. Identical to the reference eve image
 * except the CMD: instead of `eve start` directly, it runs the assistant entrypoint, which
 * materializes the project's published user-config layer, rebuilds if that layer is non-empty
 * (eve discovers instructions/skills/schedules at build time), then execs `eve start`.
 */
export const HARNESST_ASSISTANT_DOCKERFILE = HARNESST_EVE_DOCKERFILE.replace(
  'CMD ["node_modules/.bin/eve", "start"]',
  'CMD ["sh", "entrypoint.sh"]',
);

/**
 * Runtime + build-stage tags for a project@commit. Local (unregistried) for dev. Team
 * members build distinct images from the same commit, so the member name joins the tag.
 */
function imageTags(projectId: string, ref: string, member: string | null) {
  const suffix = member
    ? `-${member.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  // Docker repository names must be lowercase — safe for new ids, folds legacy mixed-case ones.
  const tag = `harnesst/proj-${lowercaseLegacyId(projectId.slice(0, 8))}${suffix}:${ref.slice(0, 12)}`;
  return { runtime: tag, buildStage: `${tag}-build` };
}

/**
 * Where the eve project lives inside the checkout, and the member name (team repos, PRD
 * §7.9). Root layout ("agent") builds the repo root; a team member ("agents/pm/agent")
 * builds its package directory ("agents/pm").
 */
function projectDirOf(agentRoot: string | undefined): {
  dir: string;
  member: string | null;
} {
  if (!agentRoot || agentRoot === "agent") return { dir: ".", member: null };
  const dir = path.dirname(agentRoot); // agents/<member>
  return { dir, member: path.basename(dir) };
}

/** The build-stage tag for a runtime imageRef (where the world migration CLI lives). */
export function buildStageTagFor(imageRef: string): string {
  return `${imageRef}-build`;
}

export interface EveImageBuildInput {
  projectId: string;
  repo: { owner: string; repo: string };
  /** Commit SHA to build (a Release's merge commit). */
  ref: string;
  /** GitHub App installation that can read the repo. */
  installationId: string | number;
  /** Agent directory ("agent" or "agents/<member>/agent") — selects the build directory. */
  agentRoot?: string;
  /** Bake harnesst's generated `ask-teammate` tool into the build context (Team delegation — D2). */
  injectTeammateTool?: boolean;
}

/** Fetch repo@ref into `workDir/src`, ensuring Dockerfile/.dockerignore. Returns srcDir. */
async function fetchSource(
  input: EveImageBuildInput,
  workDir: string,
): Promise<string> {
  // Repo tarball at the exact ref (GitHub App installation token).
  const octokit = await getInstallationOctokit(input.installationId);
  const res = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner: input.repo.owner,
    repo: input.repo.repo,
    ref: input.ref,
  });
  const tarPath = path.join(workDir, "src.tar.gz");
  await writeFile(tarPath, Buffer.from(res.data as ArrayBuffer));
  const srcDir = path.join(workDir, "src");
  await exec("mkdir", ["-p", srcDir]);
  // GitHub tarballs wrap everything in a single "<owner>-<repo>-<sha>/" directory.
  await exec("tar", ["-xzf", tarPath, "-C", srcDir, "--strip-components=1"]);

  // harnesst's reference Dockerfile in the directory we build (repo root, or the team
  // member's package dir), unless the repo brings its own there.
  const { dir } = projectDirOf(input.agentRoot);
  const buildDir = path.join(srcDir, dir);
  await mkdir(buildDir, { recursive: true });
  if (!existsSync(path.join(buildDir, "Dockerfile"))) {
    await writeFile(path.join(buildDir, "Dockerfile"), HARNESST_EVE_DOCKERFILE);
  }
  if (!existsSync(path.join(buildDir, ".dockerignore"))) {
    await writeFile(path.join(buildDir, ".dockerignore"), HARNESST_DOCKERIGNORE);
  }

  // Team delegation (D2): bake the generated ask-teammate tool into the member's build context,
  // never the repo. The path is relative to the build dir (the member's package dir). A repo
  // file already at that path wins — the user override is never clobbered.
  if (input.injectTeammateTool) {
    const toolPath = path.join(buildDir, ASK_TEAMMATE_TOOL_PATH);
    if (!existsSync(toolPath)) {
      await mkdir(path.dirname(toolPath), { recursive: true });
      await writeFile(toolPath, ASK_TEAMMATE_TOOL_SOURCE);
    }
  }

  // Run visibility (WS2): bake the generated run-reporting hook into EVERY build context —
  // unconditionally, because the observability gap it closes is not a per-agent feature. eve's
  // agent-level hooks fire on every channel, so one file covers github, discord, schedules and
  // whatever comes next; the container no-ops when harnesst does not inject HARNESST_RUNS_URL.
  // Same override rule as the teammate tool: a repo file already at this path wins, always.
  const runHookPath = path.join(buildDir, HARNESST_RUN_HOOK_PATH);
  if (!existsSync(runHookPath)) {
    await mkdir(path.dirname(runHookPath), { recursive: true });
    await writeFile(runHookPath, HARNESST_RUN_HOOK_SOURCE);
  }
  return srcDir;
}

/** Fetch repo@ref, ensure Dockerfile, docker-build runtime + build-stage images. */
export async function buildEveImage(
  input: EveImageBuildInput,
): Promise<BuiltArtifact> {
  await assertDockerDaemonReady("build this agent image");
  const workDir = await mkdtemp(path.join(tmpdir(), "harnesst-build-"));
  try {
    const srcDir = await fetchSource(input, workDir);
    const { dir, member } = projectDirOf(input.agentRoot);
    const buildDir = path.join(srcDir, dir);

    // Build both images (the runtime build reuses the build stage from cache).
    const tags = imageTags(input.projectId, input.ref, member);
    const opts = { maxBuffer: 64 * 1024 * 1024 };
    try {
      await exec(
        "docker",
        ["build", "--target", "build", "-t", tags.buildStage, buildDir],
        opts,
      );
      const { stderr: buildLog } = await exec(
        "docker",
        ["build", "-t", tags.runtime, buildDir],
        opts,
      );

      const { stdout: digest } = await exec("docker", [
        "inspect",
        "--format",
        "{{.Id}}",
        tags.runtime,
      ]);
      return { imageRef: tags.runtime, digest: digest.trim(), logs: buildLog };
    } catch (error) {
      if (isDockerUnavailableError(error)) {
        throw normalizeDockerCliError(error, "build this agent image");
      }
      throw new Error(
        `Agent image build failed:\n${extractBuildError(commandErrorText(error))}`,
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Build the shared assistant image from a LOCAL directory (the bundled `assistant-template/`)
 * instead of a GitHub tarball — the only difference from `buildEveImage` is the source and the
 * CMD (see `HARNESST_ASSISTANT_DOCKERFILE`). Produces the same runtime + `-build` pair so the deploy
 * target's world-migration path works unchanged. `imageRef` is the caller-chosen tag
 * (`harnesst-assistant:<template-hash>`), so the image is reused across projects and rebuilt only
 * when the template content changes.
 */
export async function buildAssistantImage(input: {
  imageRef: string;
  templateDir: string;
}): Promise<BuiltArtifact> {
  await assertDockerDaemonReady("build the assistant image");
  const workDir = await mkdtemp(path.join(tmpdir(), "harnesst-assistant-build-"));
  try {
    const buildDir = path.join(workDir, "src");
    await mkdir(buildDir, { recursive: true });
    // Copy the bundled template (contents, incl. dotfiles) into a scratch build context.
    await exec("cp", ["-R", `${input.templateDir}/.`, buildDir]);
    await writeFile(path.join(buildDir, "Dockerfile"), HARNESST_ASSISTANT_DOCKERFILE);
    await writeFile(path.join(buildDir, ".dockerignore"), HARNESST_DOCKERIGNORE);

    const buildStage = buildStageTagFor(input.imageRef);
    const opts = { maxBuffer: 64 * 1024 * 1024 };
    try {
      await exec("docker", ["build", "--target", "build", "-t", buildStage, buildDir], opts);
      const { stderr: buildLog } = await exec(
        "docker",
        ["build", "-t", input.imageRef, buildDir],
        opts,
      );
      const { stdout: digest } = await exec("docker", [
        "inspect",
        "--format",
        "{{.Id}}",
        input.imageRef,
      ]);
      return { imageRef: input.imageRef, digest: digest.trim(), logs: buildLog };
    } catch (error) {
      if (isDockerUnavailableError(error)) {
        throw normalizeDockerCliError(error, "build the assistant image");
      }
      throw new Error(
        `Assistant image build failed:\n${extractBuildError(commandErrorText(error))}`,
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The provisional tag pair a publish builds under before its commit exists: the runtime image
 * and its `-build` stage, namespaced by the publish task so concurrent projects never collide
 * and a leaked tag is attributable. Old ids can be mixed-case; docker repositories can't.
 */
function provisionalTags(input: {
  taskId?: string;
  projectId: string;
  member: string | null;
}): { runtime: string; buildStage: string } {
  const repository = input.taskId
    ? `harnesst/publish-${lowercaseLegacyId(input.taskId)}`
    : // No task (a direct call outside the pipeline): fall back to one reused per-project tag.
      "harnesst/publish-check";
  const suffix = input.member
    ? `-${input.member.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  const runtime = `${repository}:proj-${lowercaseLegacyId(input.projectId.slice(0, 8))}${suffix}`;
  return { runtime, buildStage: `${runtime}-build` };
}

/** Best-effort `docker rmi` — untags; layers shared with promoted tags survive. Never throws. */
async function untagQuietly(tags: string[]): Promise<void> {
  for (const tag of tags) {
    try {
      await exec("docker", ["rmi", tag]);
    } catch {
      // Already gone, never built, or docker is down — the reaper prunes stragglers.
    }
  }
}

/**
 * The publish build (§3.2, one build not two): build repo@ref with `overlay` files (the staged
 * drafts being published) written over the source — BOTH stages, under provisional tags — and run
 * the repo's typecheck/lint inside the build stage. The same builder as a deploy, so "ok" means
 * "this exact tree runs": after the commit lands, the pipeline promotes the provisional image to
 * the commit's runtime tag and the deploy skips its own build. Failures return the compiler's own
 * lines, not the docker wall of text; an unavailable docker daemon degrades to `skipped` so the
 * control plane works end-to-end without infra.
 */
export async function buildStagedTree(
  input: EveImageBuildInput & {
    overlay: { path: string; content: string | null }[];
    /** Publish task namespacing the provisional tag (`harnesst/publish-<taskId>:…`). */
    taskId?: string;
  },
): Promise<
  { ok: true; skipped?: boolean; provisionalTag?: string } | { ok: false; output: string }
> {
  try {
    await assertDockerDaemonReady("build this change");
  } catch (error) {
    if (isDockerUnavailableError(error)) {
      console.warn(
        `[publish-build] ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: true, skipped: true };
    }
    throw error;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "harnesst-publish-"));
  try {
    const srcDir = await fetchSource(input, workDir);

    for (const file of input.overlay) {
      const target = path.join(srcDir, file.path);
      // Overlay paths come from harnesst's own saved drafts (already normalized under agent/), but
      // never write outside the checkout regardless.
      if (!target.startsWith(srcDir + path.sep)) continue;
      if (file.content === null) {
        // Saved deletion — build the tree as it will exist after the commit lands. Prune
        // now-empty parent directories too: a member removal or rename deletes EVERY file
        // under `agents/<name>/agent`, and the root-existence check below must see that root
        // as gone, not as an empty directory left behind by the tarball extraction.
        await rm(target, { force: true });
        for (
          let dir = path.dirname(target);
          dir.startsWith(srcDir + path.sep);
          dir = path.dirname(dir)
        ) {
          try {
            await rmdir(dir); // ENOTEMPTY on a dir that still has content — stop pruning.
          } catch {
            break;
          }
        }
        continue;
      }
      await exec("mkdir", ["-p", path.dirname(target)]);
      await writeFile(target, file.content);
    }

    // A member root that doesn't exist after the overlay (the change deletes or moves the whole
    // member) has nothing to build — the post-commit roster sync handles removal; failing here
    // would block the publish with an opaque eve error (issue #137). Runs AFTER the overlay
    // loop so an overlay that creates a brand-new member's files still builds, and the deletion
    // pruning above means a fully-deleted root really is absent (fetchSource mkdir's only the
    // parent package dir, never `…/agent`, so this existence check is authoritative).
    if (
      input.agentRoot &&
      input.agentRoot !== "agent" &&
      !existsSync(path.join(srcDir, input.agentRoot))
    ) {
      return { ok: true, skipped: true };
    }

    const { dir, member } = projectDirOf(input.agentRoot);
    const buildDir = path.join(srcDir, dir);
    const tags = provisionalTags({ taskId: input.taskId, projectId: input.projectId, member });
    const opts = { maxBuffer: 64 * 1024 * 1024 };
    try {
      await exec(
        "docker",
        ["build", "--target", "build", "-t", tags.buildStage, buildDir],
        opts,
      );
      // Beyond compiling: run the repo's own typecheck/lint scripts (when defined) inside
      // the built stage — `--if-present` makes repos without them pass trivially.
      try {
        await exec(
          "docker",
          [
            "run",
            "--rm",
            "--entrypoint",
            "sh",
            tags.buildStage,
            "-lc",
            "npm run typecheck --if-present && npm run lint --if-present",
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        );
      } catch (error) {
        // commandErrorText, not error.message: tsc/eslint report errors on STDOUT, and an
        // execFile error's message carries only the command line + stderr.
        const raw = commandErrorText(error);
        await untagQuietly([tags.buildStage]);
        return { ok: false, output: raw.split("\n").slice(-30).join("\n") };
      }
      // The runtime stage inherits the build stage, so this is cheap (cache hits + tiny layers).
      await exec("docker", ["build", "-t", tags.runtime, buildDir], opts);
      return { ok: true, provisionalTag: tags.runtime };
    } catch (error) {
      // commandErrorText again: a docker CLI without buildx falls back to the legacy builder,
      // which streams build-step output (the compiler's own lines) to STDOUT — error.message
      // has only stderr, which reduced real compile failures to "returned a non-zero code: 1".
      const raw = commandErrorText(error);
      if (isDockerUnavailableError(error)) {
        console.warn(
          `[publish-build] ${normalizeDockerCliError(error, "build this change").message}`,
        );
        return { ok: true, skipped: true };
      }
      await untagQuietly([tags.runtime, tags.buildStage]);
      return { ok: false, output: extractBuildError(raw) };
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Promote a publish build's provisional image to a commit's real tags (§3.2): after the commit
 * lands and Releases are cut, `docker tag` the provisional runtime + `-build` pair onto
 * `harnesst/proj-<id8>[-member]:<sha12>` (+`-build` — the suffix convention is load-bearing, see
 * `buildStageTagFor`). The Release then carries the runtime tag as its `imageRef`, so the deploy
 * (`rebuild: false`) skips its own build — each change is Docker-built once.
 */
export async function promoteProvisionalImage(input: {
  provisionalTag: string;
  projectId: string;
  gitSha: string;
  /** The built root ("agent" | "agents/<member>/agent") — selects the member tag suffix. */
  agentRoot?: string;
}): Promise<BuiltArtifact> {
  const { member } = projectDirOf(input.agentRoot);
  const tags = imageTags(input.projectId, input.gitSha, member);
  await exec("docker", ["tag", input.provisionalTag, tags.runtime]);
  await exec("docker", ["tag", buildStageTagFor(input.provisionalTag), tags.buildStage]);
  const { stdout: digest } = await exec("docker", [
    "inspect",
    "--format",
    "{{.Id}}",
    tags.runtime,
  ]);
  return { imageRef: tags.runtime, digest: digest.trim() };
}

/**
 * Drop provisional publish tags (and their `-build` stages) once a publish is over — promoted
 * images keep their real tags; a failed publish leaves nothing behind. Best-effort by design:
 * the sandbox reaper prunes any stragglers a crash strands.
 */
export async function removeProvisionalImages(provisionalTags: string[]): Promise<void> {
  await untagQuietly(
    provisionalTags.flatMap((tag) => [tag, buildStageTagFor(tag)]),
  );
}

/**
 * Pull the tool/compiler output out of buildkit's progress stream: the step-output lines
 * (`#N <seconds> <message>`), which is what a human needs to fix the code. Falls back to the
 * error's tail when nothing matches.
 */
export function extractBuildError(raw: string): string {
  const stepLines = [...raw.matchAll(/^#\d+ \d+\.\d+ (.*)$/gm)].map(
    (m) => m[1],
  );
  const meaningful = stepLines.filter((l) => l.trim().length > 0);
  if (meaningful.length > 0) return meaningful.join("\n");
  return raw.split("\n").slice(-15).join("\n");
}
