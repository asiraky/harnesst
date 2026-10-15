import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "After notifying a human about a terminal item, gate, block or escalation, acknowledge that notification wake. Ordinary work wakes complete when the item changes stage.",
  inputSchema: z.object({
    outbox_id: z.string().uuid(),
    note: z.string().min(1),
  }),
  execute: (input, ctx) => ledgerRpc("complete_wake", input, ctx),
});
