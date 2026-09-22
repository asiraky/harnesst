import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Create a product project using an operator-approved workflow template. Intake only; policy changes require the SQL operator.",
  inputSchema: z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    repo: z.string().min(1),
    docs: z.record(z.string(), z.unknown()).optional(),
    workflow_template: z
      .string()
      .optional()
      .describe("Operator-approved template name; defaults to default."),
  }),
  execute: (input) => ledgerRpc("create_project", input),
});
