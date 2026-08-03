import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "Run the target member's complete Eve eval suite against the unpublished files in this " +
    "assistant conversation checkout. This is the supported credential-safe behavioral validation " +
    "path: harnesst starts a disposable local target and brokers its configured model without " +
    "putting reusable provider credentials in bash or repo code. Pass the exact member from " +
    "harnesst_project_context and the conversation id shown in the current checkout path. Returns " +
    "stdout/stderr, exit status, checkout identity, exact model identity, limits, and cleanup state.",
  inputSchema: z.object({
    member: z
      .string()
      .min(1)
      .describe("Exact target member name from harnesst_project_context."),
    conversationId: z
      .string()
      .min(1)
      .describe(
        "Current conversation id: the final segment of /workspace/home/checkouts/<conversationId> in the harnesst system note.",
      ),
  }),
  async execute(input) {
    return harnesstCall("run-eval", input, 9 * 60_000);
  },
});
