import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Revise a pre-code specification with a reason. Intake may edit unblocked work; infra and architect may edit only during their own stage. An edit by the current stage owner keeps the item in its stage; any other edit restarts it at triage.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    spec: z.record(z.string(), z.unknown()),
    note: z.string().min(1),
  }),
  execute: (input, ctx) => ledgerRpc("update_spec", input, ctx),
});
