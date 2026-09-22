import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Record the named human’s answer and wake the stage owner. Only that role or the intake proxy may resolve the block; pass the latest item version.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    answer: z.string().min(1),
  }),
  execute: (input) => ledgerRpc("resolve_block", input),
});
