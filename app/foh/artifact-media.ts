/**
 * Artifact media rules (issue #290) — the two judgements that decide whether an agent's publish
 * is accepted, both pure so they unit-test with no docker, no disk and no database.
 *
 * WHAT MAY BE PUBLISHED: a path inside the agent's own home volume, and bytes that ARE one of
 * four image formats. The content type is SNIFFED, never taken from the request: the agent names
 * a file, so a claimed `image/png` on an HTML payload would turn the serving route — same-origin,
 * cookie-authenticated — into stored XSS against the operator's own session. The extension is
 * likewise only ever a tie-breaker for SVG, which has no binary magic.
 *
 * Client+server safe: no node builtins, no server imports (the serving route and the FOH card
 * both read `ARTIFACT_INLINE_TYPES`).
 */

/** Hard ceiling on one artifact. Matches the edge's `client_max_body_size 25m` (nginx-harnesst.conf). */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The only directory tree an agent may publish out of: its own persistent home, which the
 * eve-docker shim mounts into every session sandbox at the same path. That is what makes the
 * agent-browser flow work unchanged — its screenshots land in
 * `/workspace/home/agent-browser/screenshots` — without the tool needing to copy files first.
 */
export const ARTIFACT_HOME_ROOT = "/workspace/home";

/** v1 is images only. Ordered by how they are sniffed below, not by preference. */
export const ARTIFACT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];

/**
 * Types the serving route hands over for inline rendering. SVG is deliberately absent: it renders
 * safely inside an `<img>` (scripts never run in an image context) but a DIRECT navigation to the
 * URL would execute them same-origin, and the response CSP is not ours to set — the session
 * middleware overwrites it (`hardenDynamicResponse`). So SVG ships with a download disposition,
 * which navigations honour and image loads ignore.
 */
export const ARTIFACT_INLINE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Longest file name kept — the name is display copy, not an identifier. */
const MAX_NAME_LENGTH = 200;

export interface ArtifactSource {
  /** Absolute path inside the instance/sandbox filesystem, ready for `docker cp`. */
  path: string;
  /** Basename, for the card and the storage file name. */
  name: string;
}

/**
 * Validate the path the agent published. Accepts an absolute path under the home root or a path
 * relative to it (`artifacts/report.png`), and refuses everything else — including any `..`
 * segment, which is the whole point: `docker cp` would happily read `/etc/shadow` out of the
 * instance, and the home volume is the only tree the agent's own work lives in.
 */
export function resolveArtifactSource(raw: unknown): ArtifactSource | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const absolute = trimmed.startsWith("/")
    ? trimmed
    : `${ARTIFACT_HOME_ROOT}/${trimmed}`;
  const segments = absolute.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  const path = `/${segments.join("/")}`;
  if (path !== ARTIFACT_HOME_ROOT && !path.startsWith(`${ARTIFACT_HOME_ROOT}/`)) {
    return null;
  }
  const name = segments.at(-1) ?? "";
  if (!name || name.length > MAX_NAME_LENGTH || path === ARTIFACT_HOME_ROOT) {
    return null;
  }
  return { path, name };
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

/** ASCII at an offset — enough for the two four-character tags in a RIFF header. */
function tagAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + 4));
}

/**
 * The content type the BYTES are, or null when they are not a supported image. PNG/JPEG/WebP have
 * unambiguous magic; SVG is XML, so it is recognised by a root `<svg` element near the head of the
 * document and only when the file also claims to be one by name — a text file that merely contains
 * an `<svg` snippet is not an image.
 */
export function sniffArtifactContentType(
  bytes: Uint8Array,
  name: string,
): ArtifactContentType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    tagAt(bytes, 0) === "RIFF" &&
    tagAt(bytes, 8) === "WEBP"
  ) {
    return "image/webp";
  }
  if (name.toLowerCase().endsWith(".svg")) {
    // Read only the head: an SVG's root element is at the top, after an optional BOM, XML
    // declaration, doctype or comments, and scanning megabytes for it buys nothing.
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, 4096))
      .replace(/^﻿/, "")
      .trimStart();
    if (/^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s)*<svg[\s>]/i.test(head)) {
      return "image/svg+xml";
    }
  }
  return null;
}

/** Whether the serving route may render these bytes inline (see `ARTIFACT_INLINE_TYPES`). */
export function artifactRendersInline(contentType: string): boolean {
  return ARTIFACT_INLINE_TYPES.includes(contentType);
}

/** The app path that serves one artifact's bytes. The only URL an artifact is ever reached by. */
export function artifactUrl(projectId: string, artifactId: string): string {
  return `/api/foh/${projectId}/artifact/${artifactId}`;
}
