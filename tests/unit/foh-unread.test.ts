import { describe, expect, it } from "vitest";

import {
  inboxItemsForOpenSession,
  suppressOpenSessionUnread,
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

  it("hides acknowledged item kinds for the open session but keeps blocking asks", () => {
    const items = [
      { id: "finished", sessionId: "open", kind: "finished" },
      { id: "notice", sessionId: "open", kind: "notice" },
      { id: "question", sessionId: "open", kind: "question" },
      { id: "approval", sessionId: "open", kind: "approval" },
      { id: "other", sessionId: "other", kind: "finished" },
    ];

    expect(inboxItemsForOpenSession(items, "open").map((item) => item.id)).toEqual([
      "question",
      "approval",
      "other",
    ]);
    expect(inboxItemsForOpenSession(items, null)).toBe(items);
  });
});
