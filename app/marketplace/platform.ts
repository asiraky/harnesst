/**
 * The publish-time platform-file gate (issue #254) — the enforcement half of the `harnesst/`
 * ownership rule.
 *
 * `harnesst/` holds platform code written by the marketplace installer and by nothing else. The
 * assistant and the editors refuse those paths outright (`platformPathRefusal`), but a direct push
 * to the repo answers to nobody — and a hand-"fixed" platform file is the worst possible state:
 * it works until the next marketplace update silently overwrites it, which is exactly how two live
 * agents lost the only mechanism that woke them. So publish re-derives the truth from disk: every
 * platform file the published tree will carry must hash to what its install RECORDED
 * (`InstallEntry.platformFiles`), and a file no install owns is just as much a failure as one whose
 * bytes moved. Unknown-is-a-failure is deliberate — "some other file appeared under `harnesst/`"
 * has no benign cause, and the permissive variant would let a hand-authored platform file live
 * indefinitely until an update fought with it.
 *
 * The one exemption is the generated model module: harnesst's own scaffold emits it, no install
 * owns it, and a strict gate without the carve-out would fail every publish of every repo.
 *
 * Pure and unit-testable: no I/O, no store, no GitHub. The caller resolves the bytes (drafts win
 * over the branch, because the change-set is what is about to land) and hands them in.
 * Server-only by way of the sha256 helper — nothing client-side imports this.
 */
import { isOrgModelModulePath } from "~/eve/org-model-module";
import { isPlatformPath } from "~/eve/parse";

import { platformFileHash } from "./hash.server";
import type { HarnesstLock } from "./lock";

/**
 * Every platform path this publish is accountable for: the branch tree overlaid with the
 * change-set, since the two together are the tree that is about to exist. A draft that DELETES a
 * platform path drops it from the check — that is what an uninstall stages, and the lock entry
 * carrying its recorded hash goes away in the same change-set.
 *
 * Paths here are already repo-relative and normalized (git tree entries and draft paths both are),
 * which is what `isPlatformPath` expects. Sorted so a multi-file failure reads the same every time.
 */
export function platformPathsUnderCheck(
  repoPaths: readonly string[],
  drafts: readonly { path: string; content: string | null }[],
): string[] {
  const checkable = (path: string): boolean =>
    isPlatformPath(path) && !isOrgModelModulePath(path);
  const paths = new Set(repoPaths.filter(checkable));
  for (const draft of drafts) {
    if (!checkable(draft.path)) continue;
    if (draft.content === null) paths.delete(draft.path);
    else paths.add(draft.path);
  }
  return [...paths].sort();
}

/**
 * Repo-relative path → the sha256 the owning install recorded when it wrote the file, unioned
 * across every entry in the lock. Two entries claiming one path is itself a broken lock; the first
 * wins rather than the check inventing a second failure mode for it.
 */
export function recordedPlatformHashes(lock: HarnesstLock): Map<string, string> {
  const recorded = new Map<string, string>();
  for (const entry of lock.installs) {
    for (const [path, hash] of Object.entries(entry.platformFiles ?? {})) {
      if (!recorded.has(path)) recorded.set(path, hash);
    }
  }
  return recorded;
}

export type PlatformFileProblemReason = "unknown" | "modified" | "unreadable";

export interface PlatformFileProblem {
  path: string;
  reason: PlatformFileProblemReason;
}

/**
 * Which of `paths` fail the gate. `contents` carries the bytes that will land at each path —
 * `null`/absent means the caller could not read it, which is reported rather than waved through:
 * a gate that passes what it could not verify is not a gate, and the operator's remedy (publish
 * again) is one click.
 */
export function platformFileProblems(
  paths: readonly string[],
  recorded: ReadonlyMap<string, string>,
  contents: ReadonlyMap<string, string | null>,
): PlatformFileProblem[] {
  const problems: PlatformFileProblem[] = [];
  for (const path of paths) {
    const expected = recorded.get(path);
    if (expected === undefined) {
      problems.push({ path, reason: "unknown" });
      continue;
    }
    const content = contents.get(path);
    if (content === undefined || content === null) {
      problems.push({ path, reason: "unreadable" });
      continue;
    }
    if (platformFileHash(content) !== expected) {
      problems.push({ path, reason: "modified" });
    }
  }
  return problems;
}

const REASON_TEXT: Record<PlatformFileProblemReason, string> = {
  unknown: "no installed template owns this file",
  modified: "the bytes changed after the marketplace wrote it",
  unreadable: "couldn't be read to verify it — publish again",
};

/**
 * The check-step failure. It names every offending file (the operator has to know WHICH install to
 * repair) and closes off the repair that looks obvious and is wrong: hand-editing the file back
 * gets overwritten by the next update, so the only fix that sticks is re-running the marketplace
 * update, which rewrites the platform files from the catalog and re-records their hashes.
 */
export function platformFilesMessage(problems: readonly PlatformFileProblem[]): string {
  return [
    `This publish was stopped: ${problems.length === 1 ? "a platform file" : "platform files"} under \`harnesst/\` no longer ${problems.length === 1 ? "matches" : "match"} what the marketplace installed.`,
    "",
    ...problems.map((p) => `  • ${p.path} — ${REASON_TEXT[p.reason]}`),
    "",
    "`harnesst/` is platform code the installer owns; your agent's own behaviour lives in `agent/`. " +
      "A mismatch here is a broken install, not a change worth keeping — repair it by re-running that " +
      "template's Update on the project's Settings tab, which rewrites the platform files from the " +
      "catalog. Editing them by hand cannot fix this: the next update overwrites the edit and this " +
      "publish fails the same way. If the platform files themselves are wrong, escalate to an " +
      "administrator.",
  ].join("\n");
}
