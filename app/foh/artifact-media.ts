/**
 * Artifact media rules (issues #290, #291) — the judgements that decide whether an agent's publish
 * is accepted, all pure so they unit-test with no docker, no disk and no database.
 *
 * WHAT MAY BE PUBLISHED: a path inside the agent's own home volume, and either bytes that ARE one
 * of four image formats, a PDF document, or a small static PAGE BUNDLE (an `index.html` plus
 * css/js/font/image siblings). For a single file the content type is SNIFFED, never taken from the request: the agent
 * names a file, so a claimed `image/png` on an HTML payload would turn the image serving route —
 * same-origin, cookie-authenticated — into stored XSS against the operator's own session.
 *
 * A bundle cannot work that way, because HTML, CSS and JS have no magic bytes at all: there is
 * nothing to sniff and every heuristic is guessable around. So the bundle rules invert the
 * compensating control instead of pretending to sniff — the member's EXTENSION picks its type from
 * a closed allowlist, and the bytes are only ever served by the preview route, whose response
 * carries `Content-Security-Policy: sandbox allow-scripts; …` (see `artifact-preview.server.ts`).
 * Header-level `sandbox` survives a top-level navigation, which is what makes serving
 * agent-authored HTML from harnesst's own origin safe; the image route refuses bundle rows
 * outright. Image members are still cross-checked against the sniff — an extension allowlist is a
 * weaker claim than magic bytes, so where magic exists it is required to agree.
 *
 * Client+server safe: no node builtins, no server imports (the serving route and the FOH card
 * both read `ARTIFACT_INLINE_TYPES`).
 */

/** Hard ceiling on one artifact. Matches the edge's `client_max_body_size 25m` (nginx-harnesst.conf). */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

/** PDF upload ceiling for a document published from an isolated subagent sandbox. */
export const ARTIFACT_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The only directory tree an agent may publish out of: its own persistent home, which the
 * eve-docker shim mounts into every session sandbox at the same path. That is what makes the
 * agent-browser flow work unchanged — its screenshots land in
 * `/workspace/home/agent-browser/screenshots` — without the tool needing to copy files first.
 */
export const ARTIFACT_HOME_ROOT = "/workspace/home";

/** The image formats a single-file publish may be. Ordered by how they are sniffed below. */
export const ARTIFACT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];

/** Documents a single-file publish may contain. Deliberately PDF-only for the first release. */
export const ARTIFACT_DOCUMENT_CONTENT_TYPES = ["application/pdf"] as const;
export type ArtifactDocumentContentType =
  (typeof ARTIFACT_DOCUMENT_CONTENT_TYPES)[number];

/**
 * Types the IMAGE serving route hands over for inline rendering. SVG is deliberately absent: it
 * renders safely inside an `<img>` (scripts never run in an image context) but a DIRECT navigation
 * to the URL would execute them same-origin. That route serves no CSP of its own, so SVG ships with
 * a download disposition instead, which navigations honour and image loads ignore. (The bundle
 * preview route does own its CSP — see `artifact-preview.server.ts` — which is precisely why it is
 * the only route allowed to serve a bundle's bytes.)
 */
export const ARTIFACT_INLINE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/**
 * What a published artifact IS, and the row's `kind` column. `image` and `document` are single
 * sniffed files served by the cookie-authenticated artifact route; `html` is a page bundle served
 * only through the sandboxed, token-authenticated preview route.
 */
export const ARTIFACT_KINDS = ["image", "html", "document"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Most files a page bundle may hold. A page, not a site — see the byte cap above for the rest. */
export const ARTIFACT_BUNDLE_MAX_FILES = 40;

/** The entry document of a multi-file bundle, by convention and by web convention. */
export const ARTIFACT_BUNDLE_ENTRY = "index.html";

/**
 * The closed allowlist of bundle member types, keyed by lowercase extension. Deliberately small:
 * everything here is a STATIC asset a rendered page needs, and nothing here is a container format
 * that could carry another (no zip, no pdf, no video). An unlisted extension is refused rather than
 * skipped — silently dropping a font or a stylesheet would show the user a page that renders wrong
 * for no visible reason, and the agent owns the directory it asked us to publish.
 *
 * `json` and `map` are here so a data file or a build's sourcemap sitting next to the page does not
 * refuse the whole publish — NOT because a page can read them at runtime. The preview serves
 * `connect-src 'none'`, so `fetch()`/XHR of a sibling never resolves; a sourcemap is fetched by
 * devtools, which is not subject to the page's CSP, and that is the only use `map` has here. The
 * tool description and the assistant skill therefore tell agents to INLINE their data.
 */
const BUNDLE_MEMBER_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  woff2: "font/woff2",
  woff: "font/woff",
};

/** Extensions an agent may publish inside a bundle, for the refusal message. */
export const ARTIFACT_BUNDLE_EXTENSIONS: readonly string[] =
  Object.keys(BUNDLE_MEMBER_TYPES);

/** Longest single path segment inside a bundle, and the deepest a bundle may nest. */
const MAX_SEGMENT_LENGTH = 100;
const MAX_BUNDLE_DEPTH = 8;

/**
 * A bundle-relative path, normalized, or null when it is not one. Used on BOTH sides: the tar
 * entry names `docker cp` hands back (container-controlled, so never trusted) and the `*` splat of
 * a preview request (browser-controlled). Segments are restricted to a conservative character
 * class rather than merely stripped of `..`: the value ends up in a database lookup key and a
 * `Content-Disposition`, and there is no legitimate asset name outside it.
 */
export function normalizeBundleRelPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.length > MAX_NAME_LENGTH) {
    return null;
  }
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.length > MAX_BUNDLE_DEPTH) return null;
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH) return null;
    // Leading dot excluded on purpose: a bundle has no dotfiles, and `.` prefixes are how
    // configuration and credentials are named everywhere else in a home directory.
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment)) return null;
  }
  return segments.join("/");
}

/** The content type a bundle member's extension declares, or null when it is not on the list. */
export function bundleMemberContentType(relPath: string): string | null {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BUNDLE_MEMBER_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

export interface BundleMember {
  relPath: string;
  contentType: string;
}

/**
 * Accept one bundle member, or refuse it. The path must normalize, the extension must be on the
 * allowlist, and — where the declared type is one harnesst can actually sniff — the bytes must BE
 * that type. The sniff cross-check is what stops a bundle from being a smuggling envelope: an
 * `.png` member holding HTML would otherwise be served as `image/png`, which `nosniff` renders
 * inert but which is still a lie the store would keep.
 */
export function resolveBundleMember(
  rawRelPath: unknown,
  bytes: Uint8Array,
): BundleMember | null {
  const relPath = normalizeBundleRelPath(rawRelPath);
  if (!relPath) return null;
  const contentType = bundleMemberContentType(relPath);
  if (!contentType) return null;
  if ((ARTIFACT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    if (sniffArtifactContentType(bytes, name) !== contentType) return null;
  }
  return { relPath, contentType };
}

/**
 * The document a bundle opens at: `index.html` at the root, else the one and only HTML file in it.
 * Ambiguity is refused rather than guessed — picking one of two pages would silently show the user
 * the wrong thing, and "name it index.html" is a fix the agent can act on.
 */
export function pickBundleEntry(relPaths: readonly string[]): string | null {
  if (relPaths.includes(ARTIFACT_BUNDLE_ENTRY)) return ARTIFACT_BUNDLE_ENTRY;
  const pages = relPaths.filter(
    (relPath) => bundleMemberContentType(relPath) === "text/html",
  );
  return pages.length === 1 ? pages[0] : null;
}

/**
 * Which kind of artifact a publish is. `kind` from the agent decides when it says anything;
 * otherwise the name does, so an agent that publishes `report.html` without reading the tool
 * description gets the bundle path instead of "that is not an image". Null = refuse.
 */
export function artifactKindFor(
  raw: unknown,
  name: string,
): ArtifactKind | null {
  if (raw === null || raw === undefined || raw === "") {
    if (/\.html?$/i.test(name)) return "html";
    if (/\.pdf$/i.test(name)) return "document";
    return "image";
  }
  if (typeof raw !== "string") return null;
  return (ARTIFACT_KINDS as readonly string[]).includes(raw)
    ? (raw as ArtifactKind)
    : null;
}

/**
 * Powerful features denied to the preview iframe (#291). The `allow` attribute's default is `'src'`,
 * NOT deny — a framed document always matches its own src origin, so without this a preview could
 * prompt for the camera and the prompt would render in harnesst's own chrome, attributed to
 * harnesst. Composition is an intersection and disabling is one-way (a child can never re-enable
 * what a parent turned off), so the app-wide `Permissions-Policy` header and this attribute
 * reinforce each other rather than either being redundant.
 */
export const ARTIFACT_PREVIEW_IFRAME_ALLOW = [
  "camera 'none'",
  "microphone 'none'",
  "geolocation 'none'",
  "display-capture 'none'",
  "midi 'none'",
  "payment 'none'",
  "usb 'none'",
  "serial 'none'",
  "xr-spatial-tracking 'none'",
].join("; ");

/** `charset` for the text types a bundle serves — without it a UTF-8 page renders as mojibake. */
export function artifactCharsetType(contentType: string): string {
  return contentType.startsWith("text/") || contentType === "application/json"
    ? `${contentType}; charset=utf-8`
    : contentType;
}

/**
 * Longest file name kept. Since #292 the name IS an identifier — `(session, name)` is what a
 * republish resolves to — so this cap is also the cap on that key, and the basename below is used
 * as published rather than being folded or rewritten: an agent that publishes `Chart.png` and
 * `chart.png` means two files, and matching them would silently overwrite one card with the other.
 */
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
  if (
    path !== ARTIFACT_HOME_ROOT &&
    !path.startsWith(`${ARTIFACT_HOME_ROOT}/`)
  ) {
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
    if (
      /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|\s)*<svg[\s>]/i.test(
        head,
      )
    ) {
      return "image/svg+xml";
    }
  }
  return null;
}

/**
 * A document type read from the bytes rather than its extension. A PDF header is the only format
 * admitted; the serving route sends documents as downloads, so no document-authored active content
 * executes in harnesst's origin.
 */
export function sniffArtifactDocumentContentType(
  bytes: Uint8Array,
): ArtifactDocumentContentType | null {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
    ? "application/pdf"
    : null;
}

/** Whether the serving route may render these bytes inline (see `ARTIFACT_INLINE_TYPES`). */
export function artifactRendersInline(contentType: string): boolean {
  return ARTIFACT_INLINE_TYPES.includes(contentType);
}

/** Whether this kind may use the cookie-authenticated single-file serving route. */
export function artifactIsSingleFileKind(
  kind: string,
): kind is "image" | "document" {
  return kind === "image" || kind === "document";
}

/**
 * The app path that serves one single-file artifact's bytes. Cookie-authenticated, same-origin;
 * documents use an attachment disposition rather than rendering inside harnesst.
 *
 * The VERSION belongs in the path (#292) rather than being left to default: an artifact's bytes
 * change when the agent republishes the name, and the response is served `immutable` — a URL that
 * meant "whatever is newest" would be cached forever as whatever it happened to be first. Omitting
 * it still resolves to the newest version, for a row whose latest version is somehow unknown.
 */
export function artifactUrl(
  projectId: string,
  artifactId: string,
  versionId?: string | null,
): string {
  const base = `/api/foh/${projectId}/artifact/${artifactId}`;
  return versionId ? `${base}/${versionId}` : base;
}

/**
 * The app path one bundle file is previewed at (#291). The token is IN THE PATH rather than a
 * cookie or a query string so that every subresource the page loads authenticates itself: a
 * sandboxed iframe is a null-origin, cookie-less context, and a query string would be dropped by
 * relative `href`/`src` resolution inside the page anyway.
 */
export function artifactPreviewPath(
  token: string,
  artifactId: string,
  relPath: string,
): string {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return `/artifacts/preview/${token}/${artifactId}/${encoded}`;
}
