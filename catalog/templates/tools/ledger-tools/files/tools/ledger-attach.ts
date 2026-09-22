import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Attach an existing branch, PR, preview URL or deployment. Use the latest item version. Preview/deployment binding must be the current head SHA; a second branch or PR is refused.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    type: z.enum(["branch", "pr", "preview_url", "deployment"]),
    value: z.string().min(1),
    binding: z.string().optional(),
  }),
  execute: (input) => ledgerRpc("attach", input),
});
