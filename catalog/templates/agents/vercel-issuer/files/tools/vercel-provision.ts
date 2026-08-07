import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

// The privileged half of the Vercel flow (issue #364): create a project with the full-account
// token, mint a PROJECT-scoped token for it, and deposit that token into a teammate's container
// env through harnesst's deposit route. The minted bearer token exists only inside this function
// — it goes to the deposit route and is then discarded; it is never returned, logged, or included
// in an error. That is why minting happens here and not through the generic CLI wrapper (whose
// `vercel tokens add` would print the bearer token into model-visible output).
//
// `approval: always()` is hardcoded — this is the harness-enforced human gate on the trust root,
// not a configurable preference.

const VERCEL_API = "https://api.vercel.com";

interface VercelError {
  status: number;
  code: string;
  message: string;
}

async function vercelCall(
  master: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: VercelError }> {
  const teamId = process.env.VERCEL_TEAM_ID;
  // Project endpoints are team-scoped when a team id is configured; user-token minting is not.
  const scoped = teamId && !path.startsWith("/v3/user/tokens");
  const url = `${VERCEL_API}${path}${scoped ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${master}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      error: { status: 0, code: "network", message: String((error as Error).message ?? error) },
    };
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some DELETEs answer with an empty body; that is fine.
  }
  if (!res.ok) {
    const err = (payload.error ?? {}) as { code?: string; message?: string };
    return {
      ok: false,
      error: {
        status: res.status,
        code: err.code ?? String(res.status),
        message: err.message ?? `Vercel answered ${res.status}.`,
      },
    };
  }
  return { ok: true, data: payload };
}

export default defineTool({
  description:
    "Create a Vercel project and provision a project-scoped deploy token for a teammate. The token is deposited into the teammate's environment by the harness — it is never shown to anyone. Requires human approval on every call.",
  inputSchema: z.object({
    projectName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, ., _, -")
      .describe("Vercel project name to create (or adopt, if it already exists)."),
    targetMember: z
      .string()
      .min(1)
      .describe("Roster name of the teammate who should receive the project-scoped token."),
    framework: z
      .string()
      .min(1)
      .optional()
      .describe('Vercel framework preset, e.g. "nextjs". Omit to let Vercel detect it.'),
    gitRepository: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/, "owner/repo")
      .optional()
      .describe("GitHub repository (owner/repo) to link for push-to-deploy, if any."),
    tokenTtlDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(90)
      .describe("Days until the minted project token expires."),
    justification: z
      .string()
      .min(1)
      .max(500)
      .describe("Why this project and credential should exist — shown verbatim to the approving human."),
  }),
  approval: always(),
  async execute({ projectName, targetMember, framework, gitRepository, tokenTtlDays }) {
    const master = process.env.VERCEL_MASTER_TOKEN;
    if (!master) {
      return { ok: false, error: "VERCEL_MASTER_TOKEN is not configured for this agent." };
    }
    const depositUrl = process.env.HARNESST_SECRETS_DEPOSIT_URL;
    const teamToken = process.env.HARNESST_TEAM_TOKEN;
    if (!depositUrl || !teamToken) {
      return {
        ok: false,
        error:
          "Credential deposit is not configured for this deployment (missing deposit URL or team token) — redeploy after installing this agent from the marketplace.",
      };
    }

    // 1. Create the project — or adopt an existing one by the same name, so a retry after a
    //    partial failure converges instead of erroring.
    let projectId: string;
    let adopted = false;
    const created = await vercelCall(master, "POST", "/v11/projects", {
      name: projectName,
      ...(framework ? { framework } : {}),
      ...(gitRepository ? { gitRepository: { type: "github", repo: gitRepository } } : {}),
    });
    if (created.ok) {
      projectId = String(created.data.id);
    } else if (created.error.code === "conflict") {
      const existing = await vercelCall(master, "GET", `/v9/projects/${encodeURIComponent(projectName)}`);
      if (!existing.ok) {
        return {
          ok: false,
          error: `Project "${projectName}" already exists but could not be read: ${existing.error.message}`,
        };
      }
      projectId = String(existing.data.id);
      adopted = true;
    } else {
      return {
        ok: false,
        error: `Vercel refused to create project "${projectName}": ${created.error.message}`,
      };
    }

    // 2. Mint the project-scoped token. The bearer token in this response is the secret — it
    //    stays inside this function.
    const expiresAt = Date.now() + tokenTtlDays * 86_400_000;
    const minted = await vercelCall(master, "POST", "/v3/user/tokens", {
      name: `harnesst ${targetMember} ${projectName}`,
      projectId,
      expiresAt,
    });
    if (!minted.ok) {
      return {
        ok: false,
        projectId,
        error: `Project "${projectName}" exists (${projectId}) but token minting failed: ${minted.error.message}`,
      };
    }
    const bearerToken = String(minted.data.bearerToken ?? "");
    const tokenId = String(((minted.data.token ?? {}) as { id?: unknown }).id ?? "");
    if (!bearerToken) {
      return {
        ok: false,
        projectId,
        error: "Vercel's token response carried no bearer token; nothing was deposited.",
      };
    }

    // 3. Deposit into the teammate's env. On ANY failure, revoke the minted token — a credential
    //    that never reached its destination must not stay live — and never surface its value.
    //    Revocation itself can fail; report that honestly so the operator can revoke by hand.
    const revoke = async (): Promise<boolean> => {
      if (!tokenId) return false;
      const res = await vercelCall(master, "DELETE", `/v3/user/tokens/${encodeURIComponent(tokenId)}`);
      return res.ok;
    };
    let depositError: string | null = null;
    let delivery = "queued";
    try {
      const res = await fetch(depositUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${teamToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          member: targetMember,
          key: "VERCEL_TOKEN",
          value: bearerToken,
          sandboxExposed: false,
        }),
      });
      const outcome = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        delivery?: string;
      };
      if (!res.ok || outcome.ok !== true) {
        depositError = outcome.error ?? `deposit route answered ${res.status}`;
      } else if (typeof outcome.delivery === "string") {
        delivery = outcome.delivery;
      }
    } catch (error) {
      depositError = String((error as Error).message ?? error);
    }
    if (depositError) {
      const revoked = await revoke();
      return {
        ok: false,
        projectId,
        error: revoked
          ? `The token could not be delivered to "${targetMember}" (${depositError}); the minted token was revoked. Fix the delivery problem and provision again.`
          : `The token could not be delivered to "${targetMember}" (${depositError}), and revoking the minted token FAILED — a human must revoke token "${tokenId || "(unknown id)"}" in the Vercel dashboard before retrying.`,
      };
    }

    // 4. Best-effort convenience deposit — the project id is not a secret, and having it in env
    //    saves the teammate a discovery call.
    let note: string | undefined;
    try {
      const res = await fetch(depositUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${teamToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          member: targetMember,
          key: "VERCEL_PROJECT_ID",
          value: projectId,
          sandboxExposed: false,
        }),
      });
      const outcome = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || outcome.ok !== true) note = "VERCEL_PROJECT_ID could not be deposited (token delivery succeeded).";
    } catch {
      note = "VERCEL_PROJECT_ID could not be deposited (token delivery succeeded).";
    }

    // `delivery` is the route's verdict: "queued" (live member, redeploy pending) or "held"
    // (pending member — the token waits in escrow until the member ships). `adopted` flags that
    // an EXISTING same-name project was granted, not a fresh one — worth a human glance.
    return {
      ok: true,
      projectId,
      projectName,
      tokenExpiresAt: new Date(expiresAt).toISOString(),
      delivery,
      ...(adopted
        ? {
            adopted: true,
            note: [
              `An existing Vercel project named "${projectName}" was adopted rather than created — verify it is the intended app.`,
              ...(note ? [note] : []),
            ].join(" "),
          }
        : note
          ? { note }
          : {}),
    };
  },
});
