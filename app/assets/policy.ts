/** Pure validation and limits for the repo-backed asset library (issue #322). */
import { createHash } from "node:crypto";

export const ASSET_ROOT = "assets";
export const ASSET_MAX_FILES = 40;
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const ASSET_MAX_ID_LENGTH = 240;
export const ASSET_MAX_PATH_LENGTH = 500;
export const ASSET_MAX_DEPTH = 8;

/**
 * Publish-artifact's static-page formats plus the docs/config formats this shared store exists
 * for. Archives and executable/container formats remain deliberately outside the closed list.
 */
export const ASSET_EXTENSIONS = [
  "css",
  "csv",
  "gif",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "js",
  "json",
  "map",
  "md",
  "mjs",
  "otf",
  "pdf",
  "png",
  "svg",
  "toml",
  "ttf",
  "txt",
  "webp",
  "woff",
  "woff2",
  "xml",
  "yaml",
  "yml",
] as const;

const EXTENSIONS = new Set<string>(ASSET_EXTENSIONS);
const TEXT_EXTENSIONS = new Set([
  "css",
  "csv",
  "htm",
  "html",
  "js",
  "json",
  "map",
  "md",
  "mjs",
  "svg",
  "toml",
  "txt",
  "xml",
  "yaml",
  "yml",
]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function normalizeSegments(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLength)
    return null;
  if (raw !== raw.trim() || raw.startsWith("/") || raw.endsWith("/"))
    return null;
  const segments = raw.split("/");
  if (segments.length === 0 || segments.length > ASSET_MAX_DEPTH) return null;
  if (segments.some((segment) => !SEGMENT.test(segment))) return null;
  return segments.join("/");
}

/** An asset id is always relative to assets/ and cannot be decoded into another path. */
export function normalizeAssetId(raw: unknown): string | null {
  return normalizeSegments(raw, ASSET_MAX_ID_LENGTH);
}

/** A store-owned manifest can never be smuggled in as asset content. */
export function normalizeAssetFilePath(raw: unknown): string | null {
  const path = normalizeSegments(raw, ASSET_MAX_PATH_LENGTH);
  if (!path) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.toLowerCase() === "manifest.json") return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !EXTENSIONS.has(name.slice(dot + 1).toLowerCase()))
    return null;
  return path;
}

export function isTextAssetPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function assetRepoPrefix(id: string): string {
  return `${ASSET_ROOT}/${id}/`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Buffer.from(base64) is deliberately lenient; asset uploads require canonical encoding. */
export function decodeBase64(raw: string): Buffer | null {
  if (raw.length === 0) return Buffer.alloc(0);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw,
    )
  ) {
    return null;
  }
  const bytes = Buffer.from(raw, "base64");
  return bytes.toString("base64") === raw ? bytes : null;
}
