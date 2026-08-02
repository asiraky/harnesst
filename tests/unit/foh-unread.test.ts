import { describe, expect, it } from "vitest";

import {
  inboxItemsForOpenSession,
  suppressOpenSessionUnread,
  titleWithInboxCount,
} from "~/foh/unread";

describe("FOH visible unread state", () => {
  it("suppresses only the open session's unread state", () => {
    const sessions = [
      { id: "open", unread: true },
      { id: "other", unread: true },
    ];

    expect(suppressOpenSessionUnread(sessions, "open")).toEqual([
      { id: "open", unread: false },
      { id: "other", unread: true },
    ]);
    expect(suppressOpenSessionUnread(sessions, null)).toBe(sessions);
  });

  it("hides every acknowledged item for the open session", () => {
    const items = [
      { id: "finished", sessionId: "open", kind: "finished" },
      { id: "notice", sessionId: "open", kind: "notice" },
      { id: "question", sessionId: "open", kind: "question" },
      { id: "approval", sessionId: "open", kind: "approval" },
      { id: "other", sessionId: "other", kind: "finished" },
    ];

    expect(inboxItemsForOpenSession(items, "open").map((item) => item.id)).toEqual([
      "other",
    ]);
    expect(inboxItemsForOpenSession(items, null)).toBe(items);
  });

  it("keeps the browser title aligned with the displayed inbox count", () => {
    expect(titleWithInboxCount("Session · harnesst", 2)).toBe(
      "(2) Session · harnesst",
    );
    expect(titleWithInboxCount("(2) Session · harnesst", 1)).toBe(
      "(1) Session · harnesst",
    );
    expect(titleWithInboxCount("(1) Session · harnesst", 0)).toBe(
      "Session · harnesst",
    );
    expect(titleWithInboxCount("harnesst", 100)).toBe("(99+) harnesst");
  });
});
