import { describe, expect, it } from "vitest";

import {
  inboxItemsForOpenSession,
  needsYouCount,
  openSessionInboxKey,
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

  it("leaves the open conversation out of the sidebar needs-you count", () => {
    const ids = ["open", "other", "open", "third"];
    expect(needsYouCount(ids, "open")).toBe(2);
    expect(needsYouCount(ids, null)).toBe(4);
    expect(needsYouCount(["open"], "open")).toBe(0);
  });

  it("keys the open conversation's pending items so a new one calls for a read mark", () => {
    const items = [
      { id: "b", sessionId: "open", projectId: "proj_1" },
      { id: "x", sessionId: "other", projectId: "proj_1" },
      { id: "a", sessionId: "open", projectId: "proj_1" },
    ];

    expect(openSessionInboxKey(items, "open")).toEqual({
      key: "a,b",
      projectId: "proj_1",
      sessionId: "open",
    });
    // Order-independent, so a poll that returns the same items doesn't fire a second mark.
    expect(openSessionInboxKey([...items].reverse(), "open")?.key).toBe("a,b");
    expect(openSessionInboxKey(items, "none")).toBeNull();
    expect(openSessionInboxKey(items, null)).toBeNull();
  });
});
