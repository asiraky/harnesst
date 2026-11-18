import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Read current work, recent events (long text cut; ledger-get-events has full payloads and older history), artifacts, approval status, leases and allowed_actions for your role. Read before acting.",
  inputSchema: z.object({
    item_id: z.string().uuid(),
  }),
  execute: (input, ctx) => ledgerRpc("get_item", input, ctx),
});
