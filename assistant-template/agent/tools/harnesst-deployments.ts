import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "List this repository's deployments: id, agent, environment, status (live, draining, " +
    "stopped, failed, ...), version, commit, created time and any deploy error. Live and " +
    "draining come first. Read-only. Pass logs with a deployment id to also get the tail of that " +
    "deployment's container logs (lines, default 100, at most 300), with secrets removed. Use " +
    "the logs when a run failed without a clear error in harnesst_run_trace, or a deploy failed. " +
    "A run's deploymentId (from harnesst_runs) says which deployment it ran on.",
  inputSchema: z.object({
    logs: z.string().optional().describe("A deployment id from this list: include its log tail."),
    lines: z.number().int().min(1).max(300).optional().describe("Log lines, default 100."),
  }),
  async execute(input) {
    return harnesstCall("deployments", input);
  },
});
