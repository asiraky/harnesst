import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "Read one run step by step: the evidence for debugging a run or a usage warning. Read-only. " +
    "Pass the run id or the pasted /usage/repos/<repo>/runs/<runId> link. Returns the run " +
    "(status, error), a summary (peak and median context against the window, the tool-result " +
    "limit, compactions, withheld results, tool errors), the five largest tool results with " +
    "their input, repeated identical calls, subagent child runs, and a page of steps in order: " +
    "model calls (context tokens and window, status), tool calls (tool, input excerpt, result " +
    "tokens, error, withheld flag, child run id) and compactions (the context size that " +
    'triggered them). Pass only: "problems" to see just compactions, errors, withheld and large ' +
    "results. Pages: when truncated is true, call again with offset set to nextOffset. To read " +
    "one tool step's full stored input and output, pass step (its seq); long output comes in " +
    "chunks, so call again with chunkOffset set to nextChunkOffset until it is null.",
  inputSchema: z.object({
    run: z.string().min(1).describe("Run id, or a pasted run link (absolute or relative)."),
    only: z
      .enum(["all", "problems"])
      .optional()
      .describe('"problems": only compactions, errors, withheld and large results.'),
    offset: z.number().int().min(0).optional().describe("nextOffset from the previous page."),
    limit: z.number().int().min(1).max(200).optional().describe("Steps per page, default 80."),
    step: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("A tool step's seq: return that step's full input and output instead of the trace."),
    chunkOffset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("With step: nextChunkOffset from the previous chunk."),
  }),
  async execute(input) {
    return harnesstCall("run-trace", input);
  },
});
