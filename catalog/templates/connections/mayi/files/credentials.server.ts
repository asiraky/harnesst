/**
 * harnesst credential binding for brokered connections (issue #167).
 *
 * May I? rotates its OAuth refresh token on every refresh and revokes the whole token family if
 * an old one is reused — so this instance NEVER holds the refresh token. harnesst owns the grant,
 * refreshes it centrally, and this binding fetches short-lived access tokens from harnesst's token
 * broker (`POST <HARNESST_API_URL>/api/connections/token`), authenticated by the deployment's own
 * `HARNESST_TEAM_TOKEN`. Both env vars are injected by harnesst at deploy; nothing here is a secret an
 * author manages.
 *
 * Tokens are cached until shortly before `expiresAt` (with in-flight dedupe), so broker traffic
 * is about one request per token lifetime — roughly hourly — not per approval.
 */
interface HarnesstCredentials {
  getAccessToken(integration: "mayi"): Promise<string>;
}

interface BrokeredToken {
  token: string;
  /** Unix ms; refreshed 60s early so a token is never used at the edge of its life. */
  expiresAt: number;
}

const cache = new Map<string, BrokeredToken>();
const inFlight = new Map<string, Promise<string>>();

async function fetchAccessToken(integration: string): Promise<string> {
  const base = process.env.HARNESST_API_URL;
  const teamToken = process.env.HARNESST_TEAM_TOKEN;
  if (!base || !teamToken) {
    throw new Error(
      `The ${integration} connection is not configured — HARNESST_API_URL / HARNESST_TEAM_TOKEN are ` +
        "injected by harnesst at deploy from the agent's connection. Connect the provider from the " +
        "agent's Deployment tab, then redeploy.",
    );
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/connections/token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${teamToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: integration }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    accessToken?: string;
    expiresAt?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.accessToken) {
    throw new Error(
      `harnesst couldn't issue a ${integration} access token` +
        (body?.error ? `: ${body.error}` : ` (HTTP ${res.status}).`),
    );
  }
  cache.set(integration, {
    token: body.accessToken,
    // No expiresAt from the broker would mean "don't cache" — expire immediately.
    expiresAt: body.expiresAt ?? Date.now(),
  });
  return body.accessToken;
}

/**
 * harnesst's generated credential binding (replaces the @mayiapp/eve example placeholder): a current
 * access token for the named integration, fetched from harnesst's token broker and cached per
 * `expiresAt`. The adapter and SDK never store tokens.
 */
export const credentials: HarnesstCredentials = {
  async getAccessToken(integration) {
    const cached = cache.get(integration);
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
    const pending = inFlight.get(integration);
    if (pending) return pending;
    const request = fetchAccessToken(integration).finally(() => {
      inFlight.delete(integration);
    });
    inFlight.set(integration, request);
    return request;
  },
};
