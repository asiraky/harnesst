/**
 * Issue #250: a FOH loader throw must render inside the pane, with a way back, instead of
 * bubbling to the root boundary and replacing the whole three-pane shell.
 */
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { FohPaneError, paneErrorMessage } from "~/components/foh/pane-error";

/** The shape `isRouteErrorResponse` recognises — what a thrown `data(..., {status})` becomes. */
const routeError = (status: number, statusText: string, data: unknown) => ({
  status,
  statusText,
  data,
  internal: false,
});

describe("paneErrorMessage", () => {
  it("turns a 404 into something actionable rather than the loader's terse throw", () => {
    const message = paneErrorMessage(
      routeError(404, "Not Found", "Session not found"),
      "conversation",
    );
    expect(message).toMatch(/conversation isn't available/i);
    // The loader's internal wording must not be what the reader is shown.
    expect(message).not.toContain("Session not found");
  });

  it("names the access case for a 403", () => {
    expect(
      paneErrorMessage(routeError(403, "Forbidden", null), "team member"),
    ).toMatch(/don't have access to this team member/i);
  });

  it("falls back on any other status without leaking the status text", () => {
    expect(
      paneErrorMessage(routeError(500, "Kaboom", null), "conversation"),
    ).toBe("Couldn't open this conversation (error 500).");
  });

  it("says something safe for a thrown Error", () => {
    const message = paneErrorMessage(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      "conversation",
    );
    expect(message).toBe("Something went wrong opening this conversation.");
    expect(message).not.toContain("ECONNREFUSED");
  });
});

describe("FohPaneError", () => {
  it("renders the message and a link back to the session list", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <FohPaneError
            error={routeError(404, "Not Found", "Session not found")}
            subject="conversation"
            backTo="/t/p1/a1"
            backLabel="Sessions"
          />
        ),
      },
    ]);
    const html = renderToString(<Stub initialEntries={["/"]} />);
    expect(html).toContain('href="/t/p1/a1"');
    expect(html).toContain("Sessions");
    expect(html).toMatch(/isn&#x27;t available|isn't available/);
    expect(html).toContain('role="alert"');
  });
});
