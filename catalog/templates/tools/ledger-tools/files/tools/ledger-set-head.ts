import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Record the full PR head SHA and its observation time. Use the latest item version; older observations are ignored, future timestamps refused, and changed downstream heads reset QA.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    observed_at: z.string().datetime(),
  }),
  execute: (input, ctx) => ledgerRpc("set_head", input, ctx),
});
