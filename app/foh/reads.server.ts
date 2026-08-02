/**
 * FOH read cursors (D3/D13). Marking a session read advances the viewer's cursor to the
 * session's `lastEventAt` (the unread signal) and acknowledges every inbox item visible to them —
 * opening the conversation IS the acknowledgement, including for a question/approval that stays
 * pending and answerable in the transcript. Idempotent: the cursor upsert is only-advance in the
 * repo, and repeated acknowledgement/resolution is a no-op.
 */
import type { DataStore } from "~/data/ports";
import { acknowledgeVisibleInboxOnRead } from "~/foh/inbox.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
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
