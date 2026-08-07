/**
 * Per-agent GitHub App Manifest flow (issue #26).
 *
 * The GitHub channel is a per-agent GitHub App — the agent's @mention identity AND its
 * working credential on the repos the App is installed on. harnesst submits a
 * [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
 * to GitHub, GitHub redirects back with a one-hour single-use `code`, and one
 * `POST /app-manifests/{code}/conversions` returns everything the channel needs
 * (`id`, `slug`, `pem`, `webhook_secret`) — which we write straight into that agent's secrets.
 *
 * This mints the AGENT'S App. It is strictly separate from harnesst's own Connect App
 * (`client.server.ts`), which is the control plane's credential for the eve CONFIG repo and
 * is never reused for agents.
 *
 * The `state` round-tripped through GitHub is an HMAC-signed binding to (project, agent,
 * environment) with an expiry — the callback trusts it only after verifying the signature
 * with the tenant-wide secrets key AND re-checking the session's org owns the project.
 *
 * Everything shape-like is exported pure so tests assert the literals (the repo convention);
 * only `convertManifestCode` and the secret/DB helpers touch the network or the database.
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agents, secretsMetadata } from "~/db/schema";
import { decodeKey, fingerprint } from "~/seams/oss/secretbox";

/** The eve GitHub channel's route inside a deployed instance (see the channel template). */
export const GITHUB_CHANNEL_ROUTE = "/eve/v1/github";

/** The four secrets the GitHub channel consumes — exactly what a conversion yields. */
export const GITHUB_CHANNEL_SECRET_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_SLUG",
] as const;

/** GitHub App names are capped at 34 characters (and must be globally unique). */
export const GITHUB_APP_NAME_MAX = 34;

/* ─────────────────────────────── manifest (pure) ─────────────────────────────── */

export interface AppManifestInput {
  /** Pre-filled app name — the user can edit it on GitHub's confirmation screen. */
  name: string;
  /** Homepage shown on the App's page — the agent's page in harnesst. */
  homepageUrl: string;
  /** Where GitHub delivers channel events: `<origin>/e/<environmentId>/eve/v1/github`. */
  webhookUrl: string;
  /** Where GitHub redirects with `?code=` after the user approves creation. */
  redirectUrl: string;
  /** After the user installs the App on repos, GitHub sends them here. */
  setupUrl: string;
  description?: string;
}

/**
 * The manifest posted to GitHub — the one place the App's grant is defined, pure so a test
 * can assert it without credentials. Any drift here (a wider permission, an extra event) is
 * the security-relevant thing to catch:
 *
 * - `issues`/`pull_requests` write — the conversational loop (read mentions, post replies)
 *   and opened/label event coverage.
 * - `contents` write — the App doubles as the agent's DO-WORK credential (clone, branch,
 *   push) on the repos it's installed on; it is the agent's only GitHub credential.
 * - `metadata` read is implied by any grant but stated for clarity.
 */
export function buildAppManifest(input: AppManifestInput) {
  return {
    name: input.name,
    url: input.homepageUrl,
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: input.redirectUrl,
    setup_url: input.setupUrl,
    description: input.description ?? "",
    // Public so one App can be installed across every account the agent works — the owner's
    // personal account and any org — from a single link. Each installation is still scoped to
    // the repositories its installer picks.
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
  };
}

/**
 * Default App name: the agent's name (its natural @mention identity), suffixed with the
 * project slug to dodge GitHub's GLOBAL name uniqueness (a bare `triage` is usually taken).
 * Just a pre-fill — GitHub's confirmation screen lets the user edit it, and the real slug is
 * ALWAYS taken from the conversion response, never from this proposal.
 */
export function defaultAppName(agentName: string, projectSlug?: string | null): string {
  const clean = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9 -]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
  const base = clean(agentName);
  const suffix = projectSlug ? clean(projectSlug) : "";
  const joined = suffix ? `${base}-${suffix}` : base;
  return joined.slice(0, GITHUB_APP_NAME_MAX).replace(/-+$/, "");
}

/**
 * Where the manifest form posts. Personal by default; GitHub uses a different path for
 * org-owned Apps. `state` rides the query string and comes back on the redirect.
 */
export function manifestSubmitUrl(state: string, organization?: string | null): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

/* ─────────────────────────── state token (pure given key) ─────────────────────────── */

export interface ManifestState {
  projectId: string;
  agentId: string;
  environmentId: string;
  /** Better Auth user + session that started the flow — the callback must match both. */
  userId: string;
  sessionId: string;
  /** Random server-recorded nonce consumed atomically by the callback (single use). */
  nonce: string;
  /** Unix ms after which the token is dead. GitHub's code lives 1h; so do we. */
  exp: number;
}

export const MANIFEST_STATE_TTL_MS = 60 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString("base64url");

function stateSignature(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** `base64url(payload).base64url(hmac)` — bound to the agent, expiring, tamper-evident. */
export function signManifestState(state: ManifestState, key: Buffer): string {
  const payload = b64url(Buffer.from(JSON.stringify(state), "utf8"));
  return `${payload}.${b64url(stateSignature(payload, key))}`;
}

/** Verify signature + expiry; null on anything off (never throws on malformed input). */
export function verifyManifestState(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): ManifestState | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  const expected = stateSignature(payload, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed?.projectId !== "string" ||
      typeof parsed?.agentId !== "string" ||
      typeof parsed?.environmentId !== "string" ||
      typeof parsed?.userId !== "string" ||
      typeof parsed?.sessionId !== "string" ||
      typeof parsed?.nonce !== "string" ||
      typeof parsed?.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp <= now) return null;
    return parsed as ManifestState;
  } catch {
    return null;
  }
}

/** The HMAC key: the same tenant-wide key that seals secrets (no new key to provision). */
export function manifestStateKey(): Buffer {
  return decodeKey(process.env.HARNESST_SECRETS_KEY);
}

/* ─────────────────────────────── conversion (network) ─────────────────────────────── */

export interface ManifestConversion {
  appId: string;
  /** GitHub derives the slug from the FINAL name — authoritative, never harnesst's proposal. */
  slug: string;
  pem: string;
  webhookSecret: string;
  htmlUrl: string;
  /** Account (user or org) that owns the new App. */
  ownerLogin: string | null;
  ownerType: string | null;
}

/**
 * Exchange the redirect's `code` for the App's credentials. This response is the ONLY time
 * GitHub hands over the `pem`/`webhook_secret` — the caller must persist before redirecting
 * onward. The code is single-use and expires after one hour.
 */
export async function convertManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestConversion> {
  const res = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub did not accept the App creation code (HTTP ${res.status}). ` +
        "The code is single-use and expires after an hour — restart the flow from harnesst.",
    );
  }
  const body = (await res.json()) as {
    id: number;
    slug: string;
    pem: string;
    webhook_secret: string | null;
    html_url: string;
    owner: { login?: string; type?: string } | null;
  };
  if (!body.slug || !body.pem) {
    throw new Error("GitHub's conversion response is missing the App credentials.");
  }
  return {
    appId: String(body.id),
    slug: body.slug,
    pem: body.pem,
    webhookSecret: body.webhook_secret ?? "",
    htmlUrl: body.html_url,
    ownerLogin: body.owner?.login ?? null,
    ownerType: body.owner?.type ?? null,
  };
}

/** Where the user installs the newly minted App on the repos it should watch. */
export function appInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/* ───────────────────── installation status (Deployment card) ───────────────────── */

/** One place the agent's App is installed — an account (user or org) and its repo grant. */
export interface AppInstallation {
  /**
   * GitHub's installation id. The listing itself doesn't need it — `listAppRepositories` does:
   * repository NAMES are only readable through an installation token, which is minted per id.
   */
  id: number;
  /** The account's login (user or organization name). */
  account: string;
  accountType: "User" | "Organization" | string;
  /** GitHub's grant shape: "all" repositories, or "selected" ones. */
  repositorySelection: string;
  /** GitHub's settings page for this installation (adjust repos, uninstall). */
  htmlUrl: string;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * A short-lived RS256 App JWT — authenticates AS the agent's App (not as an installation),
 * which is what `GET /app/installations` requires. `iat` is backdated 60s per GitHub's
 * clock-drift guidance.
 */
export function createAppJwt(
  appId: string,
  privateKey: string,
  now: Date = new Date(),
): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 5 * 60, iss: appId };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  // Hosted secret stores sometimes flatten PEM newlines into literal "\n" — restore them.
  const pem = privateKey.replace(/\\n/g, "\n");
  const signature = createSign("RSA-SHA256").update(signingInput).sign(pem, "base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Every account the agent's App is installed on — the Deployment card renders this so the
 * user sees real state ("installed on org1, all repos") and adds accounts from harnesst instead
 * of having to know GitHub's install-page URL. Uses the AGENT'S App credentials (the ones
 * the manifest callback stored), never harnesst's own Connect App.
 */
export async function listAppInstallations(
  creds: { appId: string; privateKey: string },
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<AppInstallation[]> {
  const res = await fetchImpl("https://api.github.com/app/installations?per_page=100", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${createAppJwt(creds.appId, creds.privateKey, now)}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub rejected the App installations listing (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as Array<{
    id?: number;
    account: { login?: string; type?: string } | null;
    repository_selection?: string;
    html_url?: string;
  }>;
  return body.map((i) => ({
    id: i.id ?? 0,
    account: i.account?.login ?? "(unknown)",
    accountType: i.account?.type ?? "User",
    repositorySelection: i.repository_selection ?? "selected",
    htmlUrl: i.html_url ?? "",
  }));
}

/**
 * The `owner/repo` names one installation covers — the repository picker's options.
 *
 * Two hops, because GitHub splits the answer across two credentials: the App JWT can list
 * installations and their GRANT ("all" / "selected") but never the names, and the names sit behind
 * an INSTALLATION token. Same App credentials as everything else here (the agent's, never
 * harnesst's Connect App), so a repo the agent can't work on can't appear in the picker either.
 *
 * One page of 100. An installation wider than that truncates, which costs nothing that matters —
 * the panel keeps a typed field beside the picker precisely so a repo it can't offer is still
 * enterable.
 */
export async function listInstallationRepositories(
  creds: { appId: string; privateKey: string },
  installationId: number,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string[]> {
  const headers = (auth: string) => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${auth}`,
    "x-github-api-version": "2022-11-28",
  });
  const tokenRes = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    {
      method: "POST",
      headers: headers(createAppJwt(creds.appId, creds.privateKey, now)),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!tokenRes.ok) {
    throw new Error(
      `GitHub refused an installation token for installation ${installationId} (HTTP ${tokenRes.status}).`,
    );
  }
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) throw new Error("GitHub's installation-token response carried no token.");
  const res = await fetchImpl(
    "https://api.github.com/installation/repositories?per_page=100",
    { headers: headers(token), signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub rejected the installation repositories listing (HTTP ${res.status}).`,
    );
  }
  const body = (await res.json()) as {
    repositories?: Array<{ full_name?: string }>;
  };
  return (body.repositories ?? [])
    .map((r) => r.full_name)
    .filter((name): name is string => typeof name === "string" && name !== "");
}

/**
 * Every repository the agent's App can see, across every account it is installed on — deduped and
 * sorted so the picker's order doesn't churn between loads.
 *
 * Best-effort BY CONSTRUCTION: the picker is a convenience over a field that stays typeable, so an
 * installation that can't be read costs its own repositories and nothing else, and a total failure
 * returns an empty list which the panel reads as "no picker". This must never throw — it runs
 * inside the deployments loader, where a GitHub hiccup rendering the whole tab unusable would be a
 * far worse failure than an unpicked repository name.
 */
export async function listAppRepositories(
  creds: { appId: string; privateKey: string },
  installations: Array<{ id: number }>,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<string[]> {
  const names = new Set<string>();
  for (const installation of installations) {
    if (!installation.id) continue;
    try {
      for (const name of await listInstallationRepositories(
        creds,
        installation.id,
        fetchImpl,
        now,
      )) {
        names.add(name);
      }
    } catch {
      // Unreadable installation (revoked, suspended, rate-limited) — skip it, keep the rest.
    }
  }
  return [...names].sort();
}

/* ─────────────────────── slug/App-ID uniqueness (issue #26) ─────────────────────── */

/**
 * Two agents in one project answering to the same GitHub App is ambiguous — an App has one
 * webhook URL, so at best one agent silently never hears its mentions. The manifest flow
 * can't produce this (GitHub enforces global App uniqueness), but the manual fallback lets a
 * user paste the same credentials twice — so harnesst checks at install time.
 *
 * Detection needs no decryption: `secrets_metadata` stores an unkeyed SHA-256 fingerprint of
 * each plaintext, so equal values ⇒ equal fingerprints.
 */
export interface AppCredentialRow {
  agentId: string;
  agentName: string;
  key: string;
  fingerprint: string | null;
}

const CONFLICT_KEYS = ["GITHUB_APP_SLUG", "GITHUB_APP_ID"] as const;

/** All agent-scoped GITHUB_APP_SLUG / GITHUB_APP_ID metadata rows in the project. */
export async function listAppCredentialRows(projectId: string): Promise<AppCredentialRow[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      key: secretsMetadata.key,
      fingerprint: secretsMetadata.fingerprint,
    })
    .from(secretsMetadata)
    .innerJoin(agents, eq(agents.id, secretsMetadata.agentId))
    .where(
      and(
        eq(secretsMetadata.projectId, projectId),
        inArray(secretsMetadata.key, [...CONFLICT_KEYS]),
      ),
    );
  return rows;
}

/**
 * Pure conflict check: does another agent already hold this slug or App ID? Returns the
 * first conflicting (agent, key) for the error message, or null. `selfAgentId` excludes the
 * agent being written (re-installs and updates are not conflicts); pass null for a
 * new-member install (no agent row yet — every match is a conflict).
 */
export function findAppCredentialConflict(
  rows: AppCredentialRow[],
  selfAgentId: string | null,
  values: { slug?: string; appId?: string },
): { agentName: string; key: string } | null {
  const wanted = new Map<string, string>();
  if (values.slug) wanted.set("GITHUB_APP_SLUG", fingerprint(values.slug));
  if (values.appId) wanted.set("GITHUB_APP_ID", fingerprint(values.appId));
  if (wanted.size === 0) return null;
  for (const row of rows) {
    if (selfAgentId !== null && row.agentId === selfAgentId) continue;
    if (!row.fingerprint) continue;
    const fp = wanted.get(row.key);
    if (fp && fp === row.fingerprint) {
      return { agentName: row.agentName, key: row.key };
    }
  }
  return null;
}

/**
 * Deploy-time variant: no plaintext in hand, but duplicates show up as two agents holding
 * the SAME stored fingerprint for a conflict key. Catches credentials that slipped in via
 * the settings page (where no install-time check runs).
 */
export function findStoredAppCredentialConflict(
  rows: AppCredentialRow[],
  agentId: string,
): { agentName: string; key: string } | null {
  for (const mine of rows) {
    if (mine.agentId !== agentId || !mine.fingerprint) continue;
    const other = rows.find(
      (r) =>
        r.agentId !== agentId &&
        r.key === mine.key &&
        r.fingerprint === mine.fingerprint,
    );
    if (other) return { agentName: other.agentName, key: mine.key };
  }
  return null;
}
