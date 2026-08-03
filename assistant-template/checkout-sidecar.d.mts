/**
 * Type surface of the checkout sidecar's PURE export (checkout-sidecar.mjs) so harnesst's unit tests
 * can import its regression-testable helpers under typecheck. The sidecar itself runs inside the
 * assistant instance image; these exports are pure values and do not bind the HTTP server.
 */
export interface RawRecordInfo {
  path: string;
  status: "added" | "modified" | "deleted";
  executable?: boolean;
  notFile?: boolean;
}

export function classifyRawRecord(
  meta: string,
  path: string,
): RawRecordInfo | null;

export const EVAL_CONTAINER_SCRIPT: string;

export function classifyEvalEvidence(input: {
  exitCode: number | null;
  timedOut: boolean;
  runnerError?: string | null;
  summary: null | {
    failed?: number;
    scored?: number;
    skipped?: number;
    evals: Array<{
      verdict?: string;
      skipReason?: string;
    }>;
  };
}): {
  ok: boolean;
  outcome: string;
  error?: string;
};
