import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const ASSET_MAX_FILES = 40;
export const ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const ASSET_HOME = "/workspace/home";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const EXTENSIONS = new Set([
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
]);

export type RelayResult =
  { ok: false; error: string } | { ok: true; [key: string]: unknown };

export interface WireFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

function validSegments(raw: string, maxLength: number): boolean {
  return (
    raw.length > 0 &&
    raw.length <= maxLength &&
    !raw.startsWith("/") &&
    !raw.endsWith("/") &&
    raw.split("/").length <= 8 &&
    raw.split("/").every((segment) => SEGMENT.test(segment))
  );
}

export function validAssetId(raw: string): boolean {
  return validSegments(raw, 240);
}

export function validAssetFile(raw: string): boolean {
  if (!validSegments(raw, 500)) return false;
  const name = raw.slice(raw.lastIndexOf("/") + 1);
  if (name.toLowerCase() === "manifest.json") return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export async function callAssetRelay(
  body: Record<string, unknown>,
): Promise<RelayResult> {
  const url = process.env.HARNESST_ASSETS_URL;
  const token = process.env.HARNESST_TEAM_TOKEN;
  if (!url || !token) {
    return {
      ok: false,
      error: "The Asset Library is not configured for this deployment.",
    };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let result: unknown;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      return {
        ok: false,
        error: `The Asset Library returned HTTP ${response.status} without JSON.`,
      };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return {
        ok: false,
        error: "The Asset Library returned an invalid response.",
      };
    }
    return result as RelayResult;
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the Asset Library: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function homePath(raw: string): string | null {
  const resolved = path.resolve(ASSET_HOME, raw);
  return resolved.startsWith(`${ASSET_HOME}/`) ? resolved : null;
}

export async function readAssetDirectory(
  rawSource: string,
): Promise<
  | { ok: true; sourcePath: string; files: WireFile[] }
  | { ok: false; error: string }
> {
  const sourcePath = homePath(rawSource);
  if (!sourcePath)
    return {
      ok: false,
      error: "The source directory must be under /workspace/home.",
    };
  try {
    const root = await lstat(sourcePath);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return {
        ok: false,
        error: "Asset source must be a real directory, not a file or link.",
      };
    }
    const [realHome, realSource] = await Promise.all([
      realpath(ASSET_HOME),
      realpath(sourcePath),
    ]);
    if (!realSource.startsWith(`${realHome}/`)) {
      return {
        ok: false,
        error:
          "The source directory crosses a symbolic link outside /workspace/home.",
      };
    }
    const files: WireFile[] = [];
    let total = 0;
    const walk = async (
      directory: string,
      prefix: string,
    ): Promise<string | null> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!SEGMENT.test(entry.name))
          return `Unexpected asset path: ${relative}.`;
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink())
          return `Asset ${relative} is a link; links are not allowed.`;
        if (info.isDirectory()) {
          if (relative.split("/").length >= 8)
            return `Asset path ${relative} is nested too deeply.`;
          const error = await walk(absolute, relative);
          if (error) return error;
          continue;
        }
        if (!info.isFile()) return `Asset ${relative} is not a regular file.`;
        if (!validAssetFile(relative))
          return `Asset ${relative} has an unexpected name or extension.`;
        if (files.length >= ASSET_MAX_FILES)
          return `An asset can hold at most ${ASSET_MAX_FILES} files.`;
        const bytes = await readFile(absolute);
        total += bytes.length;
        if (total > ASSET_MAX_BYTES)
          return "An asset can hold at most 25 MB of file content.";
        files.push({
          path: relative,
          content: bytes.toString("base64"),
          encoding: "base64",
        });
      }
      return null;
    };
    const error = await walk(sourcePath, "");
    if (error) return { ok: false, error };
    if (files.length === 0)
      return { ok: false, error: "The source directory contains no files." };
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, sourcePath, files };
  } catch (error) {
    return {
      ok: false,
      error: `Could not read the asset directory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function refuseSymlinkParents(
  destination: string,
): Promise<string | null> {
  const relative = path.relative(ASSET_HOME, destination);
  let cursor = ASSET_HOME;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return null;
}

export async function writeDownloadedAsset(
  id: string,
  files: WireFile[],
  rawDestination?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const destination = homePath(rawDestination ?? `shared-assets/${id}`);
  if (!destination)
    return {
      ok: false,
      error: "The destination must be under /workspace/home.",
    };
  const link = await refuseSymlinkParents(destination);
  if (link)
    return {
      ok: false,
      error: `The destination crosses a symbolic link at ${link}.`,
    };
  const stagingRoot = await mkdtemp(`${ASSET_HOME}/asset-download-`);
  const staging = path.join(stagingRoot, "asset");
  try {
    await mkdir(staging, { recursive: true });
    for (const file of files) {
      if (!validAssetFile(file.path)) {
        return {
          ok: false,
          error: `The relay returned an unsafe file path: ${file.path}.`,
        };
      }
      const bytes =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : Buffer.from(file.content, "utf8");
      const output = path.join(staging, file.path);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return { ok: true, path: destination };
  } catch (error) {
    return {
      ok: false,
      error: `Could not write the downloaded asset: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
