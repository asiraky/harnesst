/**
 * Per-agent GitHub App Manifest flow (issue #26) — the pure shapes.
 *
 * The manifest literal is the App's entire grant: any drift here (a wider permission, an
 * extra event) is the security-relevant thing to catch. The state token is what binds a
 * GitHub redirect back to (project, agent, environment) — tampering and expiry must fail
 * closed. Conflict detection is what keeps two agents from sharing one @mention identity.
 */
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GITHUB_APP_NAME_MAX,
  buildAppManifest,
  createAppJwt,
  defaultAppName,
  findAppCredentialConflict,
  findStoredAppCredentialConflict,
  listAppInstallations,
  manifestSubmitUrl,
  signManifestState,
  verifyManifestState,
  type AppCredentialRow,
  type ManifestState,
} from "~/github/app-manifest.server";
import { fingerprint } from "~/seams/oss/secretbox";

describe("buildAppManifest", () => {
  it("emits exactly the channel's grant — nothing wider", () => {
    const manifest = buildAppManifest({
      name: "triage-acme",
      homepageUrl: "https://eden.example/repos/p1/deployment",
      webhookUrl: "https://eden.example/e/envabcdefghij/eve/v1/github",
      redirectUrl: "https://eden.example/github/apps/callback",
      setupUrl: "https://eden.example/repos/p1/deployment",
      description: "triage — a harnesst agent.",
    });
    expect(manifest).toEqual({
      name: "triage-acme",
      url: "https://eden.example/repos/p1/deployment",
      hook_attributes: {
        url: "https://eden.example/e/envabcdefghij/eve/v1/github",
        active: true,
      },
      redirect_url: "https://eden.example/github/apps/callback",
      setup_url: "https://eden.example/repos/p1/deployment",
      description: "triage — a harnesst agent.",
      // Always public: one App installs across the owner's personal account and any org, each
      // installation still scoped to the repos its installer picks.
      public: true,
      default_permissions: {
        metadata: "read",
        contents: "write",
        issues: "write",
        pull_requests: "write",
      },
      default_events: [
        "issue_comment",
        "issues",
        "pull_request",
        "pull_request_review_comment",
      ],
    });
  });
});

describe("App installations (Deployment card status)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  it("createAppJwt signs RS256 as the App with GitHub's clock-drift backdating", () => {
    const now = new Date("2026-07-09T10:00:00Z");
    const jwt = createAppJwt("12345", pem, now);
    const [header, payload, signature] = jwt.split(".");

    const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);

    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(claims).toEqual({ iss: "12345", iat: nowSeconds - 60, exp: nowSeconds + 300 });
  });

  it("createAppJwt restores literal \\n escapes in the PEM (hosted secret stores)", () => {
    const escaped = pem.replace(/\n/g, "\\n");
    const jwt = createAppJwt("12345", escaped);
    const [header, payload, signature] = jwt.split(".");
    const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("listAppInstallations authenticates as the App and maps the accounts", async () => {
    let captured: { url: string; auth: string } | null = null;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(url),
        auth: (init?.headers as Record<string, string>).authorization,
      };
      return new Response(
        JSON.stringify([
          {
            account: { login: "acme-org", type: "Organization" },
            repository_selection: "all",
            html_url: "https://github.com/organizations/acme-org/settings/installations/1",
          },
          {
            account: { login: "jane", type: "User" },
            repository_selection: "selected",
            html_url: "https://github.com/settings/installations/2",
          },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const installations = await listAppInstallations(
      { appId: "12345", privateKey: pem },
      fetchImpl,
    );

    expect(captured!.url).toBe("https://api.github.com/app/installations?per_page=100");
    expect(captured!.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(installations).toEqual([
      {
        account: "acme-org",
        accountType: "Organization",
        repositorySelection: "all",
        htmlUrl: "https://github.com/organizations/acme-org/settings/installations/1",
      },
      {
        account: "jane",
        accountType: "User",
        repositorySelection: "selected",
        htmlUrl: "https://github.com/settings/installations/2",
      },
    ]);
  });

  it("listAppInstallations fails loudly on a GitHub error (callers fall back to a link)", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(
      listAppInstallations({ appId: "12345", privateKey: pem }, fetchImpl),
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe("defaultAppName", () => {
  it("joins agent and project slug", () => {
    expect(defaultAppName("triage", "acme")).toBe("triage-acme");
  });

  it("caps at GitHub's 34-char limit without a trailing hyphen", () => {
    const name = defaultAppName("a-rather-long-agent-name", "an-even-longer-project-slug");
    expect(name.length).toBeLessThanOrEqual(GITHUB_APP_NAME_MAX);
    expect(name.endsWith("-")).toBe(false);
  });

  it("sanitizes characters GitHub rejects", () => {
    expect(defaultAppName("triage@bot!", "acme co")).toBe("triage-bot-acme co");
  });

  it("works without a project slug", () => {
    expect(defaultAppName("triage", null)).toBe("triage");
  });
});

describe("manifestSubmitUrl", () => {
  it("targets the personal form by default and the org form when named", () => {
    expect(manifestSubmitUrl("tok")).toBe("https://github.com/settings/apps/new?state=tok");
    expect(manifestSubmitUrl("tok", "acme")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=tok",
    );
  });
});

describe("manifest state token", () => {
  const key = randomBytes(32);
  const state: ManifestState = {
    projectId: "projabcdefgh",
    agentId: "agntabcdefgh",
    environmentId: "envabcdefghi",
    userId: "user_1",
    sessionId: "sess_1",
    nonce: "nonce-value",
    exp: 1_800_000_000_000,
  };

  it("round-trips a signed state", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, key, state.exp - 1000)).toEqual(state);
  });

  it("rejects a tampered payload", () => {
    const token = signManifestState(state, key);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...state, agentId: "someoneelse1" }),
      "utf8",
    ).toString("base64url");
    expect(verifyManifestState(`${forged}.${sig}`, key, state.exp - 1000)).toBeNull();
    expect(verifyManifestState(`${payload}.AAAA`, key, state.exp - 1000)).toBeNull();
  });

  it("rejects the wrong key", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, randomBytes(32), state.exp - 1000)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signManifestState(state, key);
    expect(verifyManifestState(token, key, state.exp)).toBeNull();
    expect(verifyManifestState(token, key, state.exp + 1)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyManifestState("", key)).toBeNull();
    expect(verifyManifestState("no-dot", key)).toBeNull();
    expect(verifyManifestState("a.b.c", key)).toBeNull();
  });

  it("rejects a state without the user/session binding or nonce", () => {
    const { userId: _u, sessionId: _s, nonce: _n, ...legacy } = state;
    const token = signManifestState(legacy as ManifestState, key);
    expect(verifyManifestState(token, key, state.exp - 1000)).toBeNull();
  });
});

describe("app credential conflicts", () => {
  const rows: AppCredentialRow[] = [
    {
      agentId: "agent-a",
      agentName: "triage",
      key: "GITHUB_APP_SLUG",
      fingerprint: fingerprint("triage-bot"),
    },
    {
      agentId: "agent-a",
      agentName: "triage",
      key: "GITHUB_APP_ID",
      fingerprint: fingerprint("12345"),
    },
    {
      agentId: "agent-b",
      agentName: "engineer",
      key: "GITHUB_APP_SLUG",
      fingerprint: fingerprint("engineer-bot"),
    },
  ];

  it("flags another agent already holding the slug", () => {
    expect(
      findAppCredentialConflict(rows, "agent-b", { slug: "triage-bot" }),
    ).toEqual({ agentName: "triage", key: "GITHUB_APP_SLUG" });
  });

  it("flags another agent already holding the App ID", () => {
    expect(findAppCredentialConflict(rows, null, { appId: "12345" })).toEqual({
      agentName: "triage",
      key: "GITHUB_APP_ID",
    });
  });

  it("never flags the agent's own credentials (re-install/update)", () => {
    expect(
      findAppCredentialConflict(rows, "agent-a", {
        slug: "triage-bot",
        appId: "12345",
      }),
    ).toBeNull();
  });

  it("passes fresh values, empty inputs, and value-less rows", () => {
    expect(findAppCredentialConflict(rows, null, { slug: "brand-new" })).toBeNull();
    expect(findAppCredentialConflict(rows, null, {})).toBeNull();
    expect(
      findAppCredentialConflict(
        [{ agentId: "x", agentName: "x", key: "GITHUB_APP_SLUG", fingerprint: null }],
        null,
        { slug: "anything" },
      ),
    ).toBeNull();
  });

  it("detects two agents storing the same slug at deploy time", () => {
    const dup: AppCredentialRow[] = [
      ...rows,
      {
        agentId: "agent-c",
        agentName: "reviewer",
        key: "GITHUB_APP_SLUG",
        fingerprint: fingerprint("triage-bot"),
      },
    ];
    expect(findStoredAppCredentialConflict(dup, "agent-c")).toEqual({
      agentName: "triage",
      key: "GITHUB_APP_SLUG",
    });
    expect(findStoredAppCredentialConflict(rows, "agent-a")).toBeNull();
  });
});
