/**
 * Pure needs-you decision matrix (app/foh/needs-you.ts) — the logic behind the two FOH
 * drain chokepoints, tested with zero mocks: how a live-drained turn's end settles the park
 * state (D4/D13), and what a reconciled eve tail says about it (park / settle / leave alone).
 */
import { describe, expect, it } from "vitest";

import type { ChatInputRequest } from "~/chat/types";
import {
  composerAnswerFor,
  freeformAnswerable,
  newestPendingRequest,
  reconcileNeedsYouFromTail,
  repairFohSessionState,
  settleFohTurn,
  type TailEventLike,
} from "~/foh/needs-you";

function ask(requestId = "r1"): ChatInputRequest {
  return { requestId, prompt: "Which one?" };
}

describe("settleFohTurn (chokepoint #1, terminal half)", () => {
  it("parks when the turn ends with pending input requests", () => {
    expect(settleFohTurn({ ok: true, inputRequests: [ask()] })).toEqual({
      outcome: "parked",
      clearPending: false,
      resolveAsks: false,
      recordFinished: false,
    });
  });

  it("still parks when assistant text preceded the ask (reply + requests)", () => {
    // Eve commonly emits "One thing before I continue —" as a completed message before
    // the ask_question call; the reply must not negate the park.
    const decision = settleFohTurn({ ok: true, inputRequests: [ask()] });
    expect(decision.outcome).toBe("parked");
  });

  it("completes: clears the park, resolves asks, files the finished item", () => {
    expect(settleFohTurn({ ok: true, inputRequests: [] })).toEqual({
      outcome: "completed",
      clearPending: true,
      resolveAsks: true,
      recordFinished: true,
    });
  });

  it("fails: clears the park and resolves asks but files no finished item", () => {
    expect(settleFohTurn({ ok: false, inputRequests: [] })).toEqual({
      outcome: "failed",
      clearPending: true,
      resolveAsks: true,
      recordFinished: false,
    });
  });

  it("a failed turn wins over its own stale requests", () => {
    expect(settleFohTurn({ ok: false, inputRequests: [ask()] }).outcome).toBe(
      "failed",
    );
  });
});

function tail(
  ...events: Array<[type: string, data?: Record<string, unknown>]>
): TailEventLike[] {
  return events.map(([type, data]) => ({ type, data: data ?? {} }));
}

const askEvent = (turnId: string, requestId = "r1"): [string, Record<string, unknown>] => [
  "input.requested",
  { turnId, requests: [{ requestId, prompt: "Which one?" }] },
];

describe("reconcileNeedsYouFromTail (chokepoint #2)", () => {
  it("parks on an unanswered ask settling into session.waiting", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(askEvent("turn_1"), ["session.waiting"]),
    );
    expect(decision.action).toBe("park");
    expect(decision.action === "park" && decision.requestData).toHaveLength(1);
  });

  it("parks on text-then-ask (a completed message before the request)", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(
        ["message.completed", { turnId: "turn_1", message: "One thing —" }],
        askEvent("turn_1"),
        ["session.waiting"],
      ),
    );
    expect(decision.action).toBe("park");
  });

  it("keeps a park even when eve closes the turn after the ask", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(askEvent("turn_1"), ["turn.completed", { turnId: "turn_1" }], [
        "session.waiting",
      ]),
    );
    expect(decision.action).toBe("park");
  });

  it("collects every request of the newest turn", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(askEvent("turn_1", "r1"), askEvent("turn_1", "r2"), ["session.waiting"]),
    );
    expect(decision.action === "park" && decision.requestData).toHaveLength(2);
  });

  it("a newer turn's ask supersedes an older turn's", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(askEvent("turn_1", "r1"), askEvent("turn_2", "r2"), ["session.waiting"]),
    );
    expect(decision.action === "park" && decision.requestData).toEqual([
      { turnId: "turn_2", requests: [{ requestId: "r2", prompt: "Which one?" }] },
    ]);
  });

  it("settles a park answered by a later turn that completed", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(
        askEvent("turn_1"),
        ["session.waiting"],
        ["message.received", { turnId: "turn_2", message: "the blue one" }],
        ["message.completed", { turnId: "turn_2", message: "Done." }],
        ["turn.completed", { turnId: "turn_2" }],
        ["session.waiting"],
      ),
    );
    expect(decision.action).toBe("settle");
  });

  it("settles a plainly completed turn", () => {
    const decision = reconcileNeedsYouFromTail(
      tail(
        ["message.completed", { turnId: "turn_1", message: "Done." }],
        ["turn.completed", { turnId: "turn_1" }],
        ["session.waiting"],
      ),
    );
    expect(decision.action).toBe("settle");
  });

  it("settles on terminal failure, even after an ask", () => {
    expect(reconcileNeedsYouFromTail(tail(["turn.failed", { turnId: "turn_1" }])).action).toBe(
      "settle",
    );
    expect(
      reconcileNeedsYouFromTail(tail(askEvent("turn_1"), ["session.failed"])).action,
    ).toBe("settle");
  });

  it("does nothing for a bare session.waiting marker (drain-died-after-park case)", () => {
    // The drain recorded the park and persisted the cursor past input.requested, then died;
    // the recovered tail is just the waiting marker. Clearing here would erase a real park.
    expect(reconcileNeedsYouFromTail(tail(["session.waiting"])).action).toBe("none");
  });

  it("does nothing for mid-turn activity", () => {
    expect(
      reconcileNeedsYouFromTail(
        tail(
          ["message.received", { turnId: "turn_1", message: "go" }],
          ["step.started", { turnId: "turn_1", sequence: 1 }],
        ),
      ).action,
    ).toBe("none");
  });

  it("does nothing for an empty tail", () => {
    expect(reconcileNeedsYouFromTail([]).action).toBe("none");
  });
});

describe("repairFohSessionState (loader-side durable retry, issue #221 finding 4)", () => {
  const asked = (over: Partial<{ error: string | null }> = {}) => ({
    role: "assistant",
    inputRequests: [ask()],
    error: null,
    ...over,
  });
  const answered = { role: "assistant", inputRequests: undefined, error: null };
  const at = new Date("2026-07-01T10:00:00Z");

  it.each([
    // Park-repair: the drain's park write failed — the transcript proves the ask.
    ["waiting + pending ask + flag unset", "waiting", null, asked(), true, "park"],
    ["waiting + pending ask + flag unset (HTTP-homed)", "waiting", null, asked(), false, "park"],
    // Poisoned-row repair (issue #282): a refused send wrote `failed` and cleared the park,
    // but the transcript's newest entry is still the un-errored ask — eve is still parked.
    // Channel-homed rows ONLY: an HTTP-homed failed turn is retried by resending, and
    // rewriting it to `waiting` could reopen an already-consumed question.
    ["failed + pending ask + flag unset", "failed", null, asked(), true, "park"],
    ["failed + pending ask + flag unset (HTTP-homed)", "failed", null, asked(), false, "none"],
    // A REAL failed turn's newest entry carries the error — never re-parked.
    ["failed + errored ask + flag unset", "failed", null, asked({ error: "boom" }), true, "none"],
    ["failed + user last entry + flag unset", "failed", null, { role: "user" }, true, "none"],
    // Settle-repair: the drain's clear write failed — the badge lies.
    ["waiting + no ask + flag set", "waiting", at, answered, true, "settle"],
    ["failed + no ask + flag set", "failed", at, answered, true, "settle"],
    ["completed + no ask + flag set", "completed", at, answered, true, "settle"],
    // A failed last entry is not a live ask, so a set flag settles.
    ["failed + errored ask + flag set", "failed", at, asked({ error: "boom" }), true, "settle"],
    ["waiting + user last entry + flag set", "waiting", at, { role: "user" }, true, "settle"],
    ["waiting + empty transcript + flag set", "waiting", at, null, true, "settle"],
    // Consistent rows are untouched.
    ["consistent park (ask + flag)", "waiting", at, asked(), true, "none"],
    ["consistent done (no ask, no flag)", "waiting", null, answered, true, "none"],
    ["consistent empty (new)", "new", null, null, true, "none"],
    // Indeterminate states are never repaired.
    ["running with an ask", "running", null, asked(), true, "none"],
    ["running with a stale flag", "running", at, answered, true, "none"],
    ["stopped with a stale flag", "stopped", at, answered, true, "none"],
    ["stopped with an ask", "stopped", null, asked(), true, "none"],
  ] as const)(
    "%s",
    (_name, status, pendingInputAt, lastEntry, channelHomed, expected) => {
      expect(
        repairFohSessionState({
          status,
          pendingInputAt,
          channelHomed,
          lastEntry: lastEntry as Parameters<
            typeof repairFohSessionState
          >[0]["lastEntry"],
        }).action,
      ).toBe(expected);
    },
  );

  it("returns the transcript's pending requests for the park repair", () => {
    const requests = [ask("r1"), ask("r2")];
    const decision = repairFohSessionState({
      status: "waiting",
      pendingInputAt: null,
      channelHomed: false,
      lastEntry: { role: "assistant", inputRequests: requests, error: null },
    });
    expect(decision).toEqual({ action: "park", requests, restoreStatus: false });
  });

  it("asks the caller to restore a poisoned failed row to waiting (issue #282)", () => {
    const decision = repairFohSessionState({
      status: "failed",
      pendingInputAt: null,
      channelHomed: true,
      lastEntry: asked(),
    });
    expect(decision).toEqual({
      action: "park",
      requests: [ask()],
      restoreStatus: true,
    });
  });
});

describe("newestPendingRequest (composer answer target, issue #282)", () => {
  it("picks the newest request of an un-errored assistant ask", () => {
    expect(
      newestPendingRequest({
        role: "assistant",
        inputRequests: [ask("r1"), ask("r2")],
        error: null,
      }),
    ).toEqual(ask("r2"));
  });

  it.each([
    ["empty transcript", null],
    ["user entry", { role: "user" }],
    ["assistant reply without asks", { role: "assistant", inputRequests: [] }],
    ["assistant entry with no requests field", { role: "assistant" }],
    [
      "errored assistant entry (its asks are stale)",
      { role: "assistant", inputRequests: [ask()], error: "boom" },
    ],
  ] as const)("nothing pending for %s", (_name, lastEntry) => {
    expect(
      newestPendingRequest(
        lastEntry as Parameters<typeof newestPendingRequest>[0],
      ),
    ).toBeNull();
  });
});

describe("freeformAnswerable (issue #282 review finding 4)", () => {
  const option = { id: "yes", label: "Yes" };

  it.each([
    ["no options at all — typing is the only path", { options: [] }, true],
    ["options absent entirely", {}, true],
    ["options + allowFreeform true — both paths", { options: [option], allowFreeform: true }, true],
    ["options-only approval (allowFreeform unset)", { options: [option] }, false],
    ["options-only approval (allowFreeform false)", { options: [option], allowFreeform: false }, false],
    ["options-only approval (allowFreeform null)", { options: [option], allowFreeform: null }, false],
  ] as const)("%s", (_name, request, expected) => {
    expect(
      freeformAnswerable(request as Parameters<typeof freeformAnswerable>[0]),
    ).toBe(expected);
  });
});

describe("composerAnswerFor (issue #282)", () => {
  it("correlates channel-homed composer text to the pending request", () => {
    expect(
      composerAnswerFor({
        channelHomed: true,
        pendingRequest: ask("call_1"),
        text: "1. /pricing should show the new tiers",
      }),
    ).toEqual({
      requestId: "call_1",
      text: "1. /pricing should show the new tiers",
    });
  });

  it("attaches nothing on an HTTP-homed session, pending request or not", () => {
    expect(
      composerAnswerFor({
        channelHomed: false,
        pendingRequest: ask("call_1"),
        text: "hello",
      }),
    ).toBeNull();
    expect(
      composerAnswerFor({ channelHomed: false, pendingRequest: null, text: "hi" }),
    ).toBeNull();
  });

  it("attaches nothing when a channel-homed session has no pending request", () => {
    expect(
      composerAnswerFor({ channelHomed: true, pendingRequest: null, text: "hi" }),
    ).toBeNull();
  });
});
