import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Move work to an allowed stage. The database refuses missing evidence, gates, blocks, stale versions and unauthorized moves.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    to_stage: z.string(),
    binding: z
      .string()
      .optional()
      .describe("Current head SHA, required for GitHub system transitions."),
    note: z.string().optional(),
  }),
  execute: (input, ctx) => ledgerRpc("transition", input, ctx),
});
