import { describe, expect, it } from "vitest";

import { codexSessionId } from "~/gateway/codex-session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("codexSessionId", () => {
  it("is stable across calls of one session", () => {
    const a = codexSessionId("org_1", "sess_abc");
    expect(a).toMatch(UUID);
    expect(codexSessionId("org_1", "sess_abc")).toBe(a);
  });

  it("differs between sessions and between orgs", () => {
    const a = codexSessionId("org_1", "sess_abc");
    expect(codexSessionId("org_1", "sess_def")).not.toBe(a);
    expect(codexSessionId("org_2", "sess_abc")).not.toBe(a);
  });

  it("does not pass the caller's session label through", () => {
    expect(codexSessionId("org_1", "agent é/session 1")).toMatch(UUID);
  });

  it("falls back to a fresh random id when the session header is absent", () => {
    let n = 0;
    const random = () => `random-${++n}`;
    expect(codexSessionId("org_1", null, random)).toBe("random-1");
    expect(codexSessionId("org_1", null, random)).toBe("random-2");
    expect(codexSessionId("org_1", null)).not.toBe(codexSessionId("org_1", null));
  });
});
