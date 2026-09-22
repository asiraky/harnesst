import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Ledger block. Read the item and use its current version and binding before mutations.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    role: z.string(),
    question: z.string().min(1),
    options: z.array(z.string()).optional(),
  }),
  execute: (input) => ledgerRpc("block", input),
});
