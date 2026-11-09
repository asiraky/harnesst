import { describe, expect, it } from "vitest";

import { isQuietFohSession, type QuietInput } from "~/foh/quiet";

const NOW = new Date("2026-11-09T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function row(over: Partial<QuietInput> = {}): QuietInput {
  return {
    status: "waiting",
    pendingInputAt: null,
    awaitingReplyAt: null,
    externalSessionId: null,
    delegationId: null,
    openingMessage: null,
    lastEventAt: hoursAgo(1),
    createdAt: hoursAgo(2),
    lastReadAt: null,
    hadHumanAsk: false,
    ...over,
  };
}

describe("isQuietFohSession", () => {
  it("keeps an ordinary human conversation", () => {
    expect(isQuietFohSession(row({ lastReadAt: hoursAgo(0), lastEventAt: hoursAgo(100) }), NOW)).toBe(false);
  });

  it("folds away agent-to-agent delegations, working or done", () => {
    expect(isQuietFohSession(row({ delegationId: "dg_1" }), NOW)).toBe(true);
    expect(isQuietFohSession(row({ delegationId: "dg_1", status: "running" }), NOW)).toBe(true);
  });

  it("keeps a delegation that asked a human, now or before", () => {
    expect(
      isQuietFohSession(row({ delegationId: "dg_1", pendingInputAt: hoursAgo(1) }), NOW),
    ).toBe(false);
    expect(isQuietFohSession(row({ delegationId: "dg_1", hadHumanAsk: true }), NOW)).toBe(false);
  });

  it("folds away an empty draft only after an hour", () => {
    const draft = { status: "new", lastEventAt: null };
    expect(isQuietFohSession(row({ ...draft, createdAt: hoursAgo(0.5) }), NOW)).toBe(false);
    expect(isQuietFohSession(row({ ...draft, createdAt: hoursAgo(2) }), NOW)).toBe(true);
  });

  it("folds away an agent update once this viewer read it and a day passed", () => {
    const update = { openingMessage: "Deployed.", lastEventAt: hoursAgo(30) };
    expect(isQuietFohSession(row(update), NOW)).toBe(false);
    expect(isQuietFohSession(row({ ...update, lastReadAt: hoursAgo(29) }), NOW)).toBe(true);
    // Read, but fresh.
    expect(
      isQuietFohSession(
        row({ ...update, lastEventAt: hoursAgo(2), lastReadAt: hoursAgo(1) }),
        NOW,
      ),
    ).toBe(false);
    // Read before its latest event.
    expect(isQuietFohSession(row({ ...update, lastReadAt: hoursAgo(31) }), NOW)).toBe(false);
  });

  it("never folds away an update awaiting a reply, or one a human replied in", () => {
    const read = { openingMessage: "Reply here.", lastEventAt: hoursAgo(30), lastReadAt: hoursAgo(29) };
    expect(isQuietFohSession(row({ ...read, awaitingReplyAt: hoursAgo(30) }), NOW)).toBe(false);
    expect(isQuietFohSession(row({ ...read, externalSessionId: "wrun_1" }), NOW)).toBe(false);
  });
});
