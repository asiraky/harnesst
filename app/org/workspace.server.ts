/** Workspace-level default-model settings. Provider credentials live on provider connections. */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { workspaceSettings } from "~/db/schema";
import type { ReasoningEffort } from "~/models/reasoning";

export interface WorkspaceAssistantSelection {
  model: string | null;
  effort: ReasoningEffort | null;
}

/** Set the workspace's complete model selection. Effort is meaningful only with a model. */
export async function setWorkspaceAssistantSelection(
  orgId: string,
  selection: WorkspaceAssistantSelection,
): Promise<void> {
  const effort = selection.model ? selection.effort : null;
  await db.transaction(async (tx) => {
    await tx
      .insert(workspaceSettings)
      .values({
        orgId,
        assistantModel: selection.model,
        assistantEffort: effort,
      })
      .onConflictDoUpdate({
        target: workspaceSettings.orgId,
        set: {
          assistantModel: selection.model,
          assistantEffort: effort,
          updatedAt: new Date(),
        },
      });

    // Explicit pins remain pins even when they happen to equal the new default.
  });
}

/** Set (or clear, with null) the connection-qualified workspace default model id. */
export async function setWorkspaceAssistantModel(
  orgId: string,
  model: string | null,
): Promise<void> {
  const current = await getWorkspaceAssistantSelection(orgId);
  await setWorkspaceAssistantSelection(orgId, {
    model,
    effort: model ? current.effort : null,
  });
}

/** Get the workspace model and its optional explicit reasoning effort. */
export async function getWorkspaceAssistantSelection(
  orgId: string,
): Promise<WorkspaceAssistantSelection> {
  const [row] = await db
    .select({
      model: workspaceSettings.assistantModel,
      effort: workspaceSettings.assistantEffort,
    })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.orgId, orgId))
    .limit(1);
  return {
    model: row?.model ?? null,
    effort: (row?.effort as ReasoningEffort | null | undefined) ?? null,
  };
}

/** The org's configured connection-qualified default model id, or null when none is configured. */
export async function getWorkspaceAssistantModel(
  orgId: string,
): Promise<string | null> {
  return (await getWorkspaceAssistantSelection(orgId)).model;
}
