import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Block an item on a question only a human can answer. The ledger wakes intake, which sends the human the one message about it and records their answer; do not also send notify-user about the block. " +
    "The question is what the human reads, so make it self-contained: what you need, where, and why. " +
    "Read the item and use its current version and binding before mutations.",
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
    question: z
      .string()
      .min(1)
      .describe(
        "Everything the human needs to act: the ask, links, and what you already checked.",
      ),
    options: z.array(z.string()).optional(),
  }),
  execute: (input, ctx) => ledgerRpc("block", input, ctx),
});
