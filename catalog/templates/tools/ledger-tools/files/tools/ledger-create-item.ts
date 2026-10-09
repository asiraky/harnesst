import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Create work in a specific project. Intake only; project_id is required. A ticket is a sub-issue of a feature or bug in breakdown: pass parent_id, and blocked_by with the ids of sibling tickets that must merge first. GitHub closes a ticket when its PR merges into the parent issue branch.",
  inputSchema: z.object({
    project_id: z.string().uuid(),
    kind: z.enum(["feature", "bug", "infra", "ticket"]),
    title: z.string().min(1),
    spec: z
      .record(z.string(), z.unknown())
      .describe(
        "Put the markdown document in body; open_questions (array) keeps a feature or bug in triage.",
      ),
    parent_id: z.string().uuid().optional(),
    blocked_by: z.array(z.string().uuid()).optional(),
  }),
  execute: (input, ctx) => ledgerRpc("create_item", input, ctx),
});
