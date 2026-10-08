/**
 * Chat attachment rules shared by the composer (fast feedback before upload) and the stream
 * routes (the actual enforcement). Pure — no DOM, no node — so both sides import it.
 */

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Extensions we treat as text when the browser reports no (or a generic) media type. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "xml", "html",
  "htm", "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "graphql",
  "proto", "ini", "env", "log", "diff", "patch", "vue", "svelte", "lua", "r", "dart", "ex", "exs",
  "tf", "dockerfile", "gitignore",
]);

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
  "application/graphql",
]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot > 0 || (dot === 0 && base.length > 1)
    ? base.slice(dot + 1).toLowerCase()
    : "";
}

/**
 * The media type we'll send to the agent for a file, or null when it isn't allowed. Browsers
 * report `""` or `application/octet-stream` for most source files, so text falls back to the
 * extension and is normalised to `text/plain` (models accept text/plain everywhere; exotic text/*
 * subtypes are hit-and-miss).
 */
export function resolveAttachmentMediaType(
  name: string,
  reported: string,
): string | null {
  const type = reported.toLowerCase().split(";")[0]!.trim();
  if (IMAGE_MEDIA_TYPES.has(type)) return type;
  if (type === "application/pdf") return type;
  if (type === "image/jpg") return "image/jpeg";
  const ext = extensionOf(name);
  if (!type || type === "application/octet-stream") {
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "pdf") return "application/pdf";
  }
  if (type.startsWith("text/") || TEXT_MEDIA_TYPES.has(type) || TEXT_EXTENSIONS.has(ext))
    return "text/plain";
  return null;
}

export function isImageMediaType(mediaType: string): boolean {
  return IMAGE_MEDIA_TYPES.has(mediaType);
}

export interface AttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

export interface AttachmentRejection {
  name: string;
  reason: string;
}

/**
 * Which of `incoming` fit alongside `existing` under the count/size/type limits. Order is kept;
 * the first files win when the batch overflows the count or total budget.
 */
export function admitAttachments<T extends AttachmentCandidate>(
  existing: readonly AttachmentCandidate[],
  incoming: readonly T[],
): { accepted: T[]; rejected: AttachmentRejection[] } {
  const accepted: T[] = [];
  const rejected: AttachmentRejection[] = [];
  let count = existing.length;
  let total = existing.reduce((sum, f) => sum + f.size, 0);
  for (const file of incoming) {
    if (!resolveAttachmentMediaType(file.name, file.type)) {
      rejected.push({ name: file.name, reason: "unsupported file type" });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: file.name, reason: "file is empty" });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: "larger than 10 MB" });
      continue;
    }
    if (count >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: `max ${MAX_ATTACHMENTS} files` });
      continue;
    }
    if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejected.push({ name: file.name, reason: "over the 25 MB total" });
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }
  return { accepted, rejected };
}
