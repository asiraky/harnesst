import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Record actual QA, review or infrastructure findings for the current head SHA or spec version. Record failures honestly.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
    expected_version: z
      .number()
      .int()
      .positive()
      .describe(
        "Version returned by your latest item read; re-read after stale errors.",
      ),
    type: z.string(),
    binding: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
  execute: (input, ctx) => ledgerRpc("evidence", input, ctx),
});
