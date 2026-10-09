/**
 * FOH read cursors (D3/D13). Marking a session read advances the viewer's cursor to the
 * session's `lastEventAt` (the unread signal) and acknowledges every inbox item visible to them —
 * opening the conversation IS the acknowledgement, including for a question/approval that stays
 * pending and answerable in the transcript. Idempotent: the cursor upsert is only-advance in the
 * repo, and repeated acknowledgement/resolution is a no-op.
 */
import type { DataStore } from "~/data/ports";
import { acknowledgeVisibleInboxOnRead } from "~/foh/inbox.server";
// Function-level circular import (sessions.server ↔ inbox.server ↔ here): safe — only
// referenced inside async function bodies, never during module evaluation.
import {
  listFohSessionsByIds,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

export async function markSessionRead(
  session: Pick<PlaygroundSession, "id" | "lastEventAt">,
  userId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  if (session.lastEventAt) {
    await store.conversationReads.upsert(session.id, userId, session.lastEventAt);
  }
  await acknowledgeVisibleInboxOnRead(session.id, userId, store);
}

/**
 * Mark read from the session row's CURRENT `lastEventAt`, for server paths that know the viewer
 * has seen everything up to now without a round trip through the loader: the drain whose stream
 * delivered `done` to its viewer, and the viewer's own Stop. Both write `lastEventAt` themselves
 * after the viewer saw the content, so a mark taken from earlier loader data would leave the
 * conversation unread once they leave. Archived or vanished rows are skipped — the read route
 * refuses them too.
 */
export async function markSessionReadLatest(
  sessionId: string,
  userId: string,
  deps: {
    store?: DataStore;
    sessionsByIds?: (ids: string[]) => Promise<
      Array<Pick<PlaygroundSession, "id" | "lastEventAt" | "archivedAt">>
    >;
  } = {},
): Promise<void> {
  const [session] = await (deps.sessionsByIds ?? listFohSessionsByIds)([
    sessionId,
  ]);
  if (!session || session.archivedAt) return;
  await markSessionRead(session, userId, deps.store);
}
