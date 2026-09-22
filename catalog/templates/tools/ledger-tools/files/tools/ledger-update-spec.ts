import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Revise a pre-code specification with a reason. Intake may edit unblocked work; infra may edit only its own stage. Saving resets work to triage and invalidates spec-bound gates.",
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
  execute: (input) => ledgerRpc("update_spec", input),
});
