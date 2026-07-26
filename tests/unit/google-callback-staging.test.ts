import { beforeEach, describe, expect, it } from "vitest";

import {
  clearGoogleCallbackCookie,
  isGoogleCallbackStagingRequest,
  readStagedGoogleCallback,
  stageGoogleCallback,
} from "~/connections/google-callback.server";

const KEY = "1f8b16e6a46dd3ac12ef7a328f1ce35c67b5bc8f1acdd76280e3674c3a4f19b2";
const NOW = 1_800_000_000_000;

function requestWithCookie(cookie: string): Request {
  return new Request("https://harnesst.example.com/google/callback", {
    headers: { cookie },
  });
}

describe("Google callback staging", () => {
  beforeEach(() => {
    process.env.HARNESST_SECRETS_KEY = KEY;
    process.env.BETTER_AUTH_URL = "https://harnesst.example.com";
  });

  it("immediately redirects to a clean URL with an encrypted, short-lived HttpOnly cookie", () => {
    const source = new Request(
      "https://harnesst.example.com/google/callback" +
        "?code=raw-code-sentinel&state=raw-state-sentinel",
    );

    expect(isGoogleCallbackStagingRequest(source)).toBe(true);
    const response = stageGoogleCallback(source, NOW);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/google/callback");
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("Path=/google/callback");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=300");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("raw-code-sentinel");
    expect(setCookie).not.toContain("raw-state-sentinel");

    const cookie = setCookie.split(";", 1)[0];
    expect(
      readStagedGoogleCallback(requestWithCookie(cookie), NOW + 1),
    ).toEqual({
      code: "raw-code-sentinel",
      error: null,
      state: "raw-state-sentinel",
    });
  });

  it("rejects tampered and cryptographically expired staged values", () => {
    const response = stageGoogleCallback(
      new Request(
        "https://harnesst.example.com/google/callback?error=access_denied&state=signed-state",
      ),
      NOW,
    );
    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
    const separator = cookie.indexOf("=");
    const value = cookie.slice(separator + 1);
    const tampered = `${cookie.slice(0, separator + 1)}${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;

    expect(
      readStagedGoogleCallback(requestWithCookie(tampered), NOW + 1),
    ).toBeNull();
    expect(
      readStagedGoogleCallback(requestWithCookie(cookie), NOW + 300_000),
    ).toBeNull();
  });

  it("expires the staging cookie on the clean callback response", () => {
    const clearing = clearGoogleCallbackCookie(
      new Request("https://harnesst.example.com/google/callback"),
    );
    expect(clearing).toContain("Max-Age=0");
    expect(clearing).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(clearing).toContain("HttpOnly");
    expect(clearing).toContain("Secure");
  });

  it("still redirects clean and removes stale staging when configuration is invalid", () => {
    delete process.env.HARNESST_SECRETS_KEY;
    process.env.BETTER_AUTH_URL = "not a URL";
    const response = stageGoogleCallback(
      new Request(
        "https://harnesst.example.com/google/callback?code=must-not-render&state=must-not-render",
      ),
      NOW,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/google/callback?failure=invalid",
    );
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("must-not-render");
  });
});
