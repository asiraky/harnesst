import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Claim an outbox row with your wake bearer. The wake channel already does this; use only for manual recovery. already_claimed or gone means do not start work.",
  inputSchema: z.object({
    outbox_id: z.string().uuid(),
  }),
  execute: (input, ctx) => ledgerRpc("claim", input, ctx),
});
