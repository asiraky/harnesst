import { defineTool } from "eve/tools";
import { z } from "zod";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

// Runs via harnesst's brokered-capability route (issue #166) instead of talking to Xero directly:
// no Xero credential ever reaches this container. The preferred input is an immutable artifact
// version id. Harnesst resolves the stored bytes server-side, verifies that the artifact belongs to
// this agent and is a PDF document, then sends those bytes to Xero. Base64 remains only for
// compatibility with callers that do not yet publish evidence first.
export default defineTool({
  description:
    "Attach source evidence to an existing Xero bill. Prefer artifactVersionId from " +
    "publish-artifact: harnesst resolves the exact stored PDF without sending its bytes through " +
    "model context or across agent sandboxes. Compatibility base64 input remains available. Only " +
    "bills can be targeted, and files are capped at 10 MiB.",
  inputSchema: z.object({
    invoiceId: z
      .string()
      .uuid()
      .describe(
        "The bill's Xero invoice id (from create-draft-bill or search-bills).",
      ),
    artifactVersionId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Preferred: immutable artifactVersionId returned by publish-artifact for the PDF evidence.",
      ),
    filename: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,180}$/)
      .optional()
      .describe(
        "Compatibility base64 only: plain file name (no path), e.g. invoice-1234.pdf.",
      ),
    contentType: z
      .enum(["application/pdf", "image/png", "image/jpeg", "image/webp"])
      .optional()
      .describe("Compatibility base64 only: the file's content type."),
    contentBase64: z
      .string()
      .min(1)
      .max(MAX_BASE64_CHARS)
      .optional()
      .describe(
        "Compatibility input: base64 file bytes. Prefer artifactVersionId for published evidence.",
      ),
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
    if (Boolean(input.artifactVersionId) === Boolean(input.contentBase64)) {
      return {
        ok: false,
        error:
          "Pass exactly one of artifactVersionId or contentBase64. Prefer artifactVersionId for published evidence.",
      };
    }
    if (input.contentBase64 && (!input.filename || !input.contentType)) {
      return {
        ok: false,
        error: "filename and contentType are required with contentBase64.",
      };
    }
    const requestBody = input.artifactVersionId
      ? {
          invoiceId: input.invoiceId,
          artifactVersionId: input.artifactVersionId,
        }
      : {
          invoiceId: input.invoiceId,
          filename: input.filename,
          contentType: input.contentType,
          contentBase64: input.contentBase64,
        };
    const res = await fetch(
      `${base.replace(/\/+$/, "")}/api/capabilities/xero/attach_file_to_bill`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );
    return (await res.json()) as
      { ok: true; result: unknown } | { ok: false; error: string };
  },
});
