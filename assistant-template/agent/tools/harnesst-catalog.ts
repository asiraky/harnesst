import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

export default defineTool({
  description:
    "Browse harnesst's marketplace catalog and inspect a template before installing it with " +
    'harnesst_install. op "index" returns the browse index (all templates: id, type, name, ' +
    'description); op "template" returns one template\'s manifest + every file body (pass its ' +
    "type and id). Never hand-copy these files to install a marketplace capability: copying " +
    "skips harnesst-lock.json, composition, dependency and secret handling, and sandbox bootstrap.",
  inputSchema: z.object({
    op: z.enum(["index", "template"]),
    type: z
      .enum([
        "tool",
        "skill",
        "subagent",
        "channel",
        "connection",
        "bundle",
        "agent",
      ])
      .optional()
      .describe('Required for op "template".'),
    id: z.string().optional().describe('Required for op "template".'),
  }),
  async execute({ op, type, id }) {
    return harnesstCall("catalog", { op, type, id });
  },
});
