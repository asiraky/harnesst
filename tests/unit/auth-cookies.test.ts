/**
 * Session cookie naming (#296). `__Host-` is enforced by the browser from the NAME, and only when
 * the cookie is also `Secure` — so the two fields have to move together, or the deployment gets a
 * name whose promise the attributes do not keep (browsers then drop the cookie entirely: a sign-in
 * that appears to succeed and never persists).
 */
import { describe, expect, it } from "vitest";

import { authCookieConfig } from "~/lib/auth-cookies";

describe("authCookieConfig", () => {
  it("host-locks the cookie on any https origin", () => {
    expect(authCookieConfig({ BETTER_AUTH_URL: "https://harnesst.example.com" })).toEqual({
      secure: true,
      cookiePrefix: "__Host-harnesst",
    });
  });

  it("drops the prefix over plain http, where a Secure cookie would never be stored", () => {
    const config = authCookieConfig({ BETTER_AUTH_URL: "http://localhost:5173" });
    expect(config.secure).toBe(false);
    expect(config.cookiePrefix).not.toContain("__Host-");
  });

  it("reads the scheme case- and whitespace-insensitively", () => {
    expect(
      authCookieConfig({ BETTER_AUTH_URL: "  HTTPS://harnesst.example.com  " }).secure,
    ).toBe(true);
  });

  it("assumes https in production when no origin is configured, and not otherwise", () => {
    expect(authCookieConfig({ NODE_ENV: "production" }).secure).toBe(true);
    expect(authCookieConfig({ NODE_ENV: "development" }).secure).toBe(false);
    expect(authCookieConfig({}).secure).toBe(false);
  });

  it("never names a cookie __Host- without Secure", () => {
    for (const env of [
      { BETTER_AUTH_URL: "https://a.example" },
      { BETTER_AUTH_URL: "http://a.example" },
      { NODE_ENV: "production" },
      {},
    ]) {
      const config = authCookieConfig(env);
      expect(config.cookiePrefix.startsWith("__Host-")).toBe(config.secure);
    }
  });
});
