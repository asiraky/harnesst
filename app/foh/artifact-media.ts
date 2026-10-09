/**
 * Artifact media rules (issues #290, #291) — the judgements that decide whether an agent's publish
 * is accepted, and how its bytes are typed and served. All pure, so they unit-test with no docker,
 * no disk and no database.
 *
 * WHAT MAY BE PUBLISHED: a path inside the agent's own home volume, holding either an image, a PDF
 * document, a small static PAGE BUNDLE (an `index.html` plus its css/js/font/image siblings), or —
 * since the `file` kind — ANY other file, which is stored and offered for download or for one of the
 * text/data/media viewers (`artifact-viewer.ts`).
 *
 * What makes accepting anything safe is that the SERVING decision no longer trusts the type to be
 * inert. Every single-file response is built by `artifactServePolicy` from the stored content type:
 * raster images, audio and video go out as themselves; PDFs inline for the browser's own viewer;
 * SVG inline under a header `sandbox` CSP (no script, even on a top-level navigation); every text
 * format — markdown, CSV, JSON, code, and HTML that arrived as a single `file` — as
 * `text/plain; charset=utf-8`; anything else as an attachment. All of it with `nosniff`. No door
 * the cookie reaches ever sends agent-authored bytes as `text/html`.
 *
 * TYPING. An `image` or `document` publish is still SNIFFED and refused when the bytes disagree —
 * those kinds promise a renderable picture or PDF, and the sniff keeps that promise honest. A `file`
 * is typed by its EXTENSION first (`artifactMediaTypeFromName`) with the sniff as fallback: sniffing
 * cannot tell markdown from plain text or CSV from anything, and it gets some things actively wrong
 * (a TypeScript `.ts` sniffs as `video/mp2t`). Because serving keys off the stored type rather than
 * trusting it, a lying extension can only produce a broken preview, never active content.
 *
 * A bundle's HTML, CSS and JS have no magic bytes at all, so its members take their type from the
 * extension against a closed allowlist, and the bytes are only ever served by the preview and share
 * routes, whose responses carry `Content-Security-Policy: sandbox allow-scripts …` (see
 * `artifact-preview.server.ts`). Header-level `sandbox` survives a top-level navigation, which is
 * what makes serving agent-authored HTML safe; the cookie route refuses bundle rows outright. Image
 * members are still cross-checked against the sniff — an extension allowlist is a weaker claim than
 * magic bytes, so where magic exists it is required to agree.
 *
 * Client+server safe: no node builtins, no server imports.
 */
import {
  artifactIsTextMedia,
  artifactMediaEssence,
  ARTIFACT_CODE_EXTENSIONS,
  ARTIFACT_PLAIN_TEXT_EXTENSIONS,
  artifactViewerFor,
} from "~/foh/artifact-viewer";
import { truncateUtf8 } from "~/foh/artifact-source";

/**
 * Hard ceiling on one artifact (a single file, or a bundle's total). A publish whose bytes ride in
 * the request body base64-encodes them, which the edge's `client_max_body_size 40m`
 * (nginx-harnesst.conf) still admits at this size.
 */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Ceiling on bytes the tool carries IN the publish request (a PDF `document`, or a `file`) — read by
 * the tool from its own, possibly subagent, sandbox. The same 25 MB as everything else: the request
 * route's body cap is derived from it (base64 + framing ≈ 33.4 MiB, under the edge's 40m).
 */
export const ARTIFACT_DOCUMENT_MAX_BYTES = ARTIFACT_MAX_BYTES;

/**
 * The only directory tree an agent may publish out of: its own persistent home, which the
 * eve-docker shim mounts into every session sandbox at the same path. That is what makes the
 * agent-browser flow work unchanged — its screenshots land in
 * `/workspace/home/agent-browser/screenshots` — without the tool needing to copy files first.
 */
export const ARTIFACT_HOME_ROOT = "/workspace/home";

/** The image formats an `image` publish may be. Ordered by how they are sniffed below. */
export const ARTIFACT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
] as const;

export type ArtifactContentType = (typeof ARTIFACT_CONTENT_TYPES)[number];

/** Documents a single-file publish may contain. Deliberately PDF-only for the first release. */
export const ARTIFACT_DOCUMENT_CONTENT_TYPES = ["application/pdf"] as const;
export type ArtifactDocumentContentType =
  (typeof ARTIFACT_DOCUMENT_CONTENT_TYPES)[number];

/**
 * What a published artifact IS, and the row's `kind` column. `image` and `document` are single
 * sniffed files, `file` is a single file of any type (typed by extension), all three served by the
 * cookie-authenticated artifact route under `artifactServePolicy`; `html` is a page bundle served
 * only through the sandboxed, token-authenticated preview and share routes.
 */
export const ARTIFACT_KINDS = ["image", "html", "document", "file"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Most files a page bundle may hold. A page, not a site — see the byte cap above for the rest. */
export const ARTIFACT_BUNDLE_MAX_FILES = 40;

/** The entry document of a multi-file bundle, by convention and by web convention. */
export const ARTIFACT_BUNDLE_ENTRY = "index.html";

/**
 * The closed allowlist of bundle member types, keyed by lowercase extension: the static assets a
 * rendered page plausibly loads — markup, styles, scripts, fonts, images, small media, data files
 * and wasm. Executables, archives and other container formats (zip, pdf, exe, sh) stay off it; an
 * unlisted extension is refused rather than skipped, because silently dropping a font or a
 * stylesheet would show the user a page that renders wrong for no visible reason, and the agent
 * owns the directory it asked us to publish.
 *
 * Data files (`json`, `csv`, `md`, `txt`) are here because a page may now READ them: the preview's
 * CSP no longer closes `connect-src`, and its responses carry `Access-Control-Allow-Origin: *` so
 * the sandbox's opaque origin can `fetch('./data.json')` a sibling (see `artifact-preview.server.ts`).
 */
const BUNDLE_MEMBER_TYPES: Readonly<Record<string, string>> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  wasm: "application/wasm",
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

/** Extensions a kind-less publish treats as an `image` (and so sniffs as one). */
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|svg)$/i;

/**
 * Which kind of artifact a publish is. `kind` from the agent decides when it says anything;
 * otherwise the name does — `.html` a page, `.pdf` a document, an image extension an image, and
 * ANYTHING ELSE a `file`. (Before the `file` kind existed the fallback was "image", which turned
 * every CSV into "that is not a PNG".) Null = an unknown kind word; refuse.
 */
export function artifactKindFor(
  raw: unknown,
  name: string,
): ArtifactKind | null {
  if (raw === null || raw === undefined || raw === "") {
    if (/\.html?$/i.test(name)) return "html";
    if (/\.pdf$/i.test(name)) return "document";
    if (IMAGE_NAME.test(name)) return "image";
    return "file";
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
  if (contentType.includes(";")) return contentType;
  return contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType.endsWith("+json")
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

/** The `ftyp` box an ISO-BMFF file (MP4, MOV, M4A, AVIF, HEIC) opens with, or null. */
function isoBrands(
  bytes: Uint8Array,
): { major: string; brands: string[] } | null {
  if (bytes.length < 12 || tagAt(bytes, 4) !== "ftyp") return null;
  const boxSize =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = Math.min(bytes.length, Math.max(boxSize, 12), 256);
  const brands: string[] = [];
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(tagAt(bytes, offset));
  }
  return { major: tagAt(bytes, 8), brands };
}

function isAvif(bytes: Uint8Array): boolean {
  const iso = isoBrands(bytes);
  if (!iso) return false;
  if (iso.major === "avif" || iso.major === "avis") return true;
  return (
    (iso.major === "mif1" || iso.major === "msf1") &&
    iso.brands.some((brand) => brand === "avif" || brand === "avis")
  );
}

/**
 * The content type the BYTES are, or null when they are not a supported image. PNG, JPEG, WebP,
 * GIF and AVIF have unambiguous magic; SVG is XML, so it is recognised by a root `<svg` element
 * near the head of the document and only when the file also claims to be one by name — a text file
 * that merely contains an `<svg` snippet is not an image.
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
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (isAvif(bytes)) return "image/avif";
  if (name.toLowerCase().endsWith(".svg")) {
    // Read only the head: an SVG's root element is at the top, after an optional BOM, XML
    // declaration, doctype or comments, and scanning megabytes for it buys nothing.
    const head = new TextDecoder("utf-8", { fatal: false })
      .decode(bytes.slice(0, 4096))
      .replace(/^\uFEFF/, "")
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
 * admitted for the `document` kind; anything else is a `file`.
 */
export function sniffArtifactDocumentContentType(
  bytes: Uint8Array,
): ArtifactDocumentContentType | null {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
    ? "application/pdf"
    : null;
}

/**
 * Media types by extension for a `file` publish — the formats whose type a viewer or a browser
 * actually cares about. Code and plain-text extensions not listed resolve to `text/plain` (see
 * `artifactMediaTypeFromName`). Stored WITHOUT a charset: the serving policy adds one where it
 * sends text.
 */
const FILE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mdx: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  geojson: "application/geo+json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  webmanifest: "application/manifest+json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  txt: "text/plain",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  go: "text/x-go",
  py: "text/x-python",
  sh: "text/x-shellscript",
  sql: "text/x-sql",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  wasm: "application/wasm",
};

const TEXT_EXTENSIONS = new Set([
  ...ARTIFACT_CODE_EXTENSIONS,
  ...ARTIFACT_PLAIN_TEXT_EXTENSIONS,
]);

/** The media type a file's NAME declares, or null when the extension is not one harnesst knows. */
export function artifactMediaTypeFromName(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    // `Dockerfile`, `Makefile`: named for what they are, read as text.
    return base === "dockerfile" || base === "makefile" ? "text/plain" : null;
  }
  const ext = base.slice(dot + 1);
  return (
    FILE_MEDIA_TYPES[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain" : null)
  );
}

/**
 * The media type the BYTES are, beyond the image/PDF sniffs: the common audio/video containers and
 * archives, then "decodes as UTF-8 with no NUL in the head" for text. Null = unrecognised binary.
 */
export function sniffArtifactFileContentType(
  bytes: Uint8Array,
  name: string,
): string | null {
  const image = sniffArtifactContentType(bytes, name);
  if (image) return image;
  if (sniffArtifactDocumentContentType(bytes)) return "application/pdf";
  const iso = isoBrands(bytes);
  if (iso) {
    if (iso.major === "qt  ") return "video/quicktime";
    if (iso.major.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (tagAt(bytes, 0) === "OggS") return "audio/ogg";
  if (tagAt(bytes, 0) === "fLaC") return "audio/flac";
  if (
    bytes.length >= 12 &&
    tagAt(bytes, 0) === "RIFF" &&
    tagAt(bytes, 8) === "WAVE"
  ) {
    return "audio/wav";
  }
  if (
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  ) {
    return "audio/mpeg";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  return looksLikeText(bytes) ? "text/plain" : null;
}

/** UTF-8 with no NUL in the first 8 KiB — the usual "is this text" test. An empty file is text. */
function looksLikeText(bytes: Uint8Array): boolean {
  // Cut at a character boundary so a multi-byte sequence split at 8 KiB is not "invalid".
  const head = truncateUtf8(bytes, 8192).bytes;
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}

/**
 * The content type stored for a `file` publish: the name's declared type first (a sniff cannot
 * tell markdown from CSV, and calls a `.ts` file an MPEG transport stream), the sniff when the
 * name says nothing, `application/octet-stream` when neither does. Never refuses — any file may
 * be a `file`; `artifactServePolicy` is what keeps an unrecognised one from rendering.
 */
export function resolveArtifactFileContentType(
  name: string,
  bytes: Uint8Array,
): string {
  return (
    artifactMediaTypeFromName(name) ??
    sniffArtifactFileContentType(bytes, name) ??
    "application/octet-stream"
  );
}

/** Raster types a browser renders as a picture and nothing else — safe to hand over as themselves. */
const INERT_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export interface ArtifactServePolicy {
  /** `inline` renders in the browser (or an `<img>`/`<video>`/`<iframe>`); `attachment` downloads. */
  disposition: "inline" | "attachment";
  /** The `Content-Type` to SEND — not always the stored one (text goes out as `text/plain`). */
  contentType: string;
  /**
   * Whether the response must carry a `sandbox` CSP. True for everything that is not a raster,
   * a PDF or audio/video: a document that could be active content (SVG, a misnamed HTML) runs no
   * script and gets an opaque origin even when opened as a top-level page.
   */
  sandbox: boolean;
  /**
   * Whether the app itself may FRAME the response (the panel's PDF viewer). Only a PDF needs to be
   * embedded as a document; everything else is shown via an element or fetched as text.
   */
  embeddable: boolean;
}

/**
 * How a single stored file goes out on the wire — the one decision both the cookie route and the
 * public share route make, pure so the matrix is unit-tested.
 *
 *   - `download` → an attachment, whatever it is.
 *   - PDF → inline, NO sandbox CSP (Chrome's built-in viewer renders a blank page under one), and
 *     embeddable by the app. A PDF's own scripting runs inside the browser's PDF viewer, not
 *     against the page origin — the same call Omniplex makes.
 *   - Inert raster images → inline, as themselves.
 *   - Audio/video → inline, as themselves, no CSP (a media document does not need one, and some
 *     engines treat a sandboxed media document as an error page).
 *   - SVG → inline as `image/svg+xml` but sandboxed: an `<img>` never runs its script anyway, and a
 *     direct navigation to it now runs none either.
 *   - Text a viewer reads (markdown, CSV, JSON, code, a single-file HTML) → `text/plain;
 *     charset=utf-8`, sandboxed. The viewers fetch it and render it themselves; the browser never
 *     gets to interpret it as markup.
 *   - Anything else → an attachment.
 */
export function artifactServePolicy(input: {
  name: string;
  contentType: string;
  download?: boolean;
}): ArtifactServePolicy {
  const stored =
    artifactMediaEssence(input.contentType) || "application/octet-stream";
  if (input.download) {
    return {
      disposition: "attachment",
      contentType: stored,
      sandbox: true,
      embeddable: false,
    };
  }
  if (stored === "application/pdf") {
    return {
      disposition: "inline",
      contentType: stored,
      sandbox: false,
      embeddable: true,
    };
  }
  if (INERT_IMAGE_TYPES.has(stored)) {
    return {
      disposition: "inline",
      contentType: stored,
      sandbox: false,
      embeddable: false,
    };
  }
  if (stored.startsWith("audio/") || stored.startsWith("video/")) {
    return {
      disposition: "inline",
      contentType: stored,
      sandbox: false,
      embeddable: false,
    };
  }
  if (stored === "image/svg+xml") {
    return {
      disposition: "inline",
      contentType: stored,
      sandbox: true,
      embeddable: false,
    };
  }
  const viewer = artifactViewerFor(input.name, stored);
  if (
    artifactIsTextMedia(stored) ||
    viewer === "markdown" ||
    viewer === "csv" ||
    viewer === "json" ||
    viewer === "text"
  ) {
    return {
      disposition: "inline",
      contentType: "text/plain; charset=utf-8",
      sandbox: true,
      embeddable: false,
    };
  }
  return {
    disposition: "attachment",
    contentType: stored,
    sandbox: true,
    embeddable: false,
  };
}

/** A quoted `filename` for a disposition header — never the raw agent-supplied name. */
export function safeArtifactFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "artifact";
}

/** Whether this kind may use the cookie-authenticated single-file serving route. */
export function artifactIsSingleFileKind(
  kind: string,
): kind is "image" | "document" | "file" {
  return kind === "image" || kind === "document" || kind === "file";
}

/**
 * The app path that serves one single-file artifact's bytes. Cookie-authenticated, same-origin;
 * what the response renders as is `artifactServePolicy`'s call.
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
 * `artifactUrl` with the download switch: `?download=1` makes the route answer with an attachment
 * disposition whatever the type. Accepts the same row-ish ids the entries carry.
 */
export function artifactRawUrl(
  projectId: string,
  artifactId: string,
  versionId?: string | null,
  options: { download?: boolean } = {},
): string {
  const url = artifactUrl(projectId, artifactId, versionId);
  return options.download ? `${url}?download=1` : url;
}

/**
 * The app path of an artifact's SOURCE (`api.foh.artifact-source.ts`): without `path` the JSON file
 * listing of a version, with it one file's text (capped, `text/plain`). Works for every kind — a
 * bundle's members and a single file's one member alike.
 */
export function artifactSourceUrl(
  projectId: string,
  artifactId: string,
  versionId?: string | null,
  path?: string | null,
): string {
  const base = `/api/foh/${projectId}/artifact/${artifactId}/source`;
  const url = versionId ? `${base}/${versionId}` : base;
  return path ? `${url}?path=${encodeURIComponent(path)}` : url;
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
