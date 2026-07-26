import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. HARNESST_API_URL and HARNESST_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side and performs the one whitelisted operation
// (bills only — the search is always pinned to ACCPAY, never sales invoices).
export default defineTool({
  description:
    "Search the Xero organisation's bills (supplier invoices) by contact name, status, date range, or reference. Returns bills only, never sales invoices.",
  inputSchema: z.object({
    contactName: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Case-insensitive contains-match on the supplier's contact name. No quotes or backslashes.",
      ),
    status: z
      .enum(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED"])
      .optional()
      .describe("Filter by bill status."),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Earliest bill date, YYYY-MM-DD."),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Latest bill date, YYYY-MM-DD."),
    reference: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Exact reference match. No quotes or backslashes."),
    page: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Result page (100 bills per page), defaults to 1."),
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
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/search_bills`,
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
