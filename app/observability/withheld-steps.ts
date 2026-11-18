/**
 * Marks run steps whose tool result the model gateway withheld for size
 * (app/gateway/tool-result-limit.ts). eve records those calls as successes with their full
 * output; the model saw an error instead, so the step is stored as an error with `data.withheld`,
 * which the transcript and the usage views read.
 */

export interface WithheldMark {
  tokens: number;
  limitTokens: number;
}

interface StepLike {
  type: string;
  callId?: string | null;
  isError?: boolean;
  data?: Record<string, unknown> | null;
}

/** The tool call ids of a run's steps, for looking up withheld results. */
export function toolCallIds(steps: StepLike[]): string[] {
  const ids = new Set<string>();
  for (const step of steps) if (step.type === "tool_call" && step.callId) ids.add(step.callId);
  return [...ids];
}

export function markWithheldSteps<S extends StepLike>(
  steps: S[],
  withheld: ReadonlyMap<string, WithheldMark>,
): S[] {
  if (withheld.size === 0) return steps;
  return steps.map((step) => {
    const mark = step.type === "tool_call" && step.callId ? withheld.get(step.callId) : undefined;
    if (!mark) return step;
    return {
      ...step,
      isError: true,
      data: { ...step.data, withheld: { tokens: mark.tokens, limitTokens: mark.limitTokens } },
    };
  });
}
