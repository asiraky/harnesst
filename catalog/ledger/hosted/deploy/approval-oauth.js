// Generated from canonical Supabase sources.

// catalog/ledger/supabase/functions/_shared/auth.ts
async function authorized(request, secret) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const digest = async (value) => new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );
  const [a, b] = await Promise.all([
    digest(header),
    digest(`Bearer ${secret}`)
  ]);
  let different = 0;
  for (let n = 0; n < a.length; n++) different |= a[n] ^ b[n];
  return different === 0;
}

// catalog/ledger/supabase/functions/_shared/oauth.ts
var origin = "https://app.mayi.sh";
var scopes = "approval:create approval:read approval:cancel";
var random = () => Array.from(
  crypto.getRandomValues(new Uint8Array(32)),
  (n) => n.toString(16).padStart(2, "0")
).join("");
async function hash(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    ),
    (n) => n.toString(16).padStart(2, "0")
  ).join("");
}
var challenge = async (value) => btoa(
  String.fromCharCode(
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    )
  )
).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
function oauthHandler(db, base, setupKey, fetcher = fetch) {
  const redirect = `${base}/functions/v1/approval-oauth`;
  const callback = `${base}/functions/v1/approval-callback`;
  async function post(path, body, registrationClaim) {
    const res = await fetcher(origin + path, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) {
      if (registrationClaim && res.status >= 400 && res.status < 500 && res.status !== 408)
        await db("registration_failed", { claim: registrationClaim });
      throw new Error(
        `May I authorization failed (HTTP ${res.status}). Return to installation and reconnect.`
      );
    }
    return res.json();
  }
  return async (request) => {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    };
    let attempt;
    let phase = "request";
    try {
      if (request.method === "POST") {
        if (!await authorized(request, setupKey))
          return new Response("Unauthorized", { status: 401, headers });
        const raw = await request.text();
        if (raw.length > 4096)
          return new Response("Too large", { status: 413, headers });
        const input = JSON.parse(raw);
        if (input.operation === "status")
          return Response.json(await db("status"), { headers });
        if (input.operation !== "start" || typeof input.label !== "string" || !input.label.trim() || input.label.length > 100)
          return new Response("Invalid request", { status: 400, headers });
        const claim = crypto.randomUUID();
        phase = "registration";
        const existing = await db("registration", {
          claim,
          redirect_url: redirect
        });
        if (!existing.client_id) {
          phase = "register-client";
          const client = await post(
            "/api/oauth/register",
            {
              client_name: "HARNESST Ledger",
              redirect_uris: [redirect],
              approval_callback_uris: [callback]
            },
            claim
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
            label: input.label
          });
        }
        phase = "pkce";
        const state2 = random(), verifier = random();
        phase = "begin";
        const c2 = await db("begin", {
          id: crypto.randomUUID(),
          state_hash: await hash(state2),
          verifier,
          label: input.label
        });
        phase = "authorize-url";
        const url2 = new URL("/api/oauth/authorize", origin);
        url2.search = new URLSearchParams({
          client_id: c2.client_id,
          redirect_uri: redirect,
          response_type: "code",
          code_challenge_method: "S256",
          code_challenge: await challenge(verifier),
          scope: scopes,
          state: state2,
          label: input.label,
          ...c2.agent_id ? { connection: c2.agent_id } : {}
        }).toString();
        return Response.json({ url: url2.href }, { headers });
      }
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405, headers });
      const url = new URL(request.url), state = url.searchParams.get("state");
      if (!state || !/^[a-f0-9]{64}$/.test(state))
        return new Response("Invalid authorization state", {
          status: 400,
          headers
        });
      const c = await db("consume", { state_hash: await hash(state) });
      attempt = c.id;
      if (url.searchParams.has("error"))
        throw new Error(
          "May I authorization was declined or failed. Return to installation to try again."
        );
      const code = url.searchParams.get("code");
      if (!code) throw new Error("Missing authorization code");
      const grant = await post("/api/oauth/token", {
        grant_type: "authorization_code",
        code,
        code_verifier: c.verifier,
        client_id: c.client_id,
        redirect_uri: c.redirect_url
      });
      if (typeof grant.access_token !== "string" || !grant.access_token || typeof grant.refresh_token !== "string" || !grant.refresh_token || !Number.isSafeInteger(grant.expires_in) || grant.expires_in < 1 || typeof grant.agent_id !== "string" || !grant.agent_id)
        throw new Error(
          "May I did not return the required connection identity. Its reconnect update must be deployed before connecting."
        );
      if (c.agent_id && grant.agent_id !== c.agent_id)
        throw new Error(
          "May I returned a different connection. Existing approvals have not been reassigned."
        );
      await db("save", {
        id: c.id,
        access_token: grant.access_token,
        refresh_token: grant.refresh_token,
        expires_in: grant.expires_in,
        agent_id: grant.agent_id
      });
      return new Response(
        "May I connected. Close this tab and return to HARNESST installation.",
        { headers }
      );
    } catch (error) {
      if (attempt) await db("failed", { id: attempt }).catch(() => {
      });
      const message = error instanceof Error && (error.message.startsWith("May I ") || error.message.startsWith("Missing authorization")) ? error.message : "Authorization unavailable or expired. Return to installation and try again. If registration was interrupted, contact the installation administrator.";
      const diagnostic = error instanceof Error && /^Approval database operation failed \([0-9]{3}; [A-Z0-9a-z]+\)$/.test(
        error.message
      ) ? error.message : error instanceof Error ? error.name : "Error";
      return new Response(message, {
        status: 400,
        headers: {
          ...headers,
          "X-Installation-Error": `${phase}: ${diagnostic}`
        }
      });
    }
  };
}

// catalog/ledger/supabase/functions/_shared/runtime.ts
function env(name) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
}
async function rpc(name, operation, args = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_op: operation, p_args: args }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code = typeof body.code === "string" && /^[A-Z0-9]{5,10}$/.test(body.code) ? body.code : "unknown";
    throw new Error(
      `Approval database operation failed (${response.status}; ${code})`
    );
  }
  return response.json();
}

// catalog/ledger/supabase/functions/approval-oauth/index.ts
Deno.serve(
  oauthHandler(
    (operation, args) => rpc("ledger_oauth", operation, args),
    env("SUPABASE_URL"),
    env("LEDGER_SETUP_TOKEN")
  )
);
