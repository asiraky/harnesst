/**
 * The workspace's agent-model configuration — the single source of truth a running agent's
 * generated `harnesst-model.ts` resolves against (`GET /api/gateway/v1/model-config`).
 *
 * Resolution is deliberately boring: an explicit per-agent override in `agent_model_overrides`
 * wins, else the workspace default (`workspace_settings.assistant_model`), else nothing — and
 * "nothing" is surfaced to the agent as a readable "configure a model in Org settings" error,
 * never a silent fallback. Subagents resolve with their parent agent's name, so a parent and
 * its subagents always agree without any per-file wiring.
 *
 * `pickAgentModel` is pure so the ordering contract unit-tests with zero I/O.
 */
import { and, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agentModelOverrides } from "~/db/schema";
import type { ReasoningEffort } from "~/models/reasoning";
import { getWorkspaceAssistantSelection } from "~/org/workspace.server";

export interface AgentModelSelection {
  /** Connection-qualified model ref, e.g. `anthropic/<connectionId>/<model>`. */
  model: string;
  effort: ReasoningEffort | null;
}

export interface AgentModelOverride extends AgentModelSelection {
  agentName: string;
}

export interface ResolvedAgentModel extends AgentModelSelection {
  /** Which layer answered: the agent's explicit override or the workspace default. */
  source: "override" | "workspace-default";
}

/** Override wins; the workspace default answers otherwise; null means nothing is configured. */
export function pickAgentModel(
  override: AgentModelSelection | null,
  workspaceDefault: { model: string | null; effort: ReasoningEffort | null },
): ResolvedAgentModel | null {
  if (override) return { ...override, source: "override" };
  if (workspaceDefault.model) {
    return {
      model: workspaceDefault.model,
      effort: workspaceDefault.effort,
      source: "workspace-default",
    };
  }
  return null;
}

export async function listAgentModelOverrides(
  orgId: string,
): Promise<AgentModelOverride[]> {
  const rows = await db
    .select({
      agentName: agentModelOverrides.agentName,
      model: agentModelOverrides.model,
      effort: agentModelOverrides.effort,
    })
    .from(agentModelOverrides)
    .where(eq(agentModelOverrides.orgId, orgId))
    .orderBy(agentModelOverrides.agentName);
  return rows.map((r) => ({
    agentName: r.agentName,
    model: r.model,
    effort: (r.effort as ReasoningEffort | null) ?? null,
  }));
}

export async function getAgentModelOverride(
  orgId: string,
  agentName: string,
): Promise<AgentModelSelection | null> {
  const [row] = await db
    .select({
      model: agentModelOverrides.model,
      effort: agentModelOverrides.effort,
    })
    .from(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.agentName, agentName),
      ),
    )
    .limit(1);
  return row
    ? { model: row.model, effort: (row.effort as ReasoningEffort | null) ?? null }
    : null;
}

export async function setAgentModelOverride(
  orgId: string,
  agentName: string,
  selection: AgentModelSelection,
): Promise<void> {
  await db
    .insert(agentModelOverrides)
    .values({
      orgId,
      agentName,
      model: selection.model,
      effort: selection.effort,
    })
    .onConflictDoUpdate({
      target: [agentModelOverrides.orgId, agentModelOverrides.agentName],
      set: {
        model: selection.model,
        effort: selection.effort,
        updatedAt: new Date(),
      },
    });
}

export async function removeAgentModelOverride(
  orgId: string,
  agentName: string,
): Promise<void> {
  await db
    .delete(agentModelOverrides)
    .where(
      and(
        eq(agentModelOverrides.orgId, orgId),
        eq(agentModelOverrides.agentName, agentName),
      ),
    );
}

/** The model the named agent should run right now, per the layering in the module doc. */
export async function resolveAgentModel(
  orgId: string,
  agentName: string,
): Promise<ResolvedAgentModel | null> {
  const [override, workspaceDefault] = await Promise.all([
    getAgentModelOverride(orgId, agentName),
    getWorkspaceAssistantSelection(orgId),
  ]);
  return pickAgentModel(override, workspaceDefault);
}
