/**
 * FOH session status mapping (D4) — pins app/foh/status.ts, the pure translation from stored
 * session fields to the presentation status FOH lists render. The critical property: the parked
 * ("needs you") state is derived from `pendingInputAt`, never from `status = 'waiting'` (the
 * drain writes `waiting` for EVERY successful turn end), and the mapping is total over all six
 * stored statuses — including `stopped`, which is missing from some status unions.
 */
import { describe, expect, it } from "vitest";

import {
  fohSessionStatus,
  sortSessionsForList,
  type FohStatusInput,
} from "~/foh/status";

const at = (ms: number) => new Date(ms);

function session(status: string, pendingInputAt: Date | null): FohStatusInput {
  return { status, pendingInputAt };
}

describe("fohSessionStatus", () => {
  it("maps every stored status without a pending park", () => {
    expect(fohSessionStatus(session("new", null))).toBe("done");
    expect(fohSessionStatus(session("running", null))).toBe("working");
    expect(fohSessionStatus(session("waiting", null))).toBe("done");
    expect(fohSessionStatus(session("completed", null))).toBe("done");
    expect(fohSessionStatus(session("failed", null))).toBe("error");
    expect(fohSessionStatus(session("stopped", null))).toBe("done");
  });

  it("maps a pending park to needs_you for every settled status", () => {
    const parked = at(1_000);
    expect(fohSessionStatus(session("new", parked))).toBe("needs_you");
    expect(fohSessionStatus(session("waiting", parked))).toBe("needs_you");
    expect(fohSessionStatus(session("completed", parked))).toBe("needs_you");
    // A stale flag on a failed/stopped row still surfaces as needs_you rather than hiding
    // the question; chokepoints clear the flag on terminal failure.
    expect(fohSessionStatus(session("failed", parked))).toBe("needs_you");
    expect(fohSessionStatus(session("stopped", parked))).toBe("needs_you");
  });

  it("running wins over a stale pending flag (a new turn is already answering)", () => {
    expect(fohSessionStatus(session("running", at(1_000)))).toBe("working");
  });

  it("waiting alone is NOT needs_you — parked is its own stored signal", () => {
    expect(fohSessionStatus(session("waiting", null))).not.toBe("needs_you");
  });
});

describe("fohSessionStatus for a notification awaiting a reply", () => {
  const notice = (
    status: string,
    externalSessionId: string | null,
  ): FohStatusInput => ({
    status,
    pendingInputAt: null,
    awaitingReplyAt: at(1_000),
    externalSessionId,
  });

  it("needs you until a human replies", () => {
    expect(fohSessionStatus(notice("new", null))).toBe("needs_you");
  });

  it("is working while the first reply runs, then done once the reply opened a session", () => {
    expect(fohSessionStatus(notice("running", null))).toBe("working");
    expect(fohSessionStatus(notice("waiting", "eve_1"))).toBe("done");
  });

  it("shows a failed first reply as an error, not as still waiting", () => {
    expect(fohSessionStatus(notice("failed", null))).toBe("error");
  });
});

describe("sortSessionsForList", () => {
  const row = (
    id: string,
    status: string,
    pendingInputAt: Date | null,
    updatedAt: Date,
  ) => ({ id, status, pendingInputAt, updatedAt });

  it("puts needs-you sessions first (longest-waiting question on top), then recency", () => {
    const recentDone = row("done-recent", "waiting", null, at(9_000));
    const oldDone = row("done-old", "completed", null, at(2_000));
    const newerAsk = row("ask-newer", "waiting", at(5_000), at(5_000));
    const olderAsk = row("ask-older", "waiting", at(3_000), at(8_000));
    const working = row("working", "running", null, at(7_000));

    const sorted = sortSessionsForList([
      recentDone,
      oldDone,
      newerAsk,
      olderAsk,
      working,
    ]);
    expect(sorted.map((s) => s.id)).toEqual([
      "ask-older",
      "ask-newer",
      "done-recent",
      "working",
      "done-old",
    ]);
  });

  it("orders an unanswered notification among the asks by when it started waiting", () => {
    const ask = row("ask", "waiting", at(5_000), at(5_000));
    const notice = {
      ...row("notice", "new", null, at(9_000)),
      awaitingReplyAt: at(2_000),
      externalSessionId: null,
    };
    const done = row("done", "waiting", null, at(10_000));

    expect(sortSessionsForList([done, ask, notice]).map((s) => s.id)).toEqual([
      "notice",
      "ask",
      "done",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [
      row("a", "waiting", null, at(1_000)),
      row("b", "waiting", at(1), at(2_000)),
    ];
    const before = [...rows];
    sortSessionsForList(rows);
    expect(rows).toEqual(before);
  });
});
