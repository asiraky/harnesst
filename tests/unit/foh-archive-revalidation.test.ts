import { describe, expect, it } from "vitest";

import { archivedOpenSessionShouldRevalidate } from "~/foh/archive-revalidation";

function args(
  overrides: Partial<
    Parameters<typeof archivedOpenSessionShouldRevalidate>[0]
  > = {},
) {
  return {
    currentUrl: new URL("http://localhost/t/proj_1/agent_1/s/sess_1"),
    currentParams: {
      projectId: "proj_1",
      agentId: "agent_1",
      sessionId: "sess_1",
    },
    nextUrl: new URL("http://localhost/t/proj_1/agent_1/s/sess_1"),
    nextParams: {
      projectId: "proj_1",
      agentId: "agent_1",
      sessionId: "sess_1",
    },
    defaultShouldRevalidate: true,
    ...overrides,
  };
}

describe("FOH archive revalidation", () => {
  it("does not reload the child route after its open session is archived", () => {
    expect(
      archivedOpenSessionShouldRevalidate(
        args({
          formAction: "/api/foh/proj_1/archive",
          formMethod: "POST",
          actionResult: {
            ok: true,
            intent: "archive",
            sessionId: "sess_1",
            title: "Invoice run",
          },
        }),
      ),
    ).toBe(false);
  });

  it("reloads when a different session was archived", () => {
    expect(
      archivedOpenSessionShouldRevalidate(
        args({
          formAction: "/api/foh/proj_1/archive",
          actionResult: {
            ok: true,
            intent: "archive",
            sessionId: "sess_2",
          },
        }),
      ),
    ).toBe(true);
  });

  it("keeps React Router's default for refusals and unrelated actions", () => {
    expect(
      archivedOpenSessionShouldRevalidate(
        args({
          formAction: "/api/foh/proj_1/archive",
          actionResult: {
            ok: false,
            intent: "archive",
            sessionId: "sess_1",
          },
        }),
      ),
    ).toBe(true);
    expect(
      archivedOpenSessionShouldRevalidate(
        args({
          formAction: "/api/foh/proj_1/read",
          actionResult: {
            ok: true,
            intent: "archive",
            sessionId: "sess_1",
          },
          defaultShouldRevalidate: false,
        }),
      ),
    ).toBe(false);
  });
});
