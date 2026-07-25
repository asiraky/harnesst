import { describe, expect, it, vi } from "vitest";

import {
  exchangeGitHubUserCode,
  githubUserAuthorizeUrl,
  listGitHubUserInstallations,
} from "~/github/client.server";
import {
  pkceChallenge,
  signGitHubInstallState,
  verifyGitHubInstallState,
} from "~/github/install-state.server";

const KEY = Buffer.alloc(32, 7);

describe("GitHub installation ownership state", () => {
  it("round-trips only signed, live, fully shaped state", () => {
    const value = {
      nonce: "n".repeat(43),
      userId: "user-1",
      sessionId: "session-1",
      orgId: "org-1",
      exp: 20_000,
    };
    const token = signGitHubInstallState(value, KEY);
    expect(verifyGitHubInstallState(token, KEY, 19_999)).toEqual(value);
    expect(verifyGitHubInstallState(`${token}x`, KEY, 19_999)).toBeNull();
    expect(verifyGitHubInstallState(token, KEY, 20_000)).toBeNull();
    expect(verifyGitHubInstallState("malformed", KEY, 1)).toBeNull();

    const bad = signGitHubInstallState({ ...value, orgId: 4 } as never, KEY);
    expect(verifyGitHubInstallState(bad, KEY, 1)).toBeNull();
  });

  it("builds a PKCE S256 GitHub authorize URL", () => {
    const url = new URL(
      githubUserAuthorizeUrl({
        clientId: "client-id",
        state: "opaque.state",
        redirectUri: "https://harnesst.test/github/installations/callback",
        codeChallenge: pkceChallenge("verifier"),
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id",
      state: "opaque.state",
      redirect_uri: "https://harnesst.test/github/installations/callback",
      code_challenge_method: "S256",
      code_challenge: pkceChallenge("verifier"),
    });
  });
});

describe("GitHub user OAuth network boundary", () => {
  it("exchanges with the verifier and fixed callback/client fields", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        Response.json({ access_token: "secret-user-token" }),
    );
    await expect(
      exchangeGitHubUserCode(
        {
          code: "one-use-code",
          codeVerifier: "pkce-verifier",
          redirectUri: "https://harnesst.test/github/installations/callback",
          config: { clientId: "client", clientSecret: "client-secret" },
        },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toBe("secret-user-token");
    const body = new URLSearchParams(
      fetchImpl.mock.calls[0][1]?.body as string,
    );
    expect(Object.fromEntries(body)).toEqual({
      client_id: "client",
      client_secret: "client-secret",
      code: "one-use-code",
      redirect_uri: "https://harnesst.test/github/installations/callback",
      code_verifier: "pkce-verifier",
    });
  });

  it("paginates user installations and extracts the matching account without leaking tokens", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { installations: [{ id: 41, account: { login: "first" } }] },
          { headers: { link: '<https://api.github.test/page2>; rel="next"' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          installations: [{ id: 42, account: { login: "target" } }],
        }),
      );
    await expect(
      listGitHubUserInstallations("do-not-leak", fetchImpl as typeof fetch),
    ).resolves.toEqual([
      { id: "41", accountLogin: "first" },
      { id: "42", accountLogin: "target" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = vi.fn(
      async () => new Response("do-not-leak", { status: 401 }),
    );
    await expect(
      listGitHubUserInstallations("do-not-leak", failing as typeof fetch),
    ).rejects.not.toThrow(/do-not-leak/);
  });

  it("fails closed on malformed token and installation responses", async () => {
    const malformedToken = vi.fn(async () =>
      Response.json({ access_token: 123 }),
    );
    await expect(
      exchangeGitHubUserCode(
        {
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "https://harnesst.test/github/installations/callback",
          config: { clientId: "client", clientSecret: "secret" },
        },
        malformedToken as typeof fetch,
      ),
    ).rejects.toThrow(/did not contain/);

    const malformedList = vi.fn(async () =>
      Response.json({ installations: "nope" }),
    );
    await expect(
      listGitHubUserInstallations("token", malformedList as typeof fetch),
    ).rejects.toThrow(/malformed/);
  });
});
