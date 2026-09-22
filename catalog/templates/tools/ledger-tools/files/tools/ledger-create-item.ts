import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Create work in a specific project. Intake only; project_id is required. Plan approval creates child items.",
  inputSchema: z.object({
    project_id: z.string().uuid(),
    kind: z.enum(["plan", "feature", "infra", "bug"]),
    title: z.string().min(1),
    spec: z.record(z.string(), z.unknown()),
  }),
  execute: (input) => ledgerRpc("create_item", input),
});
