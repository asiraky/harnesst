/**
 * GitHub App client (Connect pillar, M0).
 *
 * harnesst authenticates to GitHub as an App: a JWT signed with the App private key mints
 * short-lived per-installation tokens. Public callers pass only opaque verified grant ids;
 * this module resolves the raw GitHub installation id immediately before App authentication.
 *
 * Server-only (`.server.ts`) — the private key must never reach the client bundle. Env is
 * read lazily so the app boots without GitHub configured; the helpers throw a clear error
 * only when GitHub features are actually used.
 */
import { App } from "octokit";

import { resolveInstallationGrant } from "./installations.server";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  /** App slug, used to build the public install URL. */
  slug: string;
  webhookSecret?: string;
}

function readConfig(): GitHubAppConfig {
  const {
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_SLUG,
    GITHUB_WEBHOOK_SECRET,
  } = process.env;

  const missing = Object.entries({
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    GITHUB_APP_CLIENT_ID,
    GITHUB_APP_CLIENT_SECRET,
    GITHUB_APP_SLUG,
  }).flatMap(([k, v]) => (v ? [] : [k]));

  if (missing.length) {
    throw new Error(
      `GitHub App is not configured. Missing env: ${missing.join(", ")}. ` +
        `See .env.example and register a GitHub App (Connect pillar).`,
    );
  }

  return {
    appId: GITHUB_APP_ID!,
    // Support both real newlines and \n-escaped single-line values in .env.
    privateKey: GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    clientId: GITHUB_APP_CLIENT_ID!,
    clientSecret: GITHUB_APP_CLIENT_SECRET!,
    slug: GITHUB_APP_SLUG!,
    webhookSecret: GITHUB_WEBHOOK_SECRET,
  };
}

let cachedApp: App | undefined;
let cachedConfig: GitHubAppConfig | undefined;

export function getGitHubConfig(): GitHubAppConfig {
  return (cachedConfig ??= readConfig());
}

/** The App-level Octokit client (app JWT auth). */
function getGitHubApp(): App {
  if (cachedApp) return cachedApp;
  const cfg = getGitHubConfig();
  cachedApp = new App({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    oauth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
    ...(cfg.webhookSecret ? { webhooks: { secret: cfg.webhookSecret } } : {}),
  });
  return cachedApp;
}

/** An Octokit scoped to a single installation (per-installation token). */
export async function getInstallationOctokit(grantId: string | number) {
  const grant = await resolveInstallationGrant(String(grantId));
  return getGitHubApp().getInstallationOctokit(Number(grant.installationId));
}

/**
 * Mint a short-lived installation token NARROWED to a single repo with read-only `contents`
 * scope — the credential the assistant instance uses to clone/fetch a conversation checkout.
 * Unlike `getInstallationOctokit` (full-installation
 * scope), this asks GitHub for the minimal grant so a token that transiently reaches an instance
 * can only READ the one repo it is editing. The token is never a WRITE credential and is never
 * persisted to the shared checkout volume — the caller passes it per git invocation and drops it.
 *
 * Uses the App-JWT client's `apps.createInstallationAccessToken` (the `repositories`/`permissions`
 * narrowing params only exist on that App-level endpoint, not on an already-scoped installation
 * client). Returns the raw token string and its expiry.
 */
export async function mintNarrowedReadToken(input: {
  installationId: string;
  /** Repo name (not owner/name) — GitHub scopes `repositories` by name within the installation. */
  repo: string;
}): Promise<{ token: string; expiresAt: string }> {
  const grant = await resolveInstallationGrant(input.installationId);
  const octokit = getGitHubApp().octokit;
  const res = await octokit.rest.apps.createInstallationAccessToken(
    narrowedReadTokenParams(grant.installationId, input.repo),
  );
  return { token: res.data.token, expiresAt: res.data.expires_at };
}

/**
 * The exact `createInstallationAccessToken` params for a single-repo, contents:read grant — the
 * one place the narrowing shape is defined, extracted pure so a test can assert it without GitHub
 * credentials. Any drift here (a wider permission, more repos) is the security-relevant thing to catch.
 */
export function narrowedReadTokenParams(
  installationId: string | number,
  repo: string,
) {
  return {
    installation_id: Number(installationId),
    repositories: [repo],
    permissions: { contents: "read" as const },
  };
}

/** Public URL where a user installs the App on a new org/account. */
export function getInstallUrl(state?: string): string {
  const base = `https://github.com/apps/${getGitHubConfig().slug}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

export function githubUserAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    state: input.state,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeGitHubUserCode(
  input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    config: Pick<GitHubAppConfig, "clientId" | "clientSecret">;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString(),
    });
  } catch {
    throw new Error("GitHub's authorization service could not be reached.");
  }
  if (!response.ok) {
    throw new Error(
      `GitHub rejected the authorization code (HTTP ${response.status}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("GitHub returned a malformed authorization response.");
  }
  const token = (body as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !token) {
    throw new Error(
      "GitHub's authorization response did not contain an access token.",
    );
  }
  return token;
}

export interface GitHubUserInstallation {
  id: string;
  accountLogin: string | null;
}

/** List every installation associated with the authenticated GitHub user. */
export async function listGitHubUserInstallations(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubUserInstallation[]> {
  const found: GitHubUserInstallation[] = [];
  let url: string | null =
    "https://api.github.com/user/installations?per_page=100";
  while (url) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      throw new Error(
        "GitHub's installation verification service could not be reached.",
      );
    }
    if (!response.ok) {
      throw new Error(
        `GitHub could not verify installation ownership (HTTP ${response.status}).`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("GitHub returned a malformed installation list.");
    }
    const installations = (body as { installations?: unknown }).installations;
    if (!Array.isArray(installations)) {
      throw new Error("GitHub returned a malformed installation list.");
    }
    for (const item of installations) {
      const candidate = item as {
        id?: unknown;
        account?: { login?: unknown } | null;
      };
      if (
        typeof candidate.id !== "number" &&
        typeof candidate.id !== "string"
      ) {
        throw new Error("GitHub returned a malformed installation list.");
      }
      found.push({
        id: String(candidate.id),
        accountLogin:
          typeof candidate.account?.login === "string"
            ? candidate.account.login
            : null,
      });
    }
    const link: string = response.headers.get("link") ?? "";
    const next: RegExpMatchArray | undefined = link
      .split(",")
      .map((part: string) => part.match(/<([^>]+)>;\s*rel="next"/))
      .find((match): match is RegExpMatchArray => match !== null);
    url = next?.[1] ?? null;
  }
  return found;
}
