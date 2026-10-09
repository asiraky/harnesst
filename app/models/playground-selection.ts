/**
 * Parse a chat send's model/effort form fields (the FOH stream route) into a validated selection.
 *
 * Effort only means anything attached to a model selection — the signed directive embeds it
 * next to the model id, and a deployed fallback already carries its own effort. An effort sent
 * without a model (older clients echo the agent's default effort) is therefore dropped, not
 * rejected: rejecting it broke every send from a conversation whose agent had a saved effort.
 */
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";

export type RequestedModelSelection =
  | {
      ok: true;
      modelId: string | null;
      effort: ReasoningEffort | null;
    }
  | { ok: false; error: string };

export function parseRequestedModelSelection(input: {
  modelId: string;
  effort: string;
}): RequestedModelSelection {
  const modelId = input.modelId.trim() || null;
  const effortRaw = modelId ? input.effort.trim() : "";
  if (!effortRaw) return { ok: true, modelId, effort: null };
  if (!isReasoningEffort(effortRaw)) {
    return { ok: false, error: "That reasoning effort is not valid." };
  }
  return { ok: true, modelId, effort: effortRaw };
}
