/**
 * Copy-on-publish (issue #290): read one file out of an agent's instance over the mounted Docker
 * socket, at publish time, and hand the bytes back.
 *
 * Why the control plane reads it rather than the agent uploading it: the tool's POST crosses
 * harnesst's own edge (`client_max_body_size 25m`) and would have to base64 a screenshot through a
 * turn's fetch budget, while the bytes are already sitting on a volume this process can reach. And
 * why a COPY rather than a proxy: an instance's published port is reallocated on every wake and
 * its container is disposable, so anything that kept pointing at the instance would break as soon
 * as the agent scaled to zero.
 *
 * The transfer is streamed to stdout as a tar and capped WHILE it is read — a 10 GB file must not be
 * written to the control plane's disk to then be rejected for being too large.
 *
 * CONFINEMENT is the reason this is two docker calls and not one. The path check in
 * `artifact-media.ts` is textual, so it says nothing about where a LINK under the home volume
 * points, and `docker cp -L` (the first shape of this) dereferenced it happily: an agent — or
 * prompt-injected code in its sandbox, which mounts the same home volume — could plant
 * `ln -s /root/.config/x.png /workspace/home/artifacts/chart.png` and have the control plane read a
 * file from the instance container's own filesystem. So the path is FIRST resolved to its real path
 * inside the container (`realpathSync`, which resolves intermediate directory symlinks too, not
 * just the last component), that real path is re-checked against the home root, and only then is it
 * copied — with `-L` dropped, so a link swapped in after the resolve arrives as a payload-less link
 * entry and is refused rather than followed.
 *
 * `realpathSync` runs through `docker exec node -e`, which needs a RUNNING container. That is the
 * publish's own precondition (it only lands inside a live turn — see `liveFohTurnForDeployment`),
 * and node is the instance image's entrypoint runtime, so no coreutils assumption is made either.
 *
 * Only the local-docker target has these semantics; on every other target the docker CLI is absent
 * and this reports an ordinary refusal the agent can read, never a throw.
 */
import { spawn } from "node:child_process";

import { commandErrorText } from "~/deploy/docker.server";
import { resolveArtifactSource } from "~/foh/artifact-media";
// The instance container naming rule lives with the target that creates them; importing it keeps
// the two from drifting apart the day the prefix changes.
import { containerName as instanceContainerName } from "~/seams/oss/deploy.localdocker.server";

/** A tar entry as read off `docker cp` — the single regular file the copy asked for. */
export interface TarFile {
  name: string;
  bytes: Buffer;
}

const TAR_BLOCK = 512;

/**
 * The first regular file in a tar stream, or null when there is none (`docker cp` of a directory
 * leads with the directory entry, and of a symlink emits a link entry with no payload).
 *
 * Deliberately minimal: only the fields this needs (name, size, type) are read, and PAX/GNU
 * extension records are skipped rather than interpreted — a screenshot path never needs them, and
 * a partial parse of an attacker-shaped header is worse than ignoring it.
 */
export function firstFileInTar(tar: Buffer): TarFile | null {
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    // Two consecutive zero blocks end the archive; a single one is enough to stop reading.
    if (!name) return null;
    const rawSize = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(rawSize, 8);
    if (!Number.isFinite(size) || size < 0) return null;
    const type = String.fromCharCode(header[156]);
    const body = offset + TAR_BLOCK;
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === "0" || type === "\0") {
      if (body + size > tar.length) return null;
      return { name, bytes: tar.subarray(body, body + size) };
    }
    offset = body + padded;
  }
  return null;
}

export type StreamResult =
  | { ok: true; stdout: Buffer }
  | { ok: false; error: string }
  /** The transfer passed the cap and was aborted mid-flight — nothing was buffered past it. */
  | { ok: false; error: string; overflow: true };

/** Runs a docker command and buffers stdout, aborting the moment `maxBytes` is exceeded. */
export type DockerStreamer = (
  args: string[],
  maxBytes: number,
) => Promise<StreamResult>;

export const realDockerStreamer: DockerStreamer = (args, maxBytes) =>
  new Promise<StreamResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const settle = (result: StreamResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill("SIGKILL");
        settle({ ok: false, error: "overflow", overflow: true });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle({ ok: false, error: commandErrorText(error) }));
    child.on("close", (code) => {
      if (code === 0) settle({ ok: true, stdout: Buffer.concat(chunks) });
      else settle({ ok: false, error: stderr.trim() || `docker exited ${code}` });
    });
  });

export type ArtifactCopyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

/**
 * Resolved inside the container by node, so no coreutils (`realpath`/`readlink`) is assumed and the
 * answer is the kernel's, not a textual guess. Always exits 0 and answers on stdout: an ordinary
 * ENOENT is a message for the agent, not a docker failure to interpret.
 */
const REALPATH_SCRIPT = `const fs = require("node:fs");
let out;
try {
  const real = fs.realpathSync(process.argv[1]);
  out = (fs.statSync(real).isFile() ? "file\\n" : "notfile\\n") + real;
} catch (error) {
  out = "error\\n" + (error && error.code ? error.code : "UNKNOWN");
}
process.stdout.write(out);`;

/** Longest answer the resolve step will read back — a path, not a payload. */
const REALPATH_MAX_BYTES = 8 * 1024;

type RealPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * The real path of `path` inside the container, with every symlink resolved and confirmed to still
 * live under the agent's home root. This is the confinement boundary: everything after it copies a
 * path the container itself resolved, not one the agent described.
 */
async function realPathInInstance(
  container: string,
  path: string,
  stream: DockerStreamer,
): Promise<RealPathResult> {
  const result = await stream(
    ["exec", container, "node", "-e", REALPATH_SCRIPT, path],
    REALPATH_MAX_BYTES,
  );
  if (!result.ok) {
    if ("overflow" in result) {
      return { ok: false, error: `harnesst couldn't resolve ${path}.` };
    }
    return { ok: false, error: dockerFailureText(result.error, path) };
  }
  const [verdict, detail = ""] = result.stdout.toString("utf8").split("\n");
  if (verdict === "error") {
    if (detail === "ENOENT" || detail === "ENOTDIR") {
      return { ok: false, error: `There is no file at ${path}.` };
    }
    if (detail === "ELOOP") {
      return {
        ok: false,
        error: `${path} is a loop of links, so there is no file to read.`,
      };
    }
    return { ok: false, error: `harnesst couldn't read ${path} (${detail}).` };
  }
  if (verdict === "notfile") {
    return {
      ok: false,
      error: `${path} is not a regular file — publish a single image file.`,
    };
  }
  if (verdict !== "file" || !detail) {
    return { ok: false, error: `harnesst couldn't resolve ${path}.` };
  }
  // The whole point of resolving: a link (or a symlinked parent directory) that leaves the home
  // volume is refused HERE, where the real target is known, instead of being followed by the copy.
  const confined = resolveArtifactSource(detail);
  if (!confined) {
    return {
      ok: false,
      error: `${path} points outside /workspace/home (it resolves elsewhere in the container), so harnesst will not publish it.`,
    };
  }
  return { ok: true, path: confined.path };
}

/** Map a docker CLI failure onto something the agent can act on. */
function dockerFailureText(text: string, path: string): string {
  if (/No such container|No such object|is not running|not running/i.test(text)) {
    return "harnesst can't reach this agent's instance right now, so it couldn't read the file. Try again while the agent is running.";
  }
  if (/[Nn]o such file or directory|Could not find the file/.test(text)) {
    return `There is no file at ${path}.`;
  }
  return `harnesst couldn't read the file: ${text}`;
}

/**
 * The bytes of `path` inside the deployment's instance container. The cap counts the TAR stream, so
 * it is a hair stricter than the file size — harmless, and it means the ceiling is enforced before
 * anything is buffered whole.
 */
export async function copyArtifactFromInstance(
  input: { deploymentId: string; path: string; maxBytes: number },
  stream: DockerStreamer = realDockerStreamer,
): Promise<ArtifactCopyResult> {
  const container = instanceContainerName(input.deploymentId);
  const real = await realPathInInstance(container, input.path, stream);
  if (!real.ok) return { ok: false, error: real.error };
  // `-` sends the archive to stdout. No `-L`: the path is already fully resolved, so the only thing
  // dereferencing could still buy is following a link swapped in since — which must not happen.
  // Such a race now arrives as a payload-less link entry and is refused below.
  const result = await stream(
    ["cp", `${container}:${real.path}`, "-"],
    input.maxBytes + TAR_BLOCK * 2,
  );
  if (!result.ok) {
    if ("overflow" in result) {
      return {
        ok: false,
        error: `That file is larger than the ${Math.floor(input.maxBytes / (1024 * 1024))} MB artifact limit.`,
      };
    }
    return { ok: false, error: dockerFailureText(result.error, input.path) };
  }
  const file = firstFileInTar(result.stdout);
  if (!file) {
    return {
      ok: false,
      error: `${input.path} is not a regular file — publish a single image file.`,
    };
  }
  if (file.bytes.length === 0) {
    return { ok: false, error: `${input.path} is empty.` };
  }
  if (file.bytes.length > input.maxBytes) {
    return {
      ok: false,
      error: `That file is larger than the ${Math.floor(input.maxBytes / (1024 * 1024))} MB artifact limit.`,
    };
  }
  return { ok: true, bytes: file.bytes };
}
