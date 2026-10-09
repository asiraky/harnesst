import { defineTool } from "eve/tools";
import { z } from "zod";
import { ledgerRpc } from "../lib/ledger.js";
export default defineTool({
  description:
    "Read your ledger actor identity, role and registered wake URL. Takes no item or version.",
  inputSchema: z.object({}),
  execute: (input, ctx) => ledgerRpc("whoami", input, ctx),
});
