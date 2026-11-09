/**
 * Which Front of House conversations the list folds away by default. A quiet row is one that
 * asks nothing of a human and that nobody needs to read again: agents briefing each other,
 * an empty draft, or an update the viewer already read a day ago. Folding them away keeps the
 * list down to what someone has to act on. Nothing is archived; the list can still show them.
 */
import { fohSessionStatus, type FohStatusInput } from "~/foh/status";

const EMPTY_DRAFT_MS = 60 * 60 * 1000;
const READ_UPDATE_MS = 24 * 60 * 60 * 1000;

export interface QuietInput extends FohStatusInput {
  delegationId: string | null;
  openingMessage: string | null;
  lastEventAt: Date | null;
  createdAt: Date;
  /** The viewer's read mark on this conversation, if any. */
  lastReadAt: Date | null;
  /** A question or approval was ever filed for a human on this conversation. */
  hadHumanAsk: boolean;
}

export function isQuietFohSession(session: QuietInput, now: Date): boolean {
  if (fohSessionStatus(session) === "needs_you") return false;

  // One agent handing work to another. It belongs on the list only once it asked a human.
  if (session.delegationId) return !session.hadHumanAsk;

  // A conversation someone opened and never wrote in.
  if (
    !session.openingMessage &&
    !session.lastEventAt &&
    session.status === "new"
  ) {
    return now.getTime() - session.createdAt.getTime() > EMPTY_DRAFT_MS;
  }

  // An agent's update nobody replied to, read by this viewer, and a day old.
  if (session.openingMessage && !session.externalSessionId) {
    const at = session.lastEventAt ?? session.createdAt;
    return (
      session.lastReadAt != null &&
      session.lastReadAt >= at &&
      now.getTime() - at.getTime() > READ_UPDATE_MS
    );
  }

  return false;
}
