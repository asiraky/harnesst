import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. HARNESST_API_URL and HARNESST_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side and performs the one whitelisted operation —
// name and basic details only; bank-account fields are not accepted by the whitelist.
export default defineTool({
  description:
    "Create a new contact (e.g. a supplier) in the Xero organisation with a name and basic details. Bank-account details cannot be set through this tool.",
  inputSchema: z.object({
    name: z.string().min(1).max(255).describe("The contact's name (required)."),
    email: z
      .string()
      .email()
      .max(255)
      .optional()
      .describe("The contact's email address."),
    phone: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe("The contact's phone number."),
    taxNumber: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe("Tax/ABN/VAT number."),
  }),
  async execute(input) {
    const base = process.env.HARNESST_API_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!base || !token) {
      return {
        ok: false,
        error:
          "The Xero connection is not configured for this deployment — connect Xero from the agent's Deployment tab, then redeploy.",
      };
    }
    const res = await fetch(
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/create_contact`,
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
