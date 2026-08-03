/** Credential-safe behavioral eval runner for the built-in project assistant. */
import path from "node:path";

import { and, eq } from "drizzle-orm";

import type { AssistantContext } from "~/assistant/authoring.server";
import { mintAssistantToken } from "~/assistant/token.server";
import { db } from "~/db/client.server";
import { playgroundSessions } from "~/db/schema";
import type { Agent } from "~/data/ports";
import {
  createEvalGrant,
  EvalGrantError,
  revokeEvalGrant,
} from "~/gateway/eval-grant.server";
import { mintEvalGatewayToken } from "~/gateway/eval-token.server";
import { gatewayBaseUrl } from "~/gateway/url.server";
import { resolveAgentModel } from "~/models/agent-model-config.server";
import { parseProviderModelReference } from "~/models/provider-reference";
import { getRuntime } from "~/seams/index.server";

const EVAL_RUN_TIMEOUT_MS = 8 * 60_000;

type EvalResult = Record<string, unknown> & {
  ok: boolean;
  error?: string;
};

export interface EvalRunnerDeps {
  authorizeConversation(input: {
    conversationId: string;
    projectId: string;
    assistantAgentId: string;
    environmentId: string;
  }): Promise<boolean>;
  listAgents(projectId: string): Promise<Agent[]>;
  resolveModel: typeof resolveAgentModel;
  createGrant: typeof createEvalGrant;
  revokeGrant: typeof revokeEvalGrant;
  auxEndpoint(deploymentId: string): Promise<string | null>;
  fetch: typeof fetch;
  gatewayUrl(): string;
  assistantToken(deploymentId: string): string;
  evalToken(grantId: string): string;
}

function defaultDeps(): EvalRunnerDeps {
  return {
    authorizeConversation: async (input) => {
      const [row] = await db
        .select({ id: playgroundSessions.id })
        .from(playgroundSessions)
        .where(
          and(
            eq(playgroundSessions.id, input.conversationId),
            eq(playgroundSessions.projectId, input.projectId),
            eq(playgroundSessions.agentId, input.assistantAgentId),
            eq(playgroundSessions.environmentId, input.environmentId),
            eq(playgroundSessions.surface, "assistant"),
            eq(playgroundSessions.status, "running"),
          ),
        )
        .limit(1);
      return Boolean(row);
    },
    resolveModel: resolveAgentModel,
    listAgents: (projectId) =>
      getRuntime().data.agents.listByProject(projectId),
    createGrant: createEvalGrant,
    revokeGrant: revokeEvalGrant,
    auxEndpoint: async (deploymentId) =>
      (await getRuntime().deployTarget.auxEndpoint?.(deploymentId)) ?? null,
    fetch,
    gatewayUrl: gatewayBaseUrl,
    assistantToken: mintAssistantToken,
    evalToken: mintEvalGatewayToken,
  };
}

/**
 * Run the checkout's real `eve eval` suite through the assistant sidecar. The sidecar is the only
 * process that can see the conversation checkout outside the sealed bash sandbox; it launches a
 * disposable child with an explicit environment containing only the scoped gateway coordinates.
 */
export async function runAssistantEval(
  ctx: AssistantContext,
  input: { conversationId?: unknown; member?: unknown },
  deps: EvalRunnerDeps = defaultDeps(),
): Promise<EvalResult> {
  const conversationId =
    typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  const memberName =
    typeof input.member === "string" ? input.member.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) {
    return {
      ok: false,
      error:
        "Pass the conversation id from the checkout path in the current harnesst system note.",
    };
  }
  if (!memberName) {
    return {
      ok: false,
      error:
        "Pass the target member name returned by harnesst_project_context (including for a single-agent project).",
    };
  }

  const authorized = await deps.authorizeConversation({
    conversationId,
    projectId: ctx.project.id,
    assistantAgentId: ctx.agentId,
    environmentId: ctx.environmentId,
  });
  if (!authorized) {
    return {
      ok: false,
      error:
        "That checkout is not the active assistant conversation for this deployment and project.",
    };
  }

  const members = (await deps.listAgents(ctx.project.id)).filter(
    (agent) => agent.kind === "member",
  );
  const member = members.find((agent) => agent.name === memberName);
  if (!member) {
    return {
      ok: false,
      error: `Member "${memberName}" was not found in this project. Call harnesst_project_context and use an exact member name.`,
    };
  }
  const packageRoot = packageRootFor(member.root);
  if (packageRoot === null) {
    return {
      ok: false,
      error: `Member "${memberName}" has an unsupported repository root (${member.root}).`,
    };
  }

  const selection = await deps.resolveModel(ctx.project.orgId, member.name);
  if (!selection) {
    return {
      ok: false,
      error: `No model is configured for "${member.name}". Set a workspace default or per-agent model in Org settings, then retry.`,
    };
  }
  const parsed = parseProviderModelReference(selection.model);
  if (!parsed || parsed.provider !== "codex") {
    const provider = parsed?.provider ?? "the configured direct provider";
    return {
      ok: false,
      error:
        `Behavioral evals for ${provider} models are not yet available through the credential-safe broker. ` +
        "Choose a connected Codex model for this member, or run the eval in a trusted environment that already owns the provider credential. Raw API keys are never injected into assistant checkouts.",
    };
  }

  const aux = await deps.auxEndpoint(ctx.deploymentId).catch(() => null);
  if (!aux) {
    return {
      ok: false,
      error:
        "This assistant deployment does not expose the credential-safe eval runner. Reprovision the assistant instance, then retry.",
    };
  }

  let grant: Awaited<ReturnType<typeof createEvalGrant>>;
  try {
    grant = await deps.createGrant({
      orgId: ctx.project.orgId,
      projectId: ctx.project.id,
      conversationId,
      memberName: member.name,
      selection,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof EvalGrantError
          ? error.message
          : `Could not authorize the eval: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let result: EvalResult;
  let cleanup: "revoked" | "expires" = "revoked";
  try {
    const response = await deps.fetch(`${aux}/eval`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harnesst-sidecar-token": deps.assistantToken(ctx.deploymentId),
      },
      body: JSON.stringify({
        conversationId,
        packageRoot,
        gatewayUrl: deps.gatewayUrl(),
        gatewayToken: deps.evalToken(grant.id),
        timeoutMs: EVAL_RUN_TIMEOUT_MS,
      }),
      signal: AbortSignal.timeout(EVAL_RUN_TIMEOUT_MS + 30_000),
    });
    if (!response.ok) {
      const errorBody = (await response
        .json()
        .catch(() => null)) as EvalResult | null;
      result = {
        ok: false,
        error:
          errorBody?.error ??
          `The eval runner returned HTTP ${response.status} without structured evidence.`,
      };
    } else {
      const body = (await response
        .json()
        .catch(() => null)) as EvalResult | null;
      result = body ?? {
        ok: false,
        error: "The eval runner returned an empty response.",
      };
    }
  } catch (error) {
    result = {
      ok: false,
      error: `The eval runner failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      await deps.revokeGrant(grant.id);
    } catch {
      // The signed grant still has a hard expiry. Report the degraded cleanup instead of hiding it.
      cleanup = "expires";
    }
  }

  return {
    ...result,
    member: member.name,
    memberRoot: member.root,
    model: {
      id: selection.model,
      effort: selection.effort,
      source: selection.source,
    },
    authorization: {
      projectId: ctx.project.id,
      conversationId,
      expiresAt: grant.expiresAt.toISOString(),
      maxConcurrentCalls: grant.maxConcurrentCalls,
      maxCalls: grant.maxCalls,
      maxTokens: grant.maxTokens,
      cleanup,
    },
  };
}

/** Translate an agent root to the directory containing package.json/evals without traversal. */
export function packageRootFor(agentRoot: string): string | null {
  const normalized = path.posix.normalize(agentRoot);
  if (
    normalized !== agentRoot ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    return null;
  }
  if (normalized === "agent") return ".";
  const match = normalized.match(/^agents\/([A-Za-z0-9_-]+)\/agent$/);
  return match ? `agents/${match[1]}` : null;
}
