import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Read one project’s repository, conventions and active workflow. Use project_id from ledger-list-projects before code work.",
  inputSchema: z.object({
    project_id: z.string().uuid(),
  }),
  execute: (input, ctx) => ledgerRpc("get_project", input, ctx),
});
