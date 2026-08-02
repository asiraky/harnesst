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

const TITLE_COUNT_PREFIX = /^\((?:\d+|99\+)\)\s+/;

/** Keep the browser tab on the same count shown by the inbox bell. */
export function titleWithInboxCount(title: string, count: number): string {
  const base = title.replace(TITLE_COUNT_PREFIX, "");
  if (count <= 0) return base;
  return `(${count > 99 ? "99+" : count}) ${base}`;
}
