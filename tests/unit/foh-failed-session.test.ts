/**
 * Issue #250: opening a FAILED conversation must always say so. The old gate rendered the
 * notice only when the cached transcript ended with a user message, so the two shapes a
 * died-early turn actually takes — no entries at all, or an unreadable history — rendered an
 * empty pane with no explanation. These tests pin every shape.
 */
import { describe, expect, it } from "vitest";

import { failedSessionNotice } from "~/foh/failed-session";

const user = (text: string) => ({ role: "user", text });
const assistant = (text: string, error?: string) => ({
  role: "assistant",
  text,
  error: error ?? null,
});
const artifact = () => ({ role: "artifact", text: "" });

const notice = (
  over: Partial<Parameters<typeof failedSessionNotice>[0]> = {},
) =>
  failedSessionNotice({
    sessionStatus: "failed",
    liveTurnVisible: false,
    historyUnavailable: false,
    transcriptIsPredecessorOnly: false,
    entries: [],
    ...over,
  });

describe("failedSessionNotice", () => {
  it("says nothing for a session that did not fail", () => {
    for (const status of [
      "new",
      "running",
      "waiting",
      "completed",
      "stopped",
    ]) {
      expect(
        notice({ sessionStatus: status, entries: [user("hi")] }),
      ).toBeNull();
    }
  });

  it("explains a failed session with NO entries at all", () => {
    // The regression: a turn that died before eve recorded anything used to render the
    // "say something" invitation, indistinguishable from a brand new conversation.
    const result = notice();
    expect(result?.kind).toBe("empty");
    expect(result?.message).toMatch(/ended in an error/i);
    expect(result?.retryText).toBeNull();
  });

  it("offers the trailing user message for a retry", () => {
    const result = notice({ entries: [user("book the flight")] });
    expect(result?.kind).toBe("interrupted");
    expect(result?.retryText).toBe("book the flight");
  });

  it("still explains a failure whose last entry is a plain assistant reply", () => {
    const result = notice({
      entries: [user("hi"), assistant("here you go")],
    });
    expect(result?.kind).toBe("unknown");
    // Resending would repeat work the agent already did — the composer is the next step.
    expect(result?.retryText).toBeNull();
  });

  it("defers to the errored entry's own TurnError, which is more specific", () => {
    expect(
      notice({ entries: [user("hi"), assistant("", "Model overloaded.")] }),
    ).toBeNull();
  });

  it("looks past a trailing artifact card to the turn that failed", () => {
    // An artifact card (#290) trails its turn and says nothing about how the turn ended.
    expect(
      notice({ entries: [user("hi"), assistant("", "boom"), artifact()] }),
    ).toBeNull();
    expect(notice({ entries: [user("draw a cat"), artifact()] })?.kind).toBe(
      "interrupted",
    );
  });

  it("defers to the live turn's own error bubble while one is on screen", () => {
    expect(notice({ liveTurnVisible: true, entries: [user("hi")] })).toBeNull();
  });

  it("does not read the transcript when the history could not be loaded", () => {
    // `entries` is empty because the read failed, not because nothing happened — claiming
    // "nothing was recorded" there would be a guess.
    const result = notice({ historyUnavailable: true });
    expect(result?.kind).toBe("unknown");
    expect(result?.message).toMatch(/could not be loaded/i);
    expect(result?.retryText).toBeNull();
  });

  describe("a successor whose own stream is still empty (#288 3b)", () => {
    // The literal symptom in issue #250: the stitched predecessor transcript is ALL that
    // renders, so reading its tail would describe the previous conversation's outcome.
    it("never reads the predecessor's errored tail as this session's outcome", () => {
      const result = notice({
        transcriptIsPredecessorOnly: true,
        entries: [user("hi"), assistant("", "the OLD turn's error")],
      });
      expect(result).not.toBeNull();
      expect(result?.message).toMatch(/from the conversation it continues/i);
    });

    it("never offers to resend the predecessor's last message", () => {
      const result = notice({
        transcriptIsPredecessorOnly: true,
        entries: [user("book the OLD flight")],
      });
      expect(result?.retryText).toBeNull();
    });
  });

  it("offers no retry for a whitespace-only user message", () => {
    expect(notice({ entries: [user("   ")] })?.retryText).toBeNull();
  });
});
