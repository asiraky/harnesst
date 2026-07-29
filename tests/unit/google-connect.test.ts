/**
 * Google OAuth broker (issue #30) — the pure authorize URL + state shapes and the code/refresh
 * network calls (with an injected fake fetch). What matters: offline+consent+identity scopes on
 * the authorize URL, a readable error on a bad exchange, a distinct InvalidGrantError for a dead
 * refresh token, and same-origin `returnTo` enforcement in the state.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  InvalidGrantError,
  connectionRowState,
  exchangeCode,
  googleAuthorizeUrl,
  missingScopes,
  refreshAccessToken,
  signConnectState,
  verifyConnectState,
  type GoogleConnectState,
} from "~/connections/google.server";

describe("missingScopes", () => {
  const SHEETS = "https://www.googleapis.com/auth/spreadsheets";
  const DRIVE = "https://www.googleapis.com/auth/drive";

  it("returns [] when every requested scope was granted", () => {
    expect(missingScopes(SHEETS, `${SHEETS} openid email`)).toEqual([]);
  });

  it("returns the scopes the user unchecked (granular consent)", () => {
    expect(missingScopes(`${SHEETS} ${DRIVE}`, `${SHEETS} openid`)).toEqual([
      DRIVE,
    ]);
  });

  it("is lenient when granted is empty or absent (skip the check)", () => {
    expect(missingScopes(SHEETS, "")).toEqual([]);
    expect(missingScopes(SHEETS, "   ")).toEqual([]);
  });

  it("ignores extra granted scopes beyond what was requested", () => {
    expect(missingScopes(SHEETS, `${SHEETS} ${DRIVE} openid email`)).toEqual(
      [],
    );
  });

  it("returns [] when nothing was requested", () => {
    expect(missingScopes("", `${SHEETS}`)).toEqual([]);
  });

  it("flags an identity-only grant as not covering a spreadsheets connector", () => {
    // Mirrors the real under-scoped fixture: a grant stored with identity scopes only must NOT be
    // treated as covering a connector that needs spreadsheets — the Deployment-tab Connections card
    // derives an "under-scoped" row from exactly this (issue #30).
    expect(
      missingScopes(
        SHEETS,
        "https://www.googleapis.com/auth/userinfo.email openid",
      ),
    ).toEqual([SHEETS]);
  });
});

describe("connectionRowState (issue #30)", () => {
  const SHEETS = "https://www.googleapis.com/auth/spreadsheets";
  const IDENTITY = "https://www.googleapis.com/auth/userinfo.email openid";

  it("is not-connected when the lock requires a provider but no grant exists yet", () => {
    // The freshly-installed-connector case: the wizard no longer connects, so the card must still
    // offer Connect with the lock-required scopes.
    expect(
      connectionRowState({
        hasGrant: false,
        grantStatus: null,
        requiredScopes: SHEETS,
        grantScopes: "",
      }),
    ).toBe("not-connected");
  });

  it("is connected when an active grant covers the required scopes", () => {
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: SHEETS,
        grantScopes: `${SHEETS} openid email`,
      }),
    ).toBe("connected");
  });

  it("is under-scoped when an active grant misses a required scope", () => {
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: SHEETS,
        grantScopes: IDENTITY,
      }),
    ).toBe("under-scoped");
  });

  it("treats a null/absent required set as covered (old locks with no snapshot)", () => {
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: null,
        grantScopes: IDENTITY,
      }),
    ).toBe("connected");
  });

  it("is inactive for an expired or revoked grant regardless of scopes", () => {
    for (const grantStatus of ["expired", "revoked"]) {
      expect(
        connectionRowState({
          hasGrant: true,
          grantStatus,
          requiredScopes: SHEETS,
          grantScopes: `${SHEETS} openid email`,
        }),
      ).toBe("inactive");
    }
  });

  it("is needs-reconnect when a covered grant's per-grant client no longer covers every environment (issue #167)", () => {
    // An environment created AFTER the grant: the immutable registered client can't know its
    // callback URL, so the card must ask for one reconnect (fresh registration).
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: SHEETS,
        grantScopes: `${SHEETS} openid email`,
        staleClientCoverage: true,
      }),
    ).toBe("needs-reconnect");
  });

  it("lets under-scoped win over stale client coverage — one reconnect fixes both (issue #167)", () => {
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: SHEETS,
        grantScopes: IDENTITY,
        staleClientCoverage: true,
      }),
    ).toBe("under-scoped");
  });

  it("keeps inactive winning over stale client coverage, and false coverage means connected (issue #167)", () => {
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "expired",
        requiredScopes: SHEETS,
        grantScopes: `${SHEETS} openid email`,
        staleClientCoverage: true,
      }),
    ).toBe("inactive");
    expect(
      connectionRowState({
        hasGrant: true,
        grantStatus: "active",
        requiredScopes: SHEETS,
        grantScopes: `${SHEETS} openid email`,
        staleClientCoverage: false,
      }),
    ).toBe("connected");
  });
});

const state: GoogleConnectState = {
  projectId: "projabcdefgh",
  agentId: "agntabcdefgh",
  userId: "userabcdefgh",
  sessionId: "sessabcdefgh",
  nonce: "nonceabcdefgh",
  provider: "google",
  scopes: "https://www.googleapis.com/auth/spreadsheets",
  returnTo:
    "/marketplace/bundle/google-sheets/install?project=projabcdefgh&member=pm",
  exp: 1_800_000_000_000,
};

describe("google connect state", () => {
  const key = randomBytes(32);

  it("round-trips a signed state", () => {
    const token = signConnectState(state, key);
    expect(verifyConnectState(token, key, state.exp - 1000)).toEqual(state);
  });

  it("rejects tamper, wrong key, and expiry", () => {
    const token = signConnectState(state, key);
    expect(
      verifyConnectState(token, randomBytes(32), state.exp - 1000),
    ).toBeNull();
    expect(verifyConnectState(token, key, state.exp)).toBeNull();
    expect(verifyConnectState("garbage", key)).toBeNull();
  });

  it("rejects a state whose returnTo is not same-origin relative", () => {
    const bad = signConnectState(
      { ...state, returnTo: "https://evil.example/x" },
      key,
    );
    expect(verifyConnectState(bad, key, state.exp - 1000)).toBeNull();
    const protoRel = signConnectState({ ...state, returnTo: "//evil" }, key);
    expect(verifyConnectState(protoRel, key, state.exp - 1000)).toBeNull();
  });

  it("rejects another provider or missing Better Auth binding", () => {
    const wrongProvider = signConnectState(
      { ...state, provider: "microsoft" } as unknown as GoogleConnectState,
      key,
    );
    expect(verifyConnectState(wrongProvider, key, state.exp - 1000)).toBeNull();

    const missingUser = { ...state } as Partial<GoogleConnectState>;
    delete missingUser.userId;
    const missingUserToken = signConnectState(
      missingUser as GoogleConnectState,
      key,
    );
    expect(
      verifyConnectState(missingUserToken, key, state.exp - 1000),
    ).toBeNull();

    const missingSession = { ...state } as Partial<GoogleConnectState>;
    delete missingSession.sessionId;
    const missingSessionToken = signConnectState(
      missingSession as GoogleConnectState,
      key,
    );
    expect(
      verifyConnectState(missingSessionToken, key, state.exp - 1000),
    ).toBeNull();

    const missingNonce = { ...state } as Partial<GoogleConnectState>;
    delete missingNonce.nonce;
    const missingNonceToken = signConnectState(
      missingNonce as GoogleConnectState,
      key,
    );
    expect(
      verifyConnectState(missingNonceToken, key, state.exp - 1000),
    ).toBeNull();
  });
});

describe("googleAuthorizeUrl", () => {
  it("adds offline/consent and identity scopes, response_type=code", () => {
    const url = googleAuthorizeUrl({
      clientId: "client_1",
      redirectUri: "https://harnesst.example/google/callback",
      state: "st at e",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(parsed.searchParams.get("client_id")).toBe("client_1");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://harnesst.example/google/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("st at e");
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/spreadsheets");
    expect(scope).toContain("openid");
    expect(scope).toContain("email");
  });

  it("does not duplicate an identity scope already requested", () => {
    const url = googleAuthorizeUrl({
      clientId: "c",
      redirectUri: "https://e/google/callback",
      state: "s",
      scopes: ["openid", "https://www.googleapis.com/auth/spreadsheets"],
    });
    const scope = new URL(url).searchParams.get("scope") ?? "";
    expect(scope.split(" ").filter((s) => s === "openid")).toHaveLength(1);
  });
});

describe("exchangeCode", () => {
  const config = { clientId: "c", clientSecret: "s" };

  it("returns the tokens on success", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/spreadsheets openid email",
        }),
        { status: 200 },
      )) as typeof fetch;
    const grant = await exchangeCode(
      { config, code: "code_1", redirectUri: "https://e/google/callback" },
      fetchImpl,
    );
    expect(grant.accessToken).toBe("at");
    expect(grant.refreshToken).toBe("rt");
    expect(grant.expiresIn).toBe(3599);
  });

  it("throws a readable error on a non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("bad", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode(
        { config, code: "x", redirectUri: "https://e/google/callback" },
        fetchImpl,
      ),
    ).rejects.toThrow(/Google rejected the token exchange/);
  });

  it("throws when Google returns no refresh_token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ access_token: "at", expires_in: 3599 }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      exchangeCode(
        { config, code: "x", redirectUri: "https://e/google/callback" },
        fetchImpl,
      ),
    ).rejects.toThrow(/no refresh token/i);
  });

  it("sends grant_type=authorization_code with the client creds", async () => {
    let body = "";
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 1,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await exchangeCode(
      { config, code: "code_1", redirectUri: "https://e/google/callback" },
      fetchImpl,
    );
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code_1");
    expect(params.get("client_id")).toBe("c");
    expect(params.get("client_secret")).toBe("s");
  });
});

describe("refreshAccessToken", () => {
  const config = { clientId: "c", clientSecret: "s" };

  it("returns a fresh access token on success", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ access_token: "fresh", expires_in: 3599 }),
        {
          status: 200,
        },
      )) as typeof fetch;
    const out = await refreshAccessToken(
      { config, refreshToken: "rt" },
      fetchImpl,
    );
    expect(out.accessToken).toBe("fresh");
    expect(out.expiresIn).toBe(3599);
  });

  it("throws InvalidGrantError on a 400 invalid_grant (dead grant)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch;
    await expect(
      refreshAccessToken({ config, refreshToken: "rt" }, fetchImpl),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("throws a plain error on a transient 500 (not a dead grant)", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const err = await refreshAccessToken(
      { config, refreshToken: "rt" },
      fetchImpl,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidGrantError);
  });
});
