import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "List the team’s product projects so intake can identify which repository a request belongs to.",
  inputSchema: z.object({}),
  execute: (input) => ledgerRpc("list_projects", input),
});
