/**
 * Pure logic for mirroring an assistant conversation's checkout to GitHub. The
 * instance-side sidecar reports the checkout's full tree state vs its
 * base branch (`TreeState`); this module turns that into a commit plan for the Git Data API,
 * applies the server-side path policy, and computes the skip-if-unchanged hash. No I/O — the
 * git/GitHub calls live in `checkout-sync.server.ts`, so the mapping is unit-tested in isolation.
 */
import { createHash } from "node:crypto";

/** One dirty path in a checkout, relative to the repo root (forward-slashed). */
export type DirtyStatus = "added" | "modified" | "deleted";

export interface DirtyFile {
  path: string;
  status: DirtyStatus;
  /** New UTF-8 content for added/modified text files; absent for deletions, binary, or oversize. */
  content?: string | null;
  /** True when the sidecar skipped the body because the file is binary. */
  binary?: boolean;
  /** True when the sidecar skipped the body because the file exceeds the size cap. */
  oversize?: boolean;
  /**
   * True when the path is not a regular file — a symlink, submodule, fifo… The sidecar NEVER
   * reads these (a model-authored symlink could point at instance files like /proc/1/environ),
   * so they carry no body and are excluded from the commit.
   */
  notFile?: boolean;
  /** True when git reports mode 100755 — carried through to the mirrored tree entry. */
  executable?: boolean;
}

/** The instance-reported state of a conversation checkout vs the merge-base with its base branch. */
export interface TreeState {
  branch: string;
  /** merge-base sha the diff is computed against (the base branch tip at checkout time). */
  baseSha: string;
  dirty: DirtyFile[];
}

/**
 * The assistant's OWN configuration — everything under `.harnesst/assistant/` — is never
 * committed from a conversation branch. The assistant edits repository files on behalf of a
 * human; it must not be able to author the instructions, skills, schedules, or model that
 * govern its next turn. Self-modification cannot be prevented by telling the model not to do
 * it: repo content and conversation input can both steer the model, and the human reviewing
 * the PR is a non-developer who cannot be expected to spot an instruction edit smuggled into a
 * legitimate diff. So the whole prefix is stripped pre-commit (and reported back to the model,
 * so it doesn't believe the edit stuck). Humans still edit this surface directly — the config
 * page and the MCP/UI authoring path go through `normalizeAgentPath`, which allows it.
 * Everything else in the repo is allowed; PR review is the backstop there.
 */
export function isBlockedPath(path: string): boolean {
  return (
    path === ".harnesst/assistant" || path.startsWith(".harnesst/assistant/")
  );
}

/** One planned tree entry: full new content (null = delete) + whether it's mode 100755. */
export interface PlanFile {
  path: string;
  content: string | null;
  executable?: boolean;
}

export interface CommitPlan {
  /** Files to commit (writes + deletions), already path-policy-filtered. */
  files: PlanFile[];
  /** Paths dropped by the path policy (surface to the model + PR body). */
  blocked: string[];
  /** Added/modified paths whose body the sidecar skipped (binary/oversize) — not committed. */
  skippedBodies: string[];
  /** Non-regular-file paths (symlinks, submodules) the sidecar refused to read — not committed. */
  notFiles: string[];
  /** Stable hash of the committed set — equal hash across syncs ⇒ nothing to do. */
  hash: string;
}

/**
 * Turn a reported tree state into a GitHub commit plan. Deletions always commit (`content: null`);
 * added/modified commit only when the sidecar sent a text body (binary/oversize/non-regular-file
 * paths are recorded and skipped). Blocked paths are removed regardless of status. The hash covers
 * exactly what will be committed — content AND mode — so a turn that changed nothing committable
 * is a no-op the engine can skip, while a bare `chmod +x` still syncs.
 */
export function planCommit(tree: TreeState): CommitPlan {
  const files: PlanFile[] = [];
  const blocked: string[] = [];
  const skippedBodies: string[] = [];
  const notFiles: string[] = [];

  for (const f of tree.dirty) {
    if (isBlockedPath(f.path)) {
      blocked.push(f.path);
      continue;
    }
    if (f.status === "deleted") {
      files.push({ path: f.path, content: null });
      continue;
    }
    if (f.notFile) {
      notFiles.push(f.path);
      continue;
    }
    if (f.binary || f.oversize || typeof f.content !== "string") {
      skippedBodies.push(f.path);
      continue;
    }
    files.push({
      path: f.path,
      content: f.content,
      ...(f.executable ? { executable: true } : {}),
    });
  }

  // Deterministic order so the hash is stable regardless of the sidecar's listing order.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hasher = createHash("sha256");
  hasher.update(tree.baseSha);
  hasher.update("\0");
  for (const f of files) {
    hasher.update(f.path);
    hasher.update("\0");
    hasher.update(f.content === null ? "\x00DELETE\x00" : f.content);
    hasher.update("\0");
    hasher.update(f.executable ? "x" : "-");
    hasher.update("\0");
  }
  blocked.sort();
  skippedBodies.sort();
  notFiles.sort();

  return {
    files,
    blocked,
    skippedBodies,
    notFiles,
    hash: hasher.digest("hex"),
  };
}

/** Human-readable warning block for the PR body / model note when paths were dropped. */
export function policyWarnings(plan: CommitPlan): string[] {
  const warnings: string[] = [];
  if (plan.blocked.length > 0) {
    warnings.push(
      `Excluded from this change (harnesst-owned, never committed from a conversation): ${plan.blocked.join(", ")}.`,
    );
  }
  if (plan.skippedBodies.length > 0) {
    warnings.push(
      `Skipped (binary or over the 1MB cap, not mirrored): ${plan.skippedBodies.join(", ")}.`,
    );
  }
  if (plan.notFiles.length > 0) {
    warnings.push(
      `Skipped (not a regular file — symlinks and submodules are never mirrored): ${plan.notFiles.join(", ")}.`,
    );
  }
  return warnings;
}

/** The working branch a conversation's checkout is mirrored onto. */
export function conversationBranch(conversationId: string): string {
  return `harnesst/conv-${conversationId}`;
}

/** Absolute path of a conversation's checkout inside the instance/sandbox (shared home volume). */
export function conversationCheckoutPath(conversationId: string): string {
  return `/workspace/home/checkouts/${conversationId}`;
}

/**
 * User-facing error when the pre-turn ensure could not prepare the conversation's checkout —
 * null when the turn may proceed. A target with no checkout sidecar at all (`unsupported`) is
 * not an error: those turns run without a checkout. But a sidecar that exists and fails means
 * the model would run against a workspace it was promised and doesn't have, so the turn must
 * not start.
 */
export function checkoutEnsureError(ensured: {
  ok: boolean;
  unsupported?: boolean;
  reason?: string;
}): string | null {
  if (ensured.ok || ensured.unsupported) return null;
  const reason = ensured.reason ?? "unknown error";
  return (
    `Couldn't prepare this conversation's repo checkout (${reason}). ` +
    "Try again in a moment. If this keeps happening, check that the assistant instance can " +
    "reach harnesst's callback API (HARNESST_API_URL) — for example, a host firewall blocking the " +
    "docker bridge."
  );
}
