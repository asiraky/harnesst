/**
 * Provider-generic OAuth broker (issue #163) — the pure shapes the generalization added on top
 * of the Google-only broker: PKCE (RFC 7636 verifier/challenge, carried through the signed
 * state), generic authorize-URL construction (authorizeParams / identityScopes / codeChallenge),
 * registry validation on verify, userinfo-less providers, and the byte-for-byte Google
 * regression the issue's acceptance criteria demand (google-connect.test.ts stays the
 * behavioral anchor; this file pins the exact URL literal).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  authorizeUrl,
  codeChallengeS256,
  exchangeCode,
  fetchAccountEmail,
  generateCodeVerifier,
  refreshAccessToken,
  registerOAuthClient,
  signConnectState,
  verifyConnectState,
  type ConnectState,
} from "~/connections/oauth.server";
import { googleAuthorizeUrl } from "~/connections/google.server";
import {
  getProvider,
  providerRedirectPath,
  type ProviderDefinition,
} from "~/connections/providers.server";

/**
 * A hypothetical PKCE provider definition, passed DIRECTLY (never resolved via the registry).
 * The real registry's mayi entry (issue #167) has different endpoints/flags — this local shape
 * deliberately exercises the generic builders (authorizeParams/identityScopes) instead.
 */
const MAYI: ProviderDefinition = {
  id: "mayi",
  label: "May I?",
  authorizeUrl: "https://auth.mayi.example/oauth/authorize",
  tokenUrl: "https://auth.mayi.example/oauth/token",
  pkce: true,
  authorizeParams: { audience: "https://api.mayi.example", access_type: "offline" },
  identityScopes: ["profile"],
  envPrefix: "MAYI",
};

const state: ConnectState = {
  projectId: "projabcdefgh",
  agentId: "agntabcdefgh",
  userId: "userabcdefgh",
  sessionId: "sessabcdefgh",
  nonce: "nonceabcdefgh",
  provider: "google",
  scopes: "https://www.googleapis.com/auth/spreadsheets",
  returnTo: "/dashboard",
  exp: 1_800_000_000_000,
};

describe("PKCE (RFC 7636)", () => {
  it("generates verifiers of exactly 43 chars from the unreserved base64url charset", () => {
    for (let i = 0; i < 32; i++) {
      // §4.1: code_verifier = 43*128unreserved; base64url of 32 random bytes is the 43-char floor.
      expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("derives the S256 challenge per the RFC's appendix B vector", () => {
    expect(
      codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("round-trips the code_verifier through the HMAC-signed state", () => {
    const key = randomBytes(32);
    const codeVerifier = generateCodeVerifier();
    const token = signConnectState({ ...state, codeVerifier }, key);
    const verified = verifyConnectState(token, key, state.exp - 1000);
    expect(verified?.codeVerifier).toBe(codeVerifier);
    // The challenge the connect route put on the authorize URL still matches what the callback
    // will send on the exchange — the round-trip loses nothing.
    expect(codeChallengeS256(verified!.codeVerifier!)).toBe(
      codeChallengeS256(codeVerifier),
    );
  });

  it("accepts the RFC length bounds (43 and 128) and rejects outside them", () => {
    const key = randomBytes(32);
    const ok = (codeVerifier: string) =>
      verifyConnectState(
        signConnectState({ ...state, codeVerifier }, key),
        key,
        state.exp - 1000,
      );
    expect(ok("a".repeat(43))).not.toBeNull();
    expect(ok("a".repeat(128))).not.toBeNull();
    expect(ok("a".repeat(42))).toBeNull();
    expect(ok("a".repeat(129))).toBeNull();
  });

  it("rejects a non-string codeVerifier while a state without one stays valid", () => {
    const key = randomBytes(32);
    const bad = signConnectState(
      { ...state, codeVerifier: 42 } as unknown as ConnectState,
      key,
    );
    expect(verifyConnectState(bad, key, state.exp - 1000)).toBeNull();
    const plain = signConnectState(state, key);
    expect(verifyConnectState(plain, key, state.exp - 1000)).toEqual(state);
  });
});

describe("verifyConnectState registry validation", () => {
  it("rejects a state whose provider is not registered (the registry is the authority)", () => {
    // "mayi" is REAL as of issue #167, so an unknown id proves the registry check now.
    const key = randomBytes(32);
    const token = signConnectState({ ...state, provider: "notaprovider" }, key);
    expect(verifyConnectState(token, key, state.exp - 1000)).toBeNull();
  });
});

describe("authorizeUrl (generic)", () => {
  const input = {
    clientId: "client_1",
    redirectUri: "https://harnesst.example/connections/mayi/callback",
    state: "signed-state",
    scopes: "mayi.approvals",
  };

  it("emits params in insertion order: standard, authorizeParams, state", () => {
    const url = authorizeUrl(MAYI, input);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(MAYI.authorizeUrl);
    expect([...parsed.searchParams.keys()]).toEqual([
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "audience",
      "access_type",
      "state",
    ]);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("audience")).toBe("https://api.mayi.example");
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("state")).toBe("signed-state");
  });

  it("appends identityScopes after the requested scopes, deduped", () => {
    const url = authorizeUrl(MAYI, input);
    expect(new URL(url).searchParams.get("scope")).toBe(
      "mayi.approvals profile",
    );
    const already = authorizeUrl(MAYI, {
      ...input,
      scopes: ["profile", "mayi.approvals"],
    });
    expect(new URL(already).searchParams.get("scope")).toBe(
      "profile mayi.approvals",
    );
  });

  it("adds code_challenge + S256 method only when a challenge is passed", () => {
    const verifier = generateCodeVerifier();
    const withPkce = new URL(
      authorizeUrl(MAYI, { ...input, codeChallenge: codeChallengeS256(verifier) }),
    );
    expect(withPkce.searchParams.get("code_challenge")).toBe(
      codeChallengeS256(verifier),
    );
    expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");

    const without = new URL(authorizeUrl(MAYI, input));
    expect(without.searchParams.has("code_challenge")).toBe(false);
    expect(without.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("exchangeCode with PKCE", () => {
  const config = { clientId: "c", clientSecret: "s" };
  const grantBody = JSON.stringify({
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3599,
    scope: "mayi.approvals",
  });

  it("sends code_verifier when supplied and omits it otherwise", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(grantBody, { status: 200 });
    }) as typeof fetch;

    const verifier = generateCodeVerifier();
    await exchangeCode(
      {
        provider: MAYI,
        config,
        code: "code_1",
        redirectUri: "https://e/connections/mayi/callback",
        codeVerifier: verifier,
      },
      fetchImpl,
    );
    await exchangeCode(
      {
        provider: MAYI,
        config,
        code: "code_2",
        redirectUri: "https://e/connections/mayi/callback",
      },
      fetchImpl,
    );
    expect(new URLSearchParams(bodies[0]).get("code_verifier")).toBe(verifier);
    expect(new URLSearchParams(bodies[1]).has("code_verifier")).toBe(false);
  });

  it("names the provider label in exchange errors", async () => {
    const fetchImpl = (async () =>
      new Response("bad", { status: 400 })) as typeof fetch;
    await expect(
      exchangeCode(
        { provider: MAYI, config, code: "x", redirectUri: "https://e/cb" },
        fetchImpl,
      ),
    ).rejects.toThrow(/May I\? rejected the token exchange/);
  });
});

describe("fetchAccountEmail without a userinfo endpoint", () => {
  it("returns null with zero network calls", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await fetchAccountEmail(MAYI, "at", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Google-unchanged regression (issue #163 acceptance criterion 2)", () => {
  const input = {
    clientId: "client_1",
    redirectUri: "https://harnesst.example/google/callback",
    state: "st at e",
    scopes: "https://www.googleapis.com/auth/spreadsheets",
  };

  it("produces the Google-only broker's authorize URL byte-for-byte", () => {
    // The pre-#163 construction — insertion order and all — MINUS include_granted_scopes: issue
    // #165 removed it deliberately (harnesst always requests the full effective set, and with the
    // param set Google folds previously granted scopes into every new token, so a narrowed
    // scope-group selection could never re-issue a narrower grant on reconnect).
    const expected = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(
      {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: `${input.scopes} openid email`,
        access_type: "offline",
        prompt: "consent",
        state: input.state,
      },
    ).toString()}`;
    expect(authorizeUrl(getProvider("google")!, input)).toBe(expected);
    // The compat shim the legacy routes/tests use emits the identical bytes.
    expect(googleAuthorizeUrl(input)).toBe(expected);
  });

  it("never re-broadens a narrowed grant via incremental auth (issue #165)", () => {
    // include_granted_scopes must stay OFF the Google authorize URL — see the registry comment.
    const url = new URL(authorizeUrl(getProvider("google")!, input));
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("never puts PKCE params on Google's authorize URL (google declares no pkce)", () => {
    expect(getProvider("google")!.pkce).toBeUndefined();
    const url = new URL(authorizeUrl(getProvider("google")!, input));
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });

  it("keeps Google on the legacy /google/callback redirect path; new providers get the canonical one", () => {
    expect(providerRedirectPath(getProvider("google")!)).toBe(
      "/google/callback",
    );
    expect(providerRedirectPath(MAYI)).toBe("/connections/mayi/callback");
  });

  it("derives the S256 challenge with sha256/base64url (sanity against node primitives)", () => {
    const verifier = generateCodeVerifier();
    expect(codeChallengeS256(verifier)).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });
});

/* ───────────────────────────── issue #167 additions ───────────────────────────── */

/** Captures every token-endpoint body a test's fetch sees, replying with `reply`. */
function capturingFetch(reply: object) {
  const bodies: URLSearchParams[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

describe("public clients (issue #167)", () => {
  const grantReply = { access_token: "at", refresh_token: "rt", expires_in: 3599 };

  it("omits client_secret from the code exchange when the config has none (PKCE is the proof)", async () => {
    const { bodies, fetchImpl } = capturingFetch(grantReply);
    await exchangeCode(
      {
        provider: MAYI,
        config: { clientId: "pub_client" },
        code: "code_1",
        redirectUri: "https://e/connections/mayi/callback",
        codeVerifier: generateCodeVerifier(),
      },
      fetchImpl,
    );
    expect(bodies[0].get("client_id")).toBe("pub_client");
    expect(bodies[0].has("client_secret")).toBe(false);
  });

  it("still sends client_secret for a confidential client (google regression)", async () => {
    const { bodies, fetchImpl } = capturingFetch(grantReply);
    await exchangeCode(
      {
        provider: getProvider("google")!,
        config: { clientId: "c", clientSecret: "s" },
        code: "code_1",
        redirectUri: "https://e/google/callback",
      },
      fetchImpl,
    );
    expect(bodies[0].get("client_secret")).toBe("s");
  });

  it("omits client_secret from the refresh for a public client and sends it for a confidential one", async () => {
    const { bodies, fetchImpl } = capturingFetch({ access_token: "at", expires_in: 3599 });
    await refreshAccessToken(
      { provider: MAYI, config: { clientId: "pub_client" }, refreshToken: "rt" },
      fetchImpl,
    );
    await refreshAccessToken(
      {
        provider: getProvider("google")!,
        config: { clientId: "c", clientSecret: "s" },
        refreshToken: "rt",
      },
      fetchImpl,
    );
    expect(bodies[0].get("client_id")).toBe("pub_client");
    expect(bodies[0].has("client_secret")).toBe(false);
    expect(bodies[1].get("client_secret")).toBe("s");
  });
});

describe("rotating refresh grants (issue #167)", () => {
  it("returns the rotated refresh_token when the refresh response carries one", async () => {
    const { fetchImpl } = capturingFetch({
      access_token: "at_new",
      refresh_token: "rt_rotated",
      expires_in: 3600,
    });
    const out = await refreshAccessToken(
      { provider: MAYI, config: { clientId: "c" }, refreshToken: "rt_old" },
      fetchImpl,
    );
    expect(out).toEqual({
      accessToken: "at_new",
      expiresIn: 3600,
      refreshToken: "rt_rotated",
    });
  });

  it("leaves refreshToken undefined when the response has none (google shape, unchanged)", async () => {
    const { fetchImpl } = capturingFetch({ access_token: "at", expires_in: 3599 });
    const out = await refreshAccessToken(
      {
        provider: getProvider("google")!,
        config: { clientId: "c", clientSecret: "s" },
        refreshToken: "rt",
      },
      fetchImpl,
    );
    expect(out).toEqual({ accessToken: "at", expiresIn: 3599 });
    expect("refreshToken" in out).toBe(false);
  });
});

describe("registerOAuthClient (RFC 7591, issue #167)", () => {
  const REG: ProviderDefinition = {
    ...MAYI,
    clientRegistration: {
      endpoint: "https://auth.mayi.example/oauth/register",
      approvalCallbackPath: "/eve/v1/mayi/approval-resolved",
    },
  };

  it("POSTs the RFC 7591 JSON body and returns the minted client_id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ client_id: "reg_client_1" }), {
        status: 201,
      });
    }) as typeof fetch;
    const out = await registerOAuthClient(
      {
        provider: REG,
        clientName: "harnesst — proj / agent",
        redirectUris: ["https://harnesst.example/connections/mayi/callback"],
        approvalCallbackUris: [
          "https://harnesst.example/e/env_1/eve/v1/mayi/approval-resolved",
        ],
      },
      fetchImpl,
    );
    expect(out).toEqual({ clientId: "reg_client_1" });
    expect(calls[0].url).toBe(REG.clientRegistration!.endpoint);
    expect(calls[0].body).toEqual({
      client_name: "harnesst — proj / agent",
      redirect_uris: ["https://harnesst.example/connections/mayi/callback"],
      approval_callback_uris: [
        "https://harnesst.example/e/env_1/eve/v1/mayi/approval-resolved",
      ],
    });
  });

  it("omits approval_callback_uris entirely when there are none", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ client_id: "reg_client_2" }), {
        status: 201,
      });
    }) as typeof fetch;
    await registerOAuthClient(
      { provider: REG, clientName: "harnesst — p / a", redirectUris: ["https://e/cb"] },
      fetchImpl,
    );
    expect("approval_callback_uris" in calls[0].body).toBe(false);
  });

  it("throws a readable error carrying the provider's rejection", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid_client_metadata"}', {
        status: 400,
      })) as typeof fetch;
    await expect(
      registerOAuthClient(
        { provider: REG, clientName: "n", redirectUris: ["https://e/cb"] },
        fetchImpl,
      ),
    ).rejects.toThrow(
      /May I\? rejected the OAuth client registration \(HTTP 400\).*invalid_client_metadata/,
    );
  });

  it("throws when the response is missing a client_id", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 201 })) as typeof fetch;
    await expect(
      registerOAuthClient(
        { provider: REG, clientName: "n", redirectUris: ["https://e/cb"] },
        fetchImpl,
      ),
    ).rejects.toThrow(/missing a client_id/);
  });

  it("refuses a provider that declares no clientRegistration", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      registerOAuthClient(
        { provider: MAYI, clientName: "n", redirectUris: ["https://e/cb"] },
        fetchImpl,
      ),
    ).rejects.toThrow(/does not support dynamic client registration/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("connect-state clientId (issue #167)", () => {
  it("round-trips a registered client id through the signed state", () => {
    const key = randomBytes(32);
    const token = signConnectState({ ...state, clientId: "reg_client_1" }, key);
    expect(verifyConnectState(token, key, state.exp - 1000)?.clientId).toBe(
      "reg_client_1",
    );
  });

  it("rejects an empty or non-string clientId; a state without one stays valid", () => {
    const key = randomBytes(32);
    const empty = signConnectState({ ...state, clientId: "" }, key);
    expect(verifyConnectState(empty, key, state.exp - 1000)).toBeNull();
    const bad = signConnectState(
      { ...state, clientId: 42 } as unknown as ConnectState,
      key,
    );
    expect(verifyConnectState(bad, key, state.exp - 1000)).toBeNull();
    const plain = signConnectState(state, key);
    expect(verifyConnectState(plain, key, state.exp - 1000)).toEqual(state);
  });
});

describe("connect-state environmentIds (issue #167)", () => {
  it("round-trips the registered environment set through the signed state", () => {
    const key = randomBytes(32);
    const token = signConnectState(
      { ...state, environmentIds: ["envaaaaaaaaa", "envbbbbbbbbb"] },
      key,
    );
    expect(
      verifyConnectState(token, key, state.exp - 1000)?.environmentIds,
    ).toEqual(["envaaaaaaaaa", "envbbbbbbbbb"]);
    // An empty set is valid (an agent with no environments registers no callbacks).
    const none = signConnectState({ ...state, environmentIds: [] }, key);
    expect(
      verifyConnectState(none, key, state.exp - 1000)?.environmentIds,
    ).toEqual([]);
  });

  it("rejects a malformed environmentIds; a state without one stays valid", () => {
    const key = randomBytes(32);
    for (const environmentIds of ["env", [""], [42], {}]) {
      const bad = signConnectState(
        { ...state, environmentIds } as unknown as ConnectState,
        key,
      );
      expect(verifyConnectState(bad, key, state.exp - 1000)).toBeNull();
    }
    const plain = signConnectState(state, key);
    expect(verifyConnectState(plain, key, state.exp - 1000)).toEqual(state);
  });
});

describe("mayi provider OAuth endpoints (issue #167)", () => {
  // Regression guard: the OAuth server is app.mayi.sh — mayi.sh is the marketing site and its
  // /api/oauth/* return 404/405, so a mayi.sh endpoint fails Connect with a 405 at registration.
  // Authoritative source: https://app.mayi.sh/.well-known/oauth-authorization-server.
  it("targets app.mayi.sh, not the marketing host", () => {
    const mayi = getProvider("mayi")!;
    expect(mayi.authorizeUrl).toBe("https://app.mayi.sh/api/oauth/authorize");
    expect(mayi.tokenUrl).toBe("https://app.mayi.sh/api/oauth/token");
    expect(mayi.clientRegistration?.endpoint).toBe(
      "https://app.mayi.sh/api/oauth/register",
    );
  });
});
