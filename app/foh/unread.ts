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
 * Finished/notice items only mean "look at this". Once that conversation is on screen they are
 * already acknowledged from the viewer's perspective, even before the read POST reaches the DB.
 * Blocking questions and approvals stay visible until the viewer actually answers them.
 */
export function inboxItemsForOpenSession<
  T extends { sessionId: string; kind: string },
>(items: T[], openSessionId: string | null): T[] {
  if (!openSessionId) return items;
  const visible = items.filter(
    (item) =>
      item.sessionId !== openSessionId ||
      (item.kind !== "finished" && item.kind !== "notice"),
  );
  return visible.length === items.length ? items : visible;
}
