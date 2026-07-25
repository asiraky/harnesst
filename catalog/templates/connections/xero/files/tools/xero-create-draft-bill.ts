import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. EDEN_API_URL and EDEN_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side — the bill is ALWAYS created as a DRAFT ACCPAY
// invoice (a human approves it in Xero), account codes and currency must exist in the
// organisation, and line amounts must sum to the stated total.
export default defineTool({
  description:
    "Create a DRAFT bill (supplier invoice) in Xero. The bill is always a draft — a human reviews and approves it in Xero; this tool can never authorise or pay anything. Line amounts must sum to the total.",
  inputSchema: z.object({
    contact: z
      .object({
        contactId: z
          .string()
          .uuid()
          .optional()
          .describe("Existing Xero contact id (preferred when known)."),
        name: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Contact name — Xero resolves or creates by name."),
      })
      .describe("The supplier. Provide contactId or name."),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("Bill (invoice) date, YYYY-MM-DD."),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Due date, YYYY-MM-DD."),
    reference: z
      .string()
      .max(255)
      .optional()
      .describe("Supplier's invoice number or other reference."),
    currency: z
      .string()
      .length(3)
      .optional()
      .describe(
        "ISO currency code; must be one of the organisation's subscribed currencies. Omit for the org's base currency.",
      ),
    currencyRate: z
      .number()
      .positive()
      .optional()
      .describe("Explicit exchange rate for a foreign-currency bill."),
    lineItems: z
      .array(
        z.object({
          description: z.string().min(1).max(4000).describe("Line description."),
          quantity: z.number().positive().describe("Quantity."),
          unitAmount: z.number().describe("Unit price (pre-tax)."),
          accountCode: z
            .string()
            .min(1)
            .max(50)
            .describe(
              "Chart-of-accounts code — must exist in the organisation (see the list-accounts tool).",
            ),
          taxType: z
            .string()
            .min(1)
            .max(50)
            .optional()
            .describe("Xero tax type code for the line (see list-tax-rates)."),
          lineAmount: z
            .number()
            .optional()
            .describe("Explicit line amount; defaults to quantity × unitAmount."),
        }),
      )
      .min(1)
      .max(200)
      .describe("The bill's lines."),
    total: z
      .number()
      .describe("Sum of the line amounts (pre-tax) — cross-checked server-side."),
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
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/create_draft_bill`,
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
