/**
 * isLocalOrigin gates Discord's interactions-endpoint self-registration: a local origin that
 * slips through overwrites the real endpoint in the Developer Portal with one Discord can't reach.
 */
import { describe, expect, it } from "vitest";

import { isLocalOrigin } from "~/lib/ingress";

describe("isLocalOrigin", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:5280",
    "http://app.harnesst.test:5173",
    "http://app--feature-x.harnesst.test:5280",
  ])("treats %s as unreachable from the internet", (origin) => {
    expect(isLocalOrigin(origin)).toBe(true);
  });

  it.each(["https://harnesst.example.com", "https://test.example.com"])(
    "treats %s as public",
    (origin) => {
      expect(isLocalOrigin(origin)).toBe(false);
    },
  );
});
