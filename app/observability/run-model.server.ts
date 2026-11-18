/**
 * Resolve the model a recorded run ran on (issue #417): the lookups behind `./run-model`.
 *
 * A `fallback` turn is resolved with the same chain the agent's generated model module asks
 * `/model-config` for: the project's org, the agent's name and the subagent's path. Two limits,
 * both because the stream does not say which model served a step:
 *   - it is resolved when the run is recorded, so a configuration change between the step and
 *     the record shows the new model;
 *   - the agent name is the roster name, which is what the module passes unless the agent was
 *     renamed after its `agent.ts` was generated; a subagent's path is its own name, which is
 *     exact for subagents declared directly under the agent.
 * Best-effort: any failure records no model rather than failing the run record.
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { agents, projects, releases } from "~/db/schema";
import { resolveTargetModel } from "~/models/agent-model-config.server";
import { findWorkspaceModel } from "~/models/union.server";
import {
  chooseRunModel,
  needsConfiguredModel,
  type RunModel,
  type TurnModelFacts,
} from "./run-model";

async function orgOf(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.orgId ?? null;
}

async function rosterAgentName(releaseId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: agents.name })
    .from(releases)
    .innerJoin(agents, eq(agents.id, releases.agentId))
    .where(eq(releases.id, releaseId))
    .limit(1);
  return row?.name ?? null;
}

async function catalogWindow(
  orgId: string,
  model: string,
): Promise<number | null> {
  try {
    return (await findWorkspaceModel(orgId, model))?.contextWindow ?? null;
  } catch {
    return null;
  }
}

export async function resolveRunModel(input: {
  projectId: string;
  releaseId: string;
  turn: TurnModelFacts;
  subagentName?: string | null;
}): Promise<RunModel> {
  const { turn } = input;
  try {
    const orgId = await orgOf(input.projectId);
    if (!orgId) return chooseRunModel(turn, null);
    let configured: { model: string; contextWindowTokens: number | null } | null =
      null;
    if (needsConfiguredModel(turn)) {
      const agentName = await rosterAgentName(input.releaseId);
      const resolved = agentName
        ? await resolveTargetModel(orgId, {
            agentName,
            subagentPath: input.subagentName ?? "",
            projectId: input.projectId,
          })
        : null;
      configured = resolved
        ? { model: resolved.model, contextWindowTokens: null }
        : null;
    }
    const chosen = chooseRunModel(turn, configured);
    if (chosen.modelId && chosen.contextWindowTokens === null) {
      return chooseRunModel(
        turn,
        configured,
        await catalogWindow(orgId, chosen.modelId),
      );
    }
    return chosen;
  } catch (error) {
    console.warn("[runs] could not resolve the run's model", error);
    return chooseRunModel(turn, null);
  }
}
