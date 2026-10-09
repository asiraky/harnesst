/**
 * Pure helpers the artifact cards and viewers share: what a file's type badge says and how it is
 * tinted, which shiki grammar reads it, and how its text splits into numbered lines. Isomorphic, no
 * React. The badge rules are ported from Omniplex (`typeFamily` / `badgeLabel` in
 * web/src/lib/artefacts.ts); the viewer choice itself lives in `~/foh/artifact-viewer`.
 */
import {
  ARTIFACT_AUDIO_EXTENSIONS,
  ARTIFACT_BROWSER_IMAGE_EXTENSIONS,
  ARTIFACT_CODE_EXTENSIONS,
  ARTIFACT_VIDEO_EXTENSIONS,
  artifactExtensionOf,
  artifactIsTextMedia,
  artifactMediaEssence,
  artifactReadsText,
  artifactViewerFor,
} from "~/foh/artifact-viewer";

/** The badge colour group — a hint at what kind of thing a file is, not a legend. */
export type ArtifactTypeFamily =
  | "html"
  | "doc"
  | "image"
  | "media"
  | "data"
  | "code"
  | "other";

const IMAGES = new Set([
  ...ARTIFACT_BROWSER_IMAGE_EXTENSIONS,
  "svg",
  "heic",
  "heif",
  "tif",
  "tiff",
  "psd",
]);
const MEDIA = new Set([
  ...ARTIFACT_AUDIO_EXTENSIONS,
  ...ARTIFACT_VIDEO_EXTENSIONS,
]);
const DOCS = new Set([
  "md",
  "markdown",
  "mdx",
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "txt",
  "pages",
  "ppt",
  "pptx",
  "odp",
  "key",
  "epub",
  "tex",
]);
const DATA = new Set([
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "geojson",
  "xls",
  "xlsx",
  "ods",
  "numbers",
  "parquet",
  "sqlite",
  "db",
  "arrow",
  "avro",
]);
const CODE = new Set(ARTIFACT_CODE_EXTENSIONS);

export function artifactTypeFamily(
  name: string,
  contentType: string,
): ArtifactTypeFamily {
  const ext = artifactExtensionOf(name);
  const mt = artifactMediaEssence(contentType);
  if (ext === "html" || ext === "htm" || mt === "text/html") return "html";
  if (IMAGES.has(ext) || mt.startsWith("image/")) return "image";
  if (MEDIA.has(ext) || mt.startsWith("audio/") || mt.startsWith("video/")) {
    return "media";
  }
  if (
    DOCS.has(ext) ||
    mt === "application/pdf" ||
    mt === "text/markdown" ||
    mt === "text/plain"
  ) {
    return "doc";
  }
  if (
    DATA.has(ext) ||
    mt === "text/csv" ||
    mt === "application/json" ||
    mt.includes("spreadsheet")
  ) {
    return "data";
  }
  if (CODE.has(ext) || artifactIsTextMedia(mt)) return "code";
  return "other";
}

/** The short label on a badge: the extension, or the media subtype when the name has none. */
export function artifactBadgeLabel(name: string, contentType: string): string {
  const ext = artifactExtensionOf(name);
  if (ext) return ext.slice(0, 5).toUpperCase();
  const sub = artifactMediaEssence(contentType).split("/")[1] ?? "";
  const tidy = sub.replace(/^x-/, "").split(/[.+-]/)[0] ?? "";
  if (!tidy || tidy === "octet") return "FILE";
  return tidy.slice(0, 5).toUpperCase();
}

export interface ArtifactBadge {
  label: string;
  family: ArtifactTypeFamily;
}

/**
 * The badge for a whole artifact. A page bundle's `name` is whatever directory the agent published
 * (`site`, `report.v2`), so its badge is decided by kind, not by a name that may carry no extension
 * or a misleading one.
 */
export function artifactBadge(input: {
  kind: string;
  name: string;
  contentType: string;
}): ArtifactBadge {
  if (input.kind === "html") return { label: "HTML", family: "html" };
  return {
    label: artifactBadgeLabel(input.name, input.contentType),
    family: artifactTypeFamily(input.name, input.contentType),
  };
}

/** Extension → shiki grammar id, where the two differ. Anything else is tried under its own name. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  hpp: "cpp",
  cc: "cpp",
  h: "c",
  sh: "bash",
  zsh: "bash",
  ps1: "powershell",
  bat: "bat",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  htm: "html",
  xhtml: "html",
  svg: "xml",
  xsl: "xml",
  gql: "graphql",
  geojson: "json",
  webmanifest: "json",
  ndjson: "jsonl",
  tf: "hcl",
  mk: "make",
  makefile: "make",
  patch: "diff",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  clj: "clojure",
  ml: "ocaml",
  cfg: "ini",
  conf: "ini",
  env: "dotenv",
  txt: "text",
  text: "text",
  log: "text",
  lock: "text",
};

/** Extension-less names that still say what they are. */
const LANGUAGE_BY_BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gemfile: "ruby",
  rakefile: "ruby",
  ".env": "dotenv",
};

/** Media types that name a grammar when the file name does not. */
const LANGUAGE_BY_MEDIA: Record<string, string> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "application/typescript": "typescript",
  "application/json": "json",
  "application/ld+json": "json",
  "application/x-ndjson": "jsonl",
  "application/xml": "xml",
  "text/xml": "xml",
  "image/svg+xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/toml": "toml",
  "application/sql": "sql",
  "application/graphql": "graphql",
  "application/x-sh": "bash",
  "application/x-shellscript": "bash",
  "application/x-python": "python",
};

/**
 * The shiki grammar for a file, from its name and then its media type, or "text" when nothing says.
 * The id may name a grammar the highlighter does not bundle — the code view then shows plain text.
 */
export function codeLanguageFor(name: string, contentType = ""): string {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const byBase = LANGUAGE_BY_BASENAME[base];
  if (byBase) return byBase;
  const ext = artifactExtensionOf(name);
  if (ext) return LANGUAGE_BY_EXTENSION[ext] ?? ext;
  return LANGUAGE_BY_MEDIA[artifactMediaEssence(contentType)] ?? "text";
}

/**
 * A file's lines for a numbered view. A trailing newline would otherwise yield one phantom empty
 * line nobody wrote; CRLF endings lose their CR so it does not render as a stray glyph.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Whether a page bundle's member is worth showing as text in the source view. Images, fonts and
 * other binaries are not: the source endpoint would hand back their bytes as mojibake.
 */
export function artifactMemberIsText(path: string, contentType: string): boolean {
  return artifactReadsText(artifactViewerFor(path, contentType), "source");
}
