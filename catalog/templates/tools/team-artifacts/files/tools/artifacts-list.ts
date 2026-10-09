import { defineTool } from "eve/tools";
import { z } from "zod";

import { callTeamArtifacts } from "../lib/team-artifacts.js";

export default defineTool({
  description:
    "List the artifacts any agent in this repository has published — pages, prototypes, images, charts, documents and files — newest first, with each one's id, name, title, kind, publishing agent and last published time. Pass query to narrow by name, title or agent. Fetch one with artifacts-get.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe(
        "Optional text matched against name, title and publishing agent, e.g. landing or proto.",
      ),
  }),
  async execute({ query }) {
    return callTeamArtifacts({ op: "list", ...(query ? { query } : {}) });
  },
});
