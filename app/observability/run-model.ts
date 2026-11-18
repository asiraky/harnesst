/**
 * Which model a recorded run's model calls ran on (issue #417). Pure; the lookups it needs live in
 * `./run-model.server`.
 *
 * eve's stream names no model per step. A dynamic agent reports `dynamic:<build-time fallback>`
 * (`harnesst/unconfigured` for generated modules) and resolves the real model per step: from the
 * conversation's directive when one was sent, else from harnesst's model configuration. So the
 * fallback id is never written: a `fallback` turn takes the model harnesst's configuration picks
 * for that agent (resolved when the run is recorded), or null when nothing resolves.
 */
import type { TurnModelSource } from "~/models/model-directive";

export interface RunModel {
  modelId: string | null;
  contextWindowTokens: number | null;
}

export interface TurnModelFacts {
  modelId?: string | null;
  modelSource?: TurnModelSource | null;
  contextWindowTokens?: number | null;
}

/** True when the turn's own model id is only the build-time fallback. */
export function needsConfiguredModel(turn: TurnModelFacts): boolean {
  return turn.modelSource === "fallback";
}

/**
 * The model and context window to record. `configured` is harnesst's configured model for the
 * agent, looked up only for a `fallback` turn. `catalogWindow` is the catalog's context window for
 * the chosen model, used when nothing more specific (the directive's `ctx=`) gave one.
 */
export function chooseRunModel(
  turn: TurnModelFacts,
  configured: { model: string; contextWindowTokens: number | null } | null,
  catalogWindow: number | null = null,
): RunModel {
  if (needsConfiguredModel(turn)) {
    if (!configured) return { modelId: null, contextWindowTokens: null };
    return {
      modelId: configured.model,
      contextWindowTokens: configured.contextWindowTokens ?? catalogWindow,
    };
  }
  const modelId = turn.modelId ?? null;
  return {
    modelId,
    contextWindowTokens: modelId
      ? (turn.contextWindowTokens ?? catalogWindow)
      : null,
  };
}
