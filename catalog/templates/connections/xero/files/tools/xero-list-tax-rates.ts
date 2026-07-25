import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. EDEN_API_URL and EDEN_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side and performs the one whitelisted operation.
export default defineTool({
  description:
    "List the Xero organisation's tax rates (name, tax type code, effective rate). Use the tax type codes on draft bill lines.",
  inputSchema: z.object({}),
  async execute() {
    const base = process.env.EDEN_API_URL;
    const token = process.env.EDEN_TEAM_TOKEN;
    if (!base || !token) {
      return {
        ok: false,
        error:
          "The Xero connection is not configured for this deployment — connect Xero from the agent's Deployment tab, then redeploy.",
      };
    }
    const res = await fetch(
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/list_tax_rates`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    return (await res.json()) as
      | { ok: true; result: unknown }
      | { ok: false; error: string };
  },
});
