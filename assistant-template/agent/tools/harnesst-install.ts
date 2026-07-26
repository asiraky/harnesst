import { defineTool } from "eve/tools";
import { z } from "zod";

import { harnesstCall } from "../lib/harnesstApi";

const templateType = z.enum([
  "tool",
  "skill",
  "subagent",
  "channel",
  "connection",
  "bundle",
  "agent",
]);

export default defineTool({
  description:
    "Install a harnesst marketplace template into the connected project through harnesst's real " +
    "installer. Always browse with harnesst_catalog first, then use this tool instead of copying " +
    "template files. It composes bundles/includes, stages the template and harnesst-lock.json, " +
    "merges dependencies and sandbox bootstrap setup, provisions supplied or shared secrets, " +
    "and snapshots auth/capability selections. Conflicts stage nothing. For an agent template, " +
    "member is the new team-member name; otherwise it is an existing member name. secretValues " +
    "are write-only and are never returned. The result's secrets.required lists only secrets the " +
    "human must supply; secrets.provisioned are set or minted by harnesst automatically — never ask " +
    "the user for those. This stages a pending change-set reviewed on harnesst's Deployment tab: the " +
    "installed files will NOT appear in your git checkout until the human publishes and merges " +
    "it, so their absence right after a successful install is expected — do not re-create them by " +
    "hand or treat the absence as a failed install.",
  inputSchema: z.object({
    type: templateType,
    id: z.string().describe("The template id returned by harnesst_catalog."),
    member: z
      .string()
      .describe(
        "Existing target member, or the new name for an agent template.",
      ),
    authSelections: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        "OAuth provider id to selected scope-group ids. Omit to use defaults.",
      ),
    capabilitySelections: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe(
        "Capability provider id to selected operation-group ids. Omit for defaults.",
      ),
    secretValues: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Optional manifest secret values for secrets the user must supply. Existing shared secrets attach automatically when no value is supplied; other omitted user secrets remain required for later setup. Do NOT pass provisioned/generated secrets — harnesst sets those itself.",
      ),
  }),
  async execute(input) {
    return harnesstCall("install", input);
  },
});
