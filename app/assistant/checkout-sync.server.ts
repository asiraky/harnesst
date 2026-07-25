/**
 * Assistant coding-agent sync engine. The control-plane
 * half of the checkout↔GitHub mirror:
 *
 *   ensureConversationCheckout  — before a turn: tell the instance sidecar to clone/fetch the
 *                                 conversation's checkout and report whether the base branch moved.
 *   syncConversationCheckout    — after a turn: pull the checkout's full tree state from the
 *                                 sidecar, apply the path policy, stage every change as a draft
 *                                 in the shared staging area (what the Publish button ships), and
 *                                 mirror the tree onto `eden/conv-<id>` as one snapshot commit
 *                                 (force-updated ref) — an internal durability branch only.
 *                                 Skips when the tree is unchanged.
 *
 * The pure diff→commit mapping + policy live in `checkout-sync.ts` (unit-tested); this module owns
 * the I/O (sidecar HTTP via the DeployTarget seam, GitHub Git Data API, the `assistant_checkouts`
 * link row). No GitHub WRITE credential and no `edna_` token ever leaves the control plane here.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { assistantCheckouts } from "~/db/schema";
import { stageDraft } from "~/drafts/drafts.server";
import { getInstallationOctokit } from "~/github/client.server";
import { getRuntime } from "~/seams/index.server";
import type { DataStore } from "~/data/ports";
import {
  conversationBranch,
  planCommit,
  policyWarnings,
  type CommitPlan,
  type PlanFile,
  type TreeState,
} from "./checkout-sync";

export type AssistantCheckout = typeof assistantCheckouts.$inferSelect;

interface RepoCtx {
  installationId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
}

async function repoCtx(
  projectId: string,
  store: DataStore,
): Promise<RepoCtx | null> {
  const project = await store.projects.findById(projectId);
  if (!project?.repoInstallationId || !project.repoOwner || !project.repoName)
    return null;
  return {
    installationId: project.repoInstallationId,
    owner: project.repoOwner,
    repo: project.repoName,
    defaultBranch: project.defaultBranch,
  };
}

interface AuxBase {
  /** False when the deploy target has no checkout sidecar at all (no `auxEndpoint`). */
  supported: boolean;
  /** The sidecar base URL — null when unsupported OR when a supporting target failed to resolve it. */
  base: string | null;
}

async function auxBase(deploymentId: string): Promise<AuxBase> {
  const target = getRuntime().deployTarget;
  if (!target.auxEndpoint) return { supported: false, base: null };
  const base = await target.auxEndpoint(deploymentId).catch(() => null);
  return { supported: true, base };
}

// ── Checkout link row ──────────────────────────────────────────────────────────

export async function getCheckoutRow(
  conversationId: string,
): Promise<AssistantCheckout | null> {
  const [row] = await db
    .select()
    .from(assistantCheckouts)
    .where(eq(assistantCheckouts.conversationId, conversationId))
    .limit(1);
  return row ?? null;
}

async function upsertCheckoutRow(input: {
  conversationId: string;
  projectId: string;
  branch: string;
  baseBranch: string;
  lastSyncedHash: string;
  warnings: string[];
}): Promise<void> {
  const warnings = input.warnings.length > 0 ? input.warnings : null;
  await db
    .insert(assistantCheckouts)
    .values({
      conversationId: input.conversationId,
      projectId: input.projectId,
      branch: input.branch,
      baseBranch: input.baseBranch,
      lastSyncedHash: input.lastSyncedHash,
      warnings,
    })
    .onConflictDoUpdate({
      target: assistantCheckouts.conversationId,
      set: {
        branch: input.branch,
        baseBranch: input.baseBranch,
        lastSyncedHash: input.lastSyncedHash,
        warnings,
        updatedAt: new Date(),
      },
    });
}

// ── Ensure (before a turn) ───────────────────────────────────────────────────────

export interface EnsureResult {
  ok: boolean;
  /** True when the deploy target has no checkout sidecar at all — checkouts unsupported, not failed. */
  unsupported?: boolean;
  /** A one-line note to inject for the model (e.g. base advanced) — null when nothing to say. */
  note: string | null;
  reason?: string;
}

/**
 * Ask the instance sidecar to ensure the conversation's checkout exists (clone/fetch + checkout
 * `eden/conv-<id>`, recovering it from the remote branch after volume/instance loss). If the base
 * branch advanced since the checkout was cut, returns a note for the model so it can rebase.
 */
export async function ensureConversationCheckout(input: {
  conversationId: string;
  deploymentId: string;
}): Promise<EnsureResult> {
  const aux = await auxBase(input.deploymentId);
  if (!aux.supported)
    return {
      ok: false,
      unsupported: true,
      note: null,
      reason: "no sidecar endpoint",
    };
  const base = aux.base;
  if (!base)
    return {
      ok: false,
      note: null,
      reason: "couldn't resolve the sidecar endpoint",
    };
  try {
    const res = await fetch(`${base}/ensure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: input.conversationId }),
      signal: AbortSignal.timeout(300_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      advanced?: number;
      baseBranch?: string;
      checkoutPath?: string;
    } | null;
    if (!res.ok || !body?.ok) {
      return {
        ok: false,
        note: null,
        reason: body?.error ?? `ensure ${res.status}`,
      };
    }
    const advanced = body.advanced ?? 0;
    const note =
      advanced > 0
        ? `Note: the base branch (${body.baseBranch}) advanced ${advanced} commit${advanced === 1 ? "" : "s"} since this conversation's checkout was cut. Rebase your branch onto origin/${body.baseBranch} if those changes are relevant before you continue.`
        : null;
    return { ok: true, note };
  } catch (error) {
    return {
      ok: false,
      note: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Sync (after a turn) ────────────────────────────────────────────────────────

export interface SyncResult {
  synced: boolean;
  /**
   * "synced" — the checkout's changes were staged as drafts and mirrored to its branch. "noop" —
   * legitimately nothing to do (no edits, unchanged tree, checkouts unsupported). "failed" — the
   * checkout could not be read, mirrored, or staged: the model's edits (if any) did NOT land
   * anywhere, which callers must surface — a swallowed failure here is exactly how "the assistant
   * said it made changes but nothing shows up" happens.
   */
  kind: "synced" | "noop" | "failed";
  reason?: string;
  /** Files staged as drafts by this sync — 0 unless `kind` is "synced". */
  stagedCount: number;
  warnings?: string[];
}

/**
 * Persist a sync failure onto the checkout link row as a warning. Two consumers: the next turn's
 * messagePrefix reads it (so the model knows its last edits never landed and can say so), and the
 * turn stream's `sync` event surfaces it to the user immediately. Preserves the row's hash
 * state; the next successful sync clears it. Best-effort — never throws.
 */
export async function recordSyncFailure(input: {
  conversationId: string;
  projectId: string;
  baseBranch?: string | null;
  reason: string;
}): Promise<void> {
  try {
    const row = await getCheckoutRow(input.conversationId);
    await upsertCheckoutRow({
      conversationId: input.conversationId,
      projectId: input.projectId,
      branch: conversationBranch(input.conversationId),
      baseBranch: input.baseBranch ?? row?.baseBranch ?? "main",
      lastSyncedHash: row?.lastSyncedHash ?? "",
      warnings: [
        `The previous turn's auto-sync failed (${input.reason}). Edits in this conversation's checkout are safe on disk but have NOT landed yet — they'll be picked up after your next turn completes.`,
      ],
    });
  } catch (e) {
    console.error("[assistant-sync] couldn't record sync failure", e);
  }
}

/** Injected I/O seams for the sync engine (production defaults below) — keeps unit tests off
 * the sidecar, GitHub, and the checkout-row table entirely. */
export interface SyncEngineDeps {
  auxBase: (deploymentId: string) => Promise<AuxBase>;
  /** Read the checkout's full tree state from the instance sidecar. Throws on any failure. */
  readTree: (
    base: string,
    conversationId: string,
  ) => Promise<TreeState & { missing?: boolean }>;
  getRow: typeof getCheckoutRow;
  upsertRow: typeof upsertCheckoutRow;
  mirror: typeof mirrorSnapshot;
  stage: typeof stageDraft;
  recordFailure: typeof recordSyncFailure;
}

function defaultSyncDeps(): SyncEngineDeps {
  return {
    auxBase,
    readTree: async (base, conversationId) => {
      const res = await fetch(
        `${base}/tree?conversationId=${encodeURIComponent(conversationId)}`,
        { signal: AbortSignal.timeout(120_000) },
      );
      const body = (await res.json().catch(() => null)) as
        (TreeState & { ok?: boolean; missing?: boolean }) | null;
      if (!res.ok || !body?.ok)
        throw new Error(`sidecar tree read returned ${res.status}`);
      return body;
    },
    getRow: getCheckoutRow,
    upsertRow: upsertCheckoutRow,
    mirror: mirrorSnapshot,
    stage: stageDraft,
    recordFailure: recordSyncFailure,
  };
}

/**
 * Pull the conversation checkout's tree state from the instance sidecar, stage every planned
 * change as a draft (§2.7 — the assistant feeds the same staging area the editors do; the user's
 * Publish button ships them), and mirror the tree onto its working branch (the durability
 * mechanism `ensureConversationCheckout` recovers from). A no-op (tree unchanged since the last
 * sync, or nothing committable) returns `{ synced: false }` without touching GitHub.
 */
export async function syncConversationCheckout(
  input: {
    projectId: string;
    conversationId: string;
    deploymentId: string;
    store?: DataStore;
  },
  deps: SyncEngineDeps = defaultSyncDeps(),
): Promise<SyncResult> {
  const store = input.store ?? getRuntime().data;
  const ctx = await repoCtx(input.projectId, store);
  if (!ctx)
    return {
      synced: false,
      kind: "noop",
      reason: "project has no connected repo",
      stagedCount: 0,
    };

  const failed = async (reason: string): Promise<SyncResult> => {
    await deps.recordFailure({
      conversationId: input.conversationId,
      projectId: input.projectId,
      baseBranch: ctx.defaultBranch,
      reason,
    });
    return { synced: false, kind: "failed", reason, stagedCount: 0 };
  };

  const aux = await deps.auxBase(input.deploymentId);
  if (!aux.supported)
    return {
      synced: false,
      kind: "noop",
      reason: "checkouts unsupported on this deploy target",
      stagedCount: 0,
    };
  if (!aux.base)
    return failed("couldn't resolve the checkout sidecar endpoint");

  let tree: TreeState & { missing?: boolean };
  try {
    tree = await deps.readTree(aux.base, input.conversationId);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  if (tree.missing || !tree.baseSha)
    return failed("checkout missing on the instance");

  const plan = planCommit(tree);
  const row = await deps.getRow(input.conversationId);
  const branch = conversationBranch(input.conversationId);
  const warnings = policyWarnings(plan);

  // Nothing committable → nothing to stage or mirror. But the warnings must still land on the
  // row: a turn whose ONLY edits were stripped (e.g. the model touched assistant.json) would
  // otherwise be totally silent, and the model/user would believe the change stuck. The next turn's
  // messagePrefix reads them from the row.
  if (plan.files.length === 0) {
    if (warnings.length > 0) {
      await deps.upsertRow({
        conversationId: input.conversationId,
        projectId: input.projectId,
        branch,
        baseBranch: ctx.defaultBranch,
        lastSyncedHash: plan.hash,
        warnings,
      });
    }
    return {
      synced: false,
      kind: "noop",
      reason: "no committable changes",
      stagedCount: 0,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
  // Unchanged since the last sync → skip (the drafts were already staged then).
  if (row?.lastSyncedHash === plan.hash) {
    return { synced: false, kind: "noop", reason: "unchanged", stagedCount: 0 };
  }

  try {
    await deps.mirror(ctx, branch, tree.baseSha, plan, input.conversationId);
  } catch (error) {
    return failed(
      `mirroring to GitHub failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Stage the plan as drafts (§2.7): every write and deletion (a content:null draft) lands in
  // the same staging area the editors feed, and the same Publish button ships them. `createdBy`
  // is deliberately absent — human saves always carry a user id, so a null author is what marks
  // a draft assistant-staged in the publish panel. A failure here is a sync failure: the hash is
  // NOT advanced, so the next turn retries both the mirror (an idempotent force-update) and the
  // staging.
  try {
    for (const file of plan.files) {
      await deps.stage(
        { projectId: input.projectId, path: file.path, content: file.content },
        store,
      );
    }
  } catch (error) {
    return failed(
      `staging the changes failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await deps.upsertRow({
    conversationId: input.conversationId,
    projectId: input.projectId,
    branch,
    baseBranch: ctx.defaultBranch,
    lastSyncedHash: plan.hash,
    warnings,
  });

  return {
    synced: true,
    kind: "synced",
    stagedCount: plan.files.length,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** HTTP status of an Octokit request error, if present. */
function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/**
 * Write ONE snapshot commit that makes `branch` exactly `baseSha` + the checkout's full diff, then
 * force-update the ref (creating it if absent). Parenting on `baseSha` (the merge-base the diff was
 * computed against) keeps the branch a single commit ahead of base regardless of how many turns
 * synced, and avoids stacked-delta drift (a file added then reverted never lingers).
 */
async function mirrorSnapshot(
  ctx: RepoCtx,
  branch: string,
  baseSha: string,
  plan: CommitPlan,
  conversationId: string,
): Promise<string> {
  const octokit = await getInstallationOctokit(ctx.installationId);
  const { owner, repo } = ctx;
  const writes = plan.files.filter(
    (f): f is PlanFile & { content: string } => f.content !== null,
  );
  const deletes = plan.files.filter((f) => f.content === null);
  const [blobs, baseCommit] = await Promise.all([
    Promise.all(
      writes.map((f) =>
        octokit.rest.git.createBlob({
          owner,
          repo,
          content: Buffer.from(f.content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      ),
    ),
    octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha }),
  ]);
  const tree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.data.tree.sha,
    tree: [
      ...writes.map((f, i) => ({
        path: f.path,
        // Mode fidelity: a script the model chmod +x'd keeps its exec bit on the branch.
        mode: f.executable ? ("100755" as const) : ("100644" as const),
        type: "blob" as const,
        sha: blobs[i].data.sha,
      })),
      ...deletes.map((f) => ({
        path: f.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      })),
    ],
  });
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `eden: sync conversation ${conversationId}`,
    tree: tree.data.sha,
    parents: [baseSha],
  });
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.data.sha,
      force: true,
    });
  } catch (error) {
    if (statusOf(error) === 422) {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commit.data.sha,
      });
    } else {
      throw error;
    }
  }
  return commit.data.sha;
}

/** Drop the checkout link row for a branch (called when its work lands or is discarded). */
export async function discardConversationCheckoutByBranch(
  branch: string,
): Promise<void> {
  await db
    .delete(assistantCheckouts)
    .where(eq(assistantCheckouts.branch, branch));
}

/**
 * Drop every checkout link row for a project — called by the publish pipeline after a successful
 * commit. Publish always lands EVERY staged draft, so any conversation whose synced work was
 * staged has just been published; its next turn re-ensures a fresh checkout against the new head.
 */
export async function discardConversationCheckoutsForProject(
  projectId: string,
): Promise<void> {
  await db
    .delete(assistantCheckouts)
    .where(eq(assistantCheckouts.projectId, projectId));
}

/** Whether a branch is an assistant conversation branch (so callers can gate conv-only behaviour). */
export function isConversationBranch(
  branch: string | undefined | null,
): boolean {
  return !!branch && branch.startsWith("eden/conv-");
}
