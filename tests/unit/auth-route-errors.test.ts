import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: vi.fn() }));

vi.mock("~/lib/auth.server", () => ({
  auth: { handler: mocks.handler },
}));

import { action, loader } from "~/routes/api.auth.$";

function args(request: Request) {
  return {
    request,
    params: { "*": "reset-password/do-not-log" },
    context: undefined,
  } as never;
}

describe("Better Auth resource-route errors", () => {
  beforeEach(() => {
    mocks.handler.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([loader, action])(
    "returns a generic response without logging a token-bearing error",
    async (handler) => {
      const sentinel = "do-not-log-reset-token";
      mocks.handler.mockRejectedValue(
        new Error(`adapter failed for reset-password:${sentinel}`),
      );
      const spies = [
        vi.spyOn(console, "error").mockImplementation(() => undefined),
        vi.spyOn(console, "warn").mockImplementation(() => undefined),
        vi.spyOn(console, "info").mockImplementation(() => undefined),
        vi.spyOn(console, "log").mockImplementation(() => undefined),
      ];

      const response = await handler(
        args(
          new Request(
            `https://harnesst.example.com/api/auth/reset-password/${sentinel}`,
            { method: handler === action ? "POST" : "GET" },
          ),
        ),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      expect(
        JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
      ).not.toContain(sentinel);
    },
  );
});
