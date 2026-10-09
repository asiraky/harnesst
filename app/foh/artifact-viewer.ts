/**
 * Which viewer shows a published artifact — pure, isomorphic, no server imports, so the transcript
 * card, the preview panel and the serving routes all classify a file the same way. Ported from
 * Omniplex's `viewerFor` (web/src/lib/artefacts.ts).
 *
 * The EXTENSION is asked first and the media type only decides what the name cannot. Agents and
 * byte sniffers are both sloppy with types — a `.ts` file sniffs as `video/mp2t`, a `.md` arrives as
 * `application/octet-stream` — while the name is whatever the author called it. That ordering is a
 * DISPLAY decision only: what the serving routes put on the wire is decided from the stored content
 * type (`artifactServePolicy` in `artifact-media.ts`), and a viewer that guesses wrong renders a
 * broken preview, never a live document.
 */

export const ARTIFACT_VIEWERS = [
  "html",
  "markdown",
  "svg",
  "image",
  "audio",
  "video",
  "pdf",
  "csv",
  "json",
  "text",
  "file",
] as const;

export type ArtifactViewer = (typeof ARTIFACT_VIEWERS)[number];

/** Preview (rendered) or source (the file's text) — the panel's toggle for `artifactHasSourceView`. */
export type ArtifactViewMode = "preview" | "source";

/** Raster formats every current browser renders in an `<img>`. */
export const ARTIFACT_BROWSER_IMAGE_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
];
export const ARTIFACT_AUDIO_EXTENSIONS: readonly string[] = [
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  "opus",
  "weba",
];
export const ARTIFACT_VIDEO_EXTENSIONS: readonly string[] = [
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
];
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const JSON_EXTENSIONS = new Set(["json", "geojson", "jsonc", "webmanifest"]);

/** Things a person reads as code — the text viewer shows them with line numbers. */
export const ARTIFACT_CODE_EXTENSIONS: readonly string[] = [
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "go",
  "rs",
  "py",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "lua",
  "r",
  "scala",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "ml",
  "zig",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "css",
  "scss",
  "sass",
  "less",
  "sql",
  "graphql",
  "gql",
  "proto",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "xsl",
  "vue",
  "svelte",
  "astro",
  "tf",
  "hcl",
  "dockerfile",
  "makefile",
  "mk",
  "cmake",
  "gradle",
  "diff",
  "patch",
  "vim",
  "nix",
  "jsonl",
  "ndjson",
];

/** Text that is neither code nor a format with its own viewer. */
export const ARTIFACT_PLAIN_TEXT_EXTENSIONS: readonly string[] = [
  "txt",
  "log",
  "text",
  "rst",
  "adoc",
  "org",
  "srt",
  "vtt",
  "lock",
];

const BROWSER_IMAGES = new Set(ARTIFACT_BROWSER_IMAGE_EXTENSIONS);
const AUDIO = new Set(ARTIFACT_AUDIO_EXTENSIONS);
const VIDEO = new Set(ARTIFACT_VIDEO_EXTENSIONS);
const TEXT = new Set([
  ...ARTIFACT_CODE_EXTENSIONS,
  ...ARTIFACT_PLAIN_TEXT_EXTENSIONS,
]);

/** `application/*` types that are text a person can read. */
const TEXTY_APPLICATION = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/ecmascript",
  "application/typescript",
  "application/x-typescript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/graphql",
  "application/x-httpd-php",
  "application/x-python",
  "application/x-ndjson",
  "application/ld+json",
]);

/** Lower-cased extension of a name's basename without the dot, or "" when there is none. */
export function artifactExtensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

/** The media type without parameters: `text/plain; charset=utf-8` → `text/plain`. */
export function artifactMediaEssence(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** Whether a media type is text a person reads (and the serving routes may send as `text/plain`). */
export function artifactIsTextMedia(contentType: string): boolean {
  const mt = artifactMediaEssence(contentType);
  return (
    mt.startsWith("text/") ||
    mt.endsWith("+json") ||
    mt.endsWith("+xml") ||
    TEXTY_APPLICATION.has(mt)
  );
}

/**
 * Which viewer shows a file, from its name and stored content type. For an html BUNDLE pass the
 * entry's name (or use `artifactViewerForArtifact`, which knows the bundle kind always opens as a
 * page whatever the directory is called).
 */
export function artifactViewerFor(
  name: string,
  contentType: string,
): ArtifactViewer {
  const ext = artifactExtensionOf(name);
  const mt = artifactMediaEssence(contentType);
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "html";
  if (MARKDOWN.has(ext)) return "markdown";
  if (ext === "svg") return "svg";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (JSON_EXTENSIONS.has(ext)) return "json";
  if (BROWSER_IMAGES.has(ext)) return "image";
  if (AUDIO.has(ext)) return "audio";
  if (VIDEO.has(ext)) return "video";
  if (TEXT.has(ext)) return "text";

  if (mt === "text/html" || mt === "application/xhtml+xml") return "html";
  if (mt === "text/markdown" || mt === "text/x-markdown") return "markdown";
  if (mt === "image/svg+xml") return "svg";
  if (mt === "application/pdf") return "pdf";
  if (mt === "text/csv" || mt === "text/tab-separated-values") return "csv";
  if (mt === "application/json" || mt.endsWith("+json")) return "json";
  if (
    [
      "png",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "bmp",
      "x-icon",
      "vnd.microsoft.icon",
    ].some((sub) => mt === `image/${sub}`)
  ) {
    return "image";
  }
  if (mt.startsWith("audio/")) return "audio";
  if (mt.startsWith("video/")) return "video";
  if (artifactIsTextMedia(mt)) return "text";
  return "file";
}

/**
 * The viewer for a whole artifact row. A page bundle is always a page — its `name` is the
 * directory (or file) the agent published, which may carry no extension or a misleading one.
 */
export function artifactViewerForArtifact(input: {
  kind: string;
  name: string;
  contentType: string;
}): ArtifactViewer {
  if (input.kind === "html") return "html";
  return artifactViewerFor(input.name, input.contentType);
}

/** Whether a viewer has a rendered form and a source form to flip between. */
export function artifactHasSourceView(viewer: ArtifactViewer): boolean {
  return (
    viewer === "html" ||
    viewer === "markdown" ||
    viewer === "svg" ||
    viewer === "csv" ||
    viewer === "json"
  );
}

/**
 * Whether the viewer reads the file's TEXT (fetches bytes and renders them itself) rather than
 * pointing an element (`img`, `video`, `iframe`) at a URL. In source mode the page and SVG viewers
 * read text too.
 */
export function artifactReadsText(
  viewer: ArtifactViewer,
  mode: ArtifactViewMode = "preview",
): boolean {
  if (
    viewer === "markdown" ||
    viewer === "csv" ||
    viewer === "json" ||
    viewer === "text"
  ) {
    return true;
  }
  return (viewer === "html" || viewer === "svg") && mode === "source";
}
