/**
 * Copy-on-publish (issues #290, #291, #315): read one file — or the files of one page bundle —
 * directly out of the publishing turn's sandbox over the mounted Docker socket.
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
 * points. The path is FIRST resolved inside the exact session sandbox, re-checked against that
 * sandbox's private /workspace/home mount, and only then copied without link dereferencing.
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
import { homeVolumeName } from "~/seams/oss/deploy.localdocker.server";

/** A tar entry as read off `docker cp` — one regular file the copy asked for. */
export interface TarFile {
  name: string;
  bytes: Buffer;
}

const TAR_BLOCK = 512;

/** Read a NUL-terminated field out of a tar header. */
function field(header: Buffer, offset: number, length: number): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

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
    const rawSize = header
      .subarray(124, 136)
      .toString("utf8")
      .replace(/\0.*$/, "")
      .trim();
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

/**
 * Why a bundle walk cannot reuse `firstFileInTar` (#291): that reader is deliberately LENIENT —
 * it skips whatever it does not understand looking for one payload. For a directory copy the
 * entries it would skip are the confinement boundary. Resolving a directory's realpath says
 * nothing about where the files INSIDE it point, and `docker cp` without `-L` archives an inner
 * symlink as a payload-less link entry, so refusing link entries is the whole per-member defence
 * and "skip and carry on" would quietly publish a bundle missing its linked file (or, worse,
 * normalize away the evidence that one was there).
 *
 * So this walk is strict in the other direction: every entry is classified, and anything that is
 * not a regular file or a directory aborts the copy.
 */
export type TarWalkResult =
  | { ok: true; files: TarFile[] }
  /** A header this parser will not interpret, or one whose framing does not add up. */
  | { ok: false; reason: "malformed" | "link" | "extended" | "count" };

/**
 * Every regular file in a tar stream, or the reason the stream was refused.
 *
 * PAX/GNU extension records ('x'/'g'/'L'/'K') are REFUSED rather than skipped: skipping them
 * leaves the following header's truncated name in play, and interpreting them is a parser this
 * does not need — docker truncates mtimes to whole seconds precisely so ordinary paths stay
 * USTAR, and USTAR's own 155-byte `prefix` field (read below) covers long paths.
 */
export function filesInTar(tar: Buffer, maxFiles: number): TarWalkResult {
  const files: TarFile[] = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    const base = field(header, 0, 100);
    // Two consecutive zero blocks end the archive; a single one is enough to stop reading.
    if (!base) break;
    const size = Number.parseInt(field(header, 124, 12).trim(), 8);
    if (!Number.isFinite(size) || size < 0) {
      return { ok: false, reason: "malformed" };
    }
    const type = String.fromCharCode(header[156]);
    const prefix = field(header, 257, 6).startsWith("ustar")
      ? field(header, 345, 155)
      : "";
    const name = prefix ? `${prefix}/${base}` : base;
    const body = offset + TAR_BLOCK;
    const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === "0" || type === "\0") {
      if (body + size > tar.length) return { ok: false, reason: "malformed" };
      if (files.length >= maxFiles) return { ok: false, reason: "count" };
      files.push({ name, bytes: tar.subarray(body, body + size) });
    } else if (type === "5") {
      // A directory entry carries no payload; the members' own relative paths recreate the tree.
    } else if (type === "1" || type === "2") {
      return { ok: false, reason: "link" };
    } else {
      return { ok: false, reason: "extended" };
    }
    offset = body + padded;
  }
  return { ok: true, files };
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
    child.on("error", (error) =>
      settle({ ok: false, error: commandErrorText(error) }),
    );
    child.on("close", (code) => {
      if (code === 0) settle({ ok: true, stdout: Buffer.concat(chunks) });
      else
        settle({ ok: false, error: stderr.trim() || `docker exited ${code}` });
    });
  });

export type ArtifactCopyResult =
  { ok: true; bytes: Buffer } | { ok: false; error: string };

/**
 * Resolved inside the container by node, so no coreutils (`realpath`/`readlink`) is assumed and the
 * answer is the kernel's, not a textual guess. Always exits 0 and answers on stdout: an ordinary
 * ENOENT is a message for the agent, not a docker failure to interpret.
 */
const REALPATH_SCRIPT = `const fs = require("node:fs");
let out;
try {
  const real = fs.realpathSync(process.argv[1]);
  const stat = fs.statSync(real);
  const kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "notfile";
  out = kind + "\\n" + real;
} catch (error) {
  out = "error\\n" + (error && error.code ? error.code : "UNKNOWN");
}
process.stdout.write(out);`;

/** Longest answer the resolve step will read back — a path, not a payload. */
const REALPATH_MAX_BYTES = 8 * 1024;

type RealPathResult =
  { ok: true; path: string; directory: boolean } | { ok: false; error: string };

/**
 * The real path of `path` inside the container, with every symlink resolved and confirmed to still
 * live under the agent's home root. This is the confinement boundary: everything after it copies a
 * path the container itself resolved, not one the agent described.
 *
 * A DIRECTORY is only accepted when the caller asked for one (a page bundle). Note what resolving
 * a directory does and does not buy: it proves the directory itself is inside the home volume, and
 * nothing at all about the files under it — per-member confinement is the tar walk's link refusal
 * in `filesInTar`, which is why that walk aborts instead of skipping.
 */
async function realPathInContainer(
  container: string,
  path: string,
  stream: DockerStreamer,
  allowDirectory = false,
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
  if (verdict === "notfile" || (verdict === "dir" && !allowDirectory)) {
    return {
      ok: false,
      error: allowDirectory
        ? `${path} is not a file or a directory, so there is nothing to publish.`
        : `${path} is not a regular file — publish a single image file.`,
    };
  }
  if ((verdict !== "file" && verdict !== "dir") || !detail) {
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
  return { ok: true, path: confined.path, directory: verdict === "dir" };
}

const SANDBOX_LOOKUP_MAX_BYTES = 8 * 1024;

/**
 * Resolve one Eve session label to the one sandbox mounting this environment's home volume.
 * Both filters are load-bearing: an Eve id identifies the turn, while the volume ties that
 * container to the authenticated deployment's environment.
 */
async function sandboxContainerForSession(
  input: { sandboxSessionId: string; worldKey: string },
  stream: DockerStreamer,
): Promise<{ ok: true; container: string } | { ok: false; error: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(input.sandboxSessionId)) {
    return {
      ok: false,
      error: "harnesst could not identify this conversation's workspace.",
    };
  }
  const result = await stream(
    [
      "ps",
      "-aq",
      "--filter",
      "label=eve.sandbox.role=session",
      "--filter",
      `label=eve.sandbox.tag.sessionId=${input.sandboxSessionId}`,
      "--filter",
      `volume=${homeVolumeName(input.worldKey)}`,
      "--format",
      "{{.ID}}",
    ],
    SANDBOX_LOOKUP_MAX_BYTES,
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        "harnesst can't reach this conversation's workspace right now, so it couldn't read the file.",
    };
  }
  const containers = result.stdout
    .toString("utf8")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (containers.length !== 1) {
    return {
      ok: false,
      error:
        containers.length === 0
          ? "harnesst can't find this conversation's workspace right now, so it couldn't read the file."
          : "harnesst found more than one sandbox for this conversation and refused to guess which file to publish.",
    };
  }
  return { ok: true, container: containers[0] };
}

/** Map a docker CLI failure onto something the agent can act on. */
function dockerFailureText(text: string, path: string): string {
  if (
    /No such container|No such object|is not running|not running/i.test(text)
  ) {
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
  input: {
    deploymentId: string;
    worldKey: string;
    sandboxSessionId: string;
    path: string;
    maxBytes: number;
  },
  stream: DockerStreamer = realDockerStreamer,
): Promise<ArtifactCopyResult> {
  const found = await sandboxContainerForSession(input, stream);
  if (!found.ok) return found;
  const container = found.container;
  const real = await realPathInContainer(container, input.path, stream);
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

export type ArtifactBundleCopyResult =
  { ok: true; files: TarFile[] } | { ok: false; error: string };

/**
 * How many directory-entry headers a bundle's archive may spend. Directories carry no payload, so
 * they never count against `maxFiles` and their number is otherwise unbounded — but a page bundle is
 * a page, and 64 blocks is 32 KB of slack on a 25 MB ceiling, which costs nothing and covers any
 * tree a real page has.
 */
const TAR_DIR_ALLOWANCE = 64;

/**
 * The byte cap the bundle's `docker cp` stream is aborted at: the artifact ceiling plus the tar's
 * FRAMING, which is not free. Each member costs a 512-byte header AND up to 511 bytes of padding out
 * to the next block boundary; the archive ends in two zero blocks; and `docker cp` leads with a
 * directory entry for the copied root, plus one for every subdirectory under it.
 *
 * Budgeting only one header per file (the first shape of this) refused a legitimate bundle sitting
 * just under the ceiling — the padding of 40 members alone is up to ~20 KB — with "larger than the
 * 25 MB artifact limit", a refusal the post-walk sum below would never have made. The cap is a heap
 * bound, not the size rule: the real ceiling is `total > maxBytes` over the walked members.
 */
export function bundleTarStreamCap(maxBytes: number, maxFiles: number): number {
  const trailerBlocks = 2;
  // One header block plus one block of padding slack per member.
  const perFileBlocks = 2 * Math.max(0, maxFiles);
  return (
    maxBytes + TAR_BLOCK * (trailerBlocks + perFileBlocks + TAR_DIR_ALLOWANCE)
  );
}

/** MB, for the refusal copy — the caps are bytes, the messages are human. */
function megabytes(bytes: number): number {
  return Math.floor(bytes / (1024 * 1024));
}

/**
 * Every file of a page bundle (#291): the same confinement story as the single-file copy, plus two
 * things a directory needs.
 *
 * RE-ROOTING. `docker cp <container>:<dir> -` names its entries after the directory's basename
 * (`site/`, `site/index.html`), so a member's bundle-relative path is what is left once that root
 * is stripped. The names come from the container, so every one is re-validated by the caller
 * (`resolveBundleMember`) before it is stored, and an entry that does not sit under the root at all
 * aborts the copy rather than being re-rooted by guesswork.
 *
 * CAPS. The stream cap already bounds the heap; a bundle adds a FILE-COUNT cap, because the per-copy
 * heap bound (`MAX_CONCURRENT_ARTIFACT_COPIES × maxBytes`) says nothing about the number of database
 * rows and store writes one publish can cause. The summed member bytes are checked against the same
 * ceiling a single file gets, so a bundle cannot spend more disk than an image can.
 */
export async function copyArtifactBundleFromInstance(
  input: {
    deploymentId: string;
    worldKey: string;
    sandboxSessionId: string;
    path: string;
    maxBytes: number;
    maxFiles: number;
  },
  stream: DockerStreamer = realDockerStreamer,
): Promise<ArtifactBundleCopyResult> {
  const found = await sandboxContainerForSession(input, stream);
  if (!found.ok) return found;
  const container = found.container;
  const real = await realPathInContainer(container, input.path, stream, true);
  if (!real.ok) return { ok: false, error: real.error };
  const result = await stream(
    ["cp", `${container}:${real.path}`, "-"],
    bundleTarStreamCap(input.maxBytes, input.maxFiles),
  );
  if (!result.ok) {
    if ("overflow" in result) {
      return {
        ok: false,
        error: `That page is larger than the ${megabytes(input.maxBytes)} MB artifact limit.`,
      };
    }
    return { ok: false, error: dockerFailureText(result.error, input.path) };
  }

  const walk = filesInTar(result.stdout, input.maxFiles);
  if (!walk.ok) {
    if (walk.reason === "link") {
      return {
        ok: false,
        error: `${input.path} contains a symlink, and harnesst does not follow links out of a published page. Copy the real file in and publish again.`,
      };
    }
    if (walk.reason === "count") {
      return {
        ok: false,
        error: `A published page can hold at most ${input.maxFiles} files. Inline or drop the extras and publish again.`,
      };
    }
    return {
      ok: false,
      error: `harnesst couldn't read ${input.path}. Keep the page's file names short and plain (letters, digits, dots, dashes).`,
    };
  }

  const root = real.path.slice(real.path.lastIndexOf("/") + 1);
  const files: TarFile[] = [];
  for (const file of walk.files) {
    // A single-FILE publish arrives as one entry named exactly the basename.
    if (file.name === root) {
      files.push({ name: root, bytes: file.bytes });
      continue;
    }
    if (!file.name.startsWith(`${root}/`)) {
      return {
        ok: false,
        error: `harnesst couldn't read ${input.path} — it holds a file (${file.name}) from outside the directory.`,
      };
    }
    files.push({ name: file.name.slice(root.length + 1), bytes: file.bytes });
  }
  if (files.length === 0) {
    return {
      ok: false,
      error: `There are no files to publish in ${input.path}.`,
    };
  }
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total === 0) {
    return { ok: false, error: `${input.path} is empty.` };
  }
  if (total > input.maxBytes) {
    return {
      ok: false,
      error: `That page is larger than the ${megabytes(input.maxBytes)} MB artifact limit.`,
    };
  }
  return { ok: true, files };
}
