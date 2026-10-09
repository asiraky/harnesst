import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const TEAM_ARTIFACTS_HOME = "/workspace/home";
export const TEAM_ARTIFACTS_DIR = "team-artifacts";
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_DEPTH = 8;

export type RelayResult =
  { ok: false; error: string } | { ok: true; [key: string]: unknown };

export interface WireFile {
  path: string;
  content: string;
  encoding: "base64";
}

/** A relative path made only of plain segments: no root, no `..`, no dotfiles. */
export function safeRelativePath(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw) return false;
  const segments = raw.split("/");
  return (
    segments.length <= MAX_DEPTH &&
    segments.every((segment) => segment.length <= 120 && SEGMENT.test(segment))
  );
}

export async function callTeamArtifacts(
  body: Record<string, unknown>,
): Promise<RelayResult> {
  const url = process.env.HARNESST_TEAM_ARTIFACTS_URL;
  const token = process.env.HARNESST_TEAM_TOKEN;
  if (!url || !token) {
    return {
      ok: false,
      error: "Team Artifacts is not configured for this deployment.",
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
        error: `Team Artifacts returned HTTP ${response.status} without JSON.`,
      };
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return {
        ok: false,
        error: "Team Artifacts returned an invalid response.",
      };
    }
    return result as RelayResult;
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach Team Artifacts: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function symlinkOnTheWay(destination: string): Promise<string | null> {
  let cursor = TEAM_ARTIFACTS_HOME;
  for (const segment of path
    .relative(TEAM_ARTIFACTS_HOME, destination)
    .split(path.sep)) {
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

/**
 * Write one fetched version into /workspace/home/team-artifacts/<folder>, replacing what an earlier
 * fetch left there. Staged in a scratch directory and swapped in whole, so a failed write never
 * leaves a half-old, half-new copy.
 */
export async function writeTeamArtifact(
  folder: unknown,
  files: unknown,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!safeRelativePath(folder) || folder.includes("/")) {
    return {
      ok: false,
      error: "Team Artifacts returned an unsafe folder name.",
    };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "Team Artifacts returned no files." };
  }
  for (const file of files as WireFile[]) {
    if (!safeRelativePath(file?.path) || typeof file.content !== "string") {
      return {
        ok: false,
        error: `Team Artifacts returned an unsafe file path: ${String(file?.path)}.`,
      };
    }
  }
  const destination = path.join(
    TEAM_ARTIFACTS_HOME,
    TEAM_ARTIFACTS_DIR,
    folder,
  );
  const link = await symlinkOnTheWay(destination);
  if (link) {
    return {
      ok: false,
      error: `The destination crosses a symbolic link at ${link}.`,
    };
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const stagingRoot = await mkdtemp(
    path.join(TEAM_ARTIFACTS_HOME, TEAM_ARTIFACTS_DIR, ".fetch-"),
  );
  const staging = path.join(stagingRoot, folder);
  try {
    for (const file of files as WireFile[]) {
      const output = path.join(staging, file.path);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, Buffer.from(file.content, "base64"));
    }
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return { ok: true, path: destination };
  } catch (error) {
    return {
      ok: false,
      error: `Could not write the artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}
