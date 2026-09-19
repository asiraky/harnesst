/**
 * Codex device-code OAuth client (issue #28) — the request/poll/exchange/refresh network calls and
 * the JWT identity decode, all against an injected `fetch` stub (no real I/O). Pins the pending
 * semantics (403/404 = still authorizing), device-login-disabled surfacing, refresh-token rotation,
 * and invalid_grant → InvalidGrantError.
 */
import { describe, expect, it } from "vitest";

import {
  DeviceLoginDisabledError,
  InvalidGrantError,
  decodeJwtClaims,
  exchangeDeviceCode,
  extractAccountIdentity,
  pollDeviceToken,
  refreshCodexTokens,
  requestDeviceCode,
} from "~/connections/codex.server";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that returns queued responses and records the requests it saw. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return (
      responses.shift() ?? jsonResponse(500, { error: "no response queued" })
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Build an unsigned JWT with the given payload claims (header/signature are ignored). */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

describe("requestDeviceCode", () => {
  it("returns the device code + verification URL on success", async () => {
    const { impl } = stubFetch([
      jsonResponse(200, {
        device_auth_id: "dev_1",
        user_code: "ABCD-1234",
        interval: 4,
      }),
    ]);
    const code = await requestDeviceCode(impl);
    expect(code).toMatchObject({
      deviceAuthId: "dev_1",
      userCode: "ABCD-1234",
      interval: 4,
    });
    expect(code.verificationUrl).toContain("/codex/device");
  });

  it("throws DeviceLoginDisabledError on a 404", async () => {
    const { impl } = stubFetch([jsonResponse(404, {})]);
    await expect(requestDeviceCode(impl)).rejects.toBeInstanceOf(
      DeviceLoginDisabledError,
    );
  });

  it("throws a readable error on any other non-2xx", async () => {
    const { impl } = stubFetch([new Response("nope", { status: 500 })]);
    await expect(requestDeviceCode(impl)).rejects.toThrow(/HTTP 500/);
  });
});

describe("pollDeviceToken", () => {
  it("reports pending on 403 and 404", async () => {
    for (const status of [403, 404]) {
      const { impl } = stubFetch([new Response("", { status })]);
      expect(
        await pollDeviceToken({ deviceAuthId: "d", userCode: "u" }, impl),
      ).toBe("pending");
    }
  });

  it("returns the authorization code + verifier on success", async () => {
    const { impl } = stubFetch([
      jsonResponse(200, {
        authorization_code: "auth_1",
        code_verifier: "ver_1",
      }),
    ]);
    expect(
      await pollDeviceToken({ deviceAuthId: "d", userCode: "u" }, impl),
    ).toEqual({
      authorizationCode: "auth_1",
      codeVerifier: "ver_1",
    });
  });

  it("throws on an unexpected error status", async () => {
    const { impl } = stubFetch([new Response("boom", { status: 500 })]);
    await expect(
      pollDeviceToken({ deviceAuthId: "d", userCode: "u" }, impl),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("exchangeDeviceCode", () => {
  it("exchanges the code for tokens", async () => {
    const { impl } = stubFetch([
      jsonResponse(200, {
        access_token: "at",
        refresh_token: "rt",
        id_token: "it",
        expires_in: 3600,
      }),
    ]);
    const tokens = await exchangeDeviceCode(
      { authorizationCode: "auth_1", codeVerifier: "ver_1" },
      impl,
    );
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      idToken: "it",
      expiresIn: 3600,
    });
  });
});

describe("refreshCodexTokens", () => {
  it("keeps a rotated refresh token when the response carries one", async () => {
    const { impl } = stubFetch([
      jsonResponse(200, {
        access_token: "at2",
        refresh_token: "rt2",
        expires_in: 1800,
      }),
    ]);
    const tokens = await refreshCodexTokens("rt1", impl);
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("rt2");
  });

  it("falls back to the sent refresh token when none is rotated", async () => {
    const { impl } = stubFetch([
      jsonResponse(200, { access_token: "at2", expires_in: 1800 }),
    ]);
    const tokens = await refreshCodexTokens("rt1", impl);
    expect(tokens.refreshToken).toBe("rt1");
  });

  it("throws InvalidGrantError on invalid_grant", async () => {
    const { impl } = stubFetch([
      jsonResponse(400, { error: "invalid_grant", error_description: "dead" }),
    ]);
    await expect(refreshCodexTokens("rt1", impl)).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
  });

  it("throws a plain error on a transient 5xx (worth a retry)", async () => {
    const { impl } = stubFetch([new Response("upstream", { status: 503 })]);
    const err = await refreshCodexTokens("rt1", impl).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidGrantError);
  });
});

describe("decodeJwtClaims", () => {
  it("decodes the payload of a valid-looking JWT", () => {
    expect(decodeJwtClaims(jwt({ email: "a@b.com" }))).toMatchObject({
      email: "a@b.com",
    });
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtClaims("not.a.jwt.at.all")).toBeNull();
    expect(decodeJwtClaims("onlyonesegment")).toBeNull();
    expect(decodeJwtClaims(null)).toBeNull();
    expect(decodeJwtClaims(undefined)).toBeNull();
  });
});

describe("extractAccountIdentity", () => {
  it("prefers the id_token email and top-level chatgpt_account_id", () => {
    const identity = extractAccountIdentity({
      idToken: jwt({ email: "me@x.com", chatgpt_account_id: "acct_top" }),
      accessToken: jwt({ chatgpt_account_id: "acct_access" }),
    });
    expect(identity).toEqual({ email: "me@x.com", accountId: "acct_top" });
  });

  it("falls back through the namespaced auth claim chain", () => {
    const identity = extractAccountIdentity({
      idToken: jwt({
        email: "me@x.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_nested" },
      }),
      accessToken: null,
    });
    expect(identity.accountId).toBe("acct_nested");
  });

  it("falls back to the first organization id", () => {
    const identity = extractAccountIdentity({
      idToken: null,
      accessToken: jwt({
        "https://api.openai.com/auth": { organizations: [{ id: "org_first" }] },
      }),
    });
    expect(identity.accountId).toBe("org_first");
  });

  it("does not guess an account from an ambiguous organization list", () => {
    expect(
      extractAccountIdentity({
        idToken: null,
        accessToken: jwt({
          "https://api.openai.com/auth": {
            organizations: [{ id: "one" }, { id: "two" }],
          },
        }),
      }).accountId,
    ).toBeNull();
  });

  it("returns nulls when nothing is present", () => {
    expect(
      extractAccountIdentity({ idToken: null, accessToken: null }),
    ).toEqual({
      email: null,
      accountId: null,
    });
  });
});
