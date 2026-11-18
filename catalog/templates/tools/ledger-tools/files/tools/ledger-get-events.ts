import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Read an item's events with full payloads. ledger-get-item shows only recent events with long text cut; use this for the full text of an event (before_seq = its seq + 1, limit 1) or older history. " +
    "Newest first unless only since_seq is given; at most 20 per call; has_more means there are more. Spec copies in spec_updated events are left out unless include_spec is true (then one event per call).",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    kinds: z
      .array(z.string())
      .optional()
      .describe("Only these event kinds, e.g. blocked, resolved, evidence."),
    since_seq: z
      .number()
      .int()
      .optional()
      .describe("Only events after this seq (pages forward, oldest first)."),
    before_seq: z
      .number()
      .int()
      .optional()
      .describe("Only events before this seq (pages back from it)."),
    limit: z.number().int().min(1).max(20).optional(),
    include_spec: z.boolean().optional(),
  }),
  execute: (input, ctx) => ledgerRpc("get_events", input, ctx),
});
