import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "List recent runs of this repository's agents, newest first, to find the run behind a " +
    "problem. Read-only. Each run has: id, agent, channel, status, an error excerpt, start and " +
    "finish times, peak context tokens and the context window, compactions, model and tool call " +
    "counts, tool errors, the deployment id it ran on, and its usage link. Filter by status " +
    '("failed" to find errors), agent name, and since (an ISO time or "24h" / "7d"; default ' +
    "7 days). Pages: when truncated is true, call again with offset set to nextOffset. Then open " +
    "one run with harnesst_run_trace.",
  inputSchema: z.object({
    status: z
      .enum(["running", "completed", "failed"])
      .optional()
      .describe("Only runs with this status."),
    agent: z.string().optional().describe("Only this agent's runs (its name)."),
    since: z
      .string()
      .optional()
      .describe('How far back: an ISO time, or "24h" / "7d". Default 7d, at most 90d.'),
    limit: z.number().int().min(1).max(100).optional().describe("Runs per page, default 20."),
    offset: z.number().int().min(0).optional().describe("nextOffset from the previous page."),
  }),
  async execute(input) {
    return harnesstCall("runs", input);
  },
});
