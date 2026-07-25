import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. EDEN_API_URL and EDEN_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side and performs the one whitelisted operation.
export default defineTool({
  description:
    "Find contacts (suppliers and others) in the Xero organisation by free-text search over names and emails. Use this to get a contactId before creating a draft bill.",
  inputSchema: z.object({
    searchTerm: z
      .string()
      .min(1)
      .max(255)
      .describe("Free-text search over contact names and email addresses."),
  }),
  async execute(input) {
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
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/find_contact`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    return (await res.json()) as
      | { ok: true; result: unknown }
      | { ok: false; error: string };
  },
});
