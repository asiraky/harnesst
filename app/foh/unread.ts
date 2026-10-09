/**
 * An open conversation is being read even while its acknowledgement request is still in flight.
 * Mask its unread row immediately so loader polling cannot flash a badge for visible activity.
 */
export function suppressOpenSessionUnread<
  T extends { id: string; unread?: boolean },
>(sessions: T[], openSessionId: string | null): T[] {
  let changed = false;
  const visible = sessions.map((session) => {
    if (session.id !== openSessionId || !session.unread) return session;
    changed = true;
    return { ...session, unread: false };
  });
  return changed ? visible : sessions;
}

/**
 * Once a conversation is on screen every notification for it is acknowledged from the viewer's
 * perspective, even before the read POST reaches the DB. A question/approval can remain parked
 * and answerable in the transcript without retaining its bell/sidebar notification.
 */
export function inboxItemsForOpenSession<
  T extends { sessionId: string },
>(items: T[], openSessionId: string | null): T[] {
  if (!openSessionId) return items;
  const visible = items.filter((item) => item.sessionId !== openSessionId);
  return visible.length === items.length ? items : visible;
}

/** Sidebar needs-you count, leaving out the open conversation like the bell and session list. */
export function needsYouCount(
  sessionIds: readonly string[],
  openSessionId: string | null,
): number {
  if (!openSessionId) return sessionIds.length;
  return sessionIds.filter((id) => id !== openSessionId).length;
}

/**
 * The open conversation's pending inbox items, as a stable key — null when there are none.
 * The bell polls on its own clock, so it can see an item filed after the session page's read
 * mark (a `finished` item written just after the cursor save it acknowledged). Nothing on the
 * page would acknowledge that one, so the bell does: a new key means a read mark is due.
 */
export function openSessionInboxKey(
  items: ReadonlyArray<{ id: string; sessionId: string; projectId: string }>,
  openSessionId: string | null,
): { key: string; projectId: string; sessionId: string } | null {
  if (!openSessionId) return null;
  const open = items.filter((item) => item.sessionId === openSessionId);
  if (open.length === 0) return null;
  return {
    key: open
      .map((item) => item.id)
      .sort()
      .join(","),
    projectId: open[0].projectId,
    sessionId: openSessionId,
  };
}

const TITLE_COUNT_PREFIX = /^\((?:\d+|99\+)\)\s+/;

/** Keep the browser tab on the same count shown by the inbox bell. */
export function titleWithInboxCount(title: string, count: number): string {
  const base = title.replace(TITLE_COUNT_PREFIX, "");
  if (count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}
