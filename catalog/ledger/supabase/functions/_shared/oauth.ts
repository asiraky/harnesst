import { authorized } from "./auth.ts";
import type { Backend } from "./approvals.ts";
const origin = "https://app.mayi.sh";
const scopes = "approval:create approval:read approval:cancel";
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
const challenge = async (value: string) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function oauthHandler(
  db: Backend,
  base: string,
  setupKey: string,
  fetcher: typeof fetch = fetch,
) {
  const redirect = `${base}/functions/v1/approval-oauth`;
  const callback = `${base}/functions/v1/approval-callback`;
  async function post(path: string, body: unknown, registrationClaim?: string) {
    const res = await fetcher(origin + path, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      // A definite client rejection created no registration. Uncertain outcomes
      // retain the claim to prevent silently creating another OAuth client.
      if (
        registrationClaim &&
        res.status >= 400 &&
        res.status < 500 &&
        res.status !== 408
      )
        await db("registration_failed", { claim: registrationClaim });
      throw new Error(
        `May I authorization failed (HTTP ${res.status}). Return to installation and reconnect.`,
      );
    }
    return res.json();
  }
  return async (request: Request): Promise<Response> => {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    let attempt: string | undefined;
    let phase = "request";
    try {
      if (request.method === "POST") {
        if (!(await authorized(request, setupKey)))
          return new Response("Unauthorized", { status: 401, headers });
        const raw = await request.text();
        if (raw.length > 4096)
          return new Response("Too large", { status: 413, headers });
        const input = JSON.parse(raw);
        if (input.operation === "status")
          return Response.json(await db("status"), { headers });
        if (
          input.operation !== "start" ||
          typeof input.label !== "string" ||
          !input.label.trim() ||
          input.label.length > 100
        )
          return new Response("Invalid request", { status: 400, headers });
        const claim = crypto.randomUUID();
        phase = "registration";
        const existing = await db("registration", {
          claim,
          redirect_url: redirect,
        });
        if (!existing.client_id) {
          phase = "register-client";
          const client = await post(
            "/api/oauth/register",
            {
              client_name: "HARNESST Ledger",
              redirect_uris: [redirect],
              approval_callback_uris: [callback],
            },
            claim,
          );
          if (typeof client.client_id !== "string" || !client.client_id)
            throw new Error("May I registration returned no client identity");
          phase = "save-client";
          await db("registered", {
            claim,
            client_id: client.client_id,
            origin,
            redirect_url: redirect,
            callback_url: callback,
            label: input.label,
          });
        }
        phase = "pkce";
        const state = random(),
          verifier = random();
        phase = "begin";
        const c = await db("begin", {
          id: crypto.randomUUID(),
          state_hash: await hash(state),
          verifier,
          label: input.label,
        });
        phase = "authorize-url";
        const url = new URL("/api/oauth/authorize", origin);
        url.search = new URLSearchParams({
          client_id: c.client_id,
          redirect_uri: redirect,
          response_type: "code",
          code_challenge_method: "S256",
          code_challenge: await challenge(verifier),
          scope: scopes,
          state,
          label: input.label,
          ...(c.agent_id ? { connection: c.agent_id } : {}),
        }).toString();
        return Response.json({ url: url.href }, { headers });
      }
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405, headers });
      const url = new URL(request.url),
        state = url.searchParams.get("state");
      if (!state || !/^[a-f0-9]{64}$/.test(state))
        return new Response("Invalid authorization state", {
          status: 400,
          headers,
        });
      const c = await db("consume", { state_hash: await hash(state) });
      attempt = c.id;
      if (url.searchParams.has("error"))
        throw new Error(
          "May I authorization was declined or failed. Return to installation to try again.",
        );
      const code = url.searchParams.get("code");
      if (!code) throw new Error("Missing authorization code");
      const grant = await post("/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: c.verifier,
        client_id: c.client_id,
        redirect_uri: c.redirect_url,
      });
      if (
        typeof grant.access_token !== "string" ||
        !grant.access_token ||
        typeof grant.refresh_token !== "string" ||
        !grant.refresh_token ||
        !Number.isSafeInteger(grant.expires_in) ||
        grant.expires_in < 1 ||
        typeof grant.agent_id !== "string" ||
        !grant.agent_id
      )
        throw new Error(
          "May I did not return the required connection identity. Its reconnect update must be deployed before connecting.",
        );
      if (c.agent_id && grant.agent_id !== c.agent_id)
        throw new Error(
          "May I returned a different connection. Existing approvals have not been reassigned.",
        );
      await db("save", {
        id: c.id,
        access_token: grant.access_token,
        refresh_token: grant.refresh_token,
        expires_in: grant.expires_in,
        agent_id: grant.agent_id,
      });
      return new Response(
        "May I connected. Close this tab and return to HARNESST installation.",
        { headers },
      );
    } catch (error) {
      if (attempt) await db("failed", { id: attempt }).catch(() => {});
      // Only our own fixed messages reach browsers; database/provider bodies may contain credentials.
      const message =
        error instanceof Error &&
        (error.message.startsWith("May I ") ||
          error.message.startsWith("Missing authorization"))
          ? error.message
          : "Authorization unavailable or expired. Return to installation and try again. If registration was interrupted, contact the installation administrator.";
      const diagnostic =
        error instanceof Error &&
        /^Approval database operation failed \([0-9]{3}; [A-Z0-9a-z]+\)$/.test(
          error.message,
        )
          ? error.message
          : error instanceof Error
            ? error.name
            : "Error";
      return new Response(message, {
        status: 400,
        headers: {
          ...headers,
          "X-Installation-Error": `${phase}: ${diagnostic}`,
        },
      });
    }
  };
}
