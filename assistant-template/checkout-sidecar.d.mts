/**
 * Type surface of the checkout sidecar's PURE export (checkout-sidecar.mjs) so harnesst's unit tests
 * can import it under typecheck. The sidecar itself runs inside the assistant instance image; only
 * `classifyRawRecord` is meant for import — everything else is process-level.
 */
export interface RawRecordInfo {
  path: string;
  status: "added" | "modified" | "deleted";
  executable?: boolean;
  notFile?: boolean;
}

export function classifyRawRecord(meta: string, path: string): RawRecordInfo | null;
