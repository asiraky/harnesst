import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Close a ledger wake. After notifying a human about a terminal item, gate, block or escalation, acknowledge that notification wake. " +
    "An ordinary work wake completes when the item changes stage, with one exception: when you own the stage and have asked a human for something you cannot continue without (an engineer to reply in a design conversation), pass `awaiting` so the ledger stops waking you and records who you are waiting on. " +
    "On a later wake, an `awaiting_human` event after the item's latest stage change means you have already asked: do not ask again.",
  inputSchema: z.object({
    outbox_id: z.string().uuid(),
    note: z.string().min(1),
    awaiting: z
      .object({
        role: z.string().min(1).describe("The workflow role you are waiting on, e.g. engineer."),
        request: z
          .string()
          .min(1)
          .describe(
            "What that person must do, in one sentence, naming where: e.g. Reply to the \"Engineer needed: Boat Inspector design\" conversation to start the design session.",
          ),
      })
      .optional(),
  }),
  execute: (input, ctx) => ledgerRpc("complete_wake", input, ctx),
});
