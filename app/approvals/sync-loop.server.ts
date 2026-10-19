/**
 * Keeps harnesst's approvals in step with each team's ledger. In-process like the reconciler:
 * one interval per process, never stacking ticks. The sync module is imported per tick, so a
 * dev server picks up edits to it without a restart.
 */
const APPROVAL_SYNC_MS = 10_000;

const globalForSync = globalThis as unknown as {
  __harnesstApprovalSync?: { stop: () => void };
};

function startApprovalSync() {
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const { syncAllApprovals } = await import("./approvals.server");
      await syncAllApprovals();
    } catch (error) {
      console.error("[approvals] sync tick threw:", error);
    }
    // After the sync, so merge gates it just saw approved are merged in the same tick.
    try {
      const { syncApprovedMerges } = await import("./merge.server");
      await syncApprovedMerges();
    } catch (error) {
      console.error("[approvals] merge tick threw:", error);
    } finally {
      running = false;
    }
  }, APPROVAL_SYNC_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

export function ensureApprovalSyncStarted(): void {
  if (process.env.HARNESST_DISABLE_APPROVAL_SYNC === "1") return;
  globalForSync.__harnesstApprovalSync ??= startApprovalSync();
}
