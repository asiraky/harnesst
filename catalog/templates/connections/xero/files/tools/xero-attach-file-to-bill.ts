import { defineTool } from "eve/tools";
import { z } from "zod";

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. EDEN_API_URL and EDEN_TEAM_TOKEN are injected
// at deploy; harnesst validates the call server-side — the target must be a bill (ACCPAY invoice) in
// the connected organisation, the content type must be pdf/png/jpeg/webp, and the decoded file
// is capped at 10 MiB.
export default defineTool({
  description:
    "Attach a source file (the supplier's invoice PDF or an image) to an existing bill in Xero. Only bills can be targeted; files are capped at 10 MiB.",
  inputSchema: z.object({
    invoiceId: z
      .string()
      .uuid()
      .describe("The bill's Xero invoice id (from create-draft-bill or search-bills)."),
    filename: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,180}$/)
      .describe(
        "Plain file name (letters, digits, dots, dashes, spaces; no paths), e.g. invoice-1234.pdf.",
      ),
    contentType: z
      .enum(["application/pdf", "image/png", "image/jpeg", "image/webp"])
      .describe("The file's content type."),
    contentBase64: z
      .string()
      .min(1)
      .describe("The file's bytes, base64-encoded (max 10 MiB decoded)."),
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
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/attach_file_to_bill`,
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
