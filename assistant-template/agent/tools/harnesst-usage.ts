import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "Summarise this repository's usage over a window, per agent: runs, failed runs, model calls, " +
    "input, cached and output tokens, peak context, compactions, withheld (too large) tool " +
    "results, and the tools whose results fed the most tokens back into the context. Also " +
    "returns the current usage warnings for this repository (severity, title, summary, " +
    "suggested fix, worst run id). Read-only. Use it to see which agent and tool is costly or " +
    "failing before opening runs with harnesst_runs and harnesst_run_trace.",
  inputSchema: z.object({
    agent: z.string().optional().describe("Only this agent (its name)."),
    since: z
      .string()
      .optional()
      .describe('How far back: an ISO time, or "24h" / "7d". Default 7d, at most 90d.'),
  }),
  async execute(input) {
    return harnesstCall("usage", input);
  },
});
