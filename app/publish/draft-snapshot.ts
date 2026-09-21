import { createHash } from "node:crypto";

/** Bind an automatic publish to the exact file content the user authorized. */
export function draftSnapshotFingerprint(
  drafts: readonly { path: string; content: string | null }[],
): string {
  const entries = drafts
    .map(({ path, content }) => [path, content] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
