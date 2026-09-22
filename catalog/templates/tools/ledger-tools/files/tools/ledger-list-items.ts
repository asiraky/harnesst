import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "List work summaries, optionally filtered by project, stage or mine=true for your owned stages and proxy notifications. Read an item in full before acting.",
  inputSchema: z.object({
    project_id: z.string().uuid().optional(),
    stage: z.string().optional(),
    mine: z.boolean().optional(),
  }),
  execute: (input) => ledgerRpc("list_items", input),
});
