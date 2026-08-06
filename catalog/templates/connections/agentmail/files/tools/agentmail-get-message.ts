/**
 * Read a full AgentMail message, including attachment downloads.
 *
 * One of the four AgentMail billing-inbox tools (read + label only — nothing here can send,
 * delete, or provision mail). Set AGENTMAIL_API_KEY as a harnesst secret; the value is read from
 * the tool process environment and is never accepted as model input.
 *
 * Attachment downloads: the AgentMail API hands out a short-lived presigned download URL, so
 * the default is to return that URL. For tool-to-tool document workflows, saveAttachmentToHome
 * downloads the file into /workspace/home and returns only its path. Base64 remains available for
 * small compatibility cases, capped by maxAttachmentBytes.
 */
import { defineTool } from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";
const ATTACHMENT_DIR = "/workspace/home/artifacts/mail";
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const attachmentSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().nullish(),
    size: z.number(),
    content_type: z.string().nullish(),
    content_id: z.string().nullish(),
  })
  .passthrough();

// Only message_id is hard-required: one atypical message (a draft with no recipients, say)
// must not fail the whole call — everything else degrades to undefined.
const messageSchema = z
  .object({
    message_id: z.string(),
    thread_id: z.string().nullish(),
    labels: z.array(z.string()).nullish(),
    timestamp: z.string().nullish(),
    from: z.string().nullish(),
    to: z.array(z.string()).nullish(),
    cc: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    text: z.string().nullish(),
    html: z.string().nullish(),
    extracted_text: z.string().nullish(),
    attachments: z.array(attachmentSchema).nullish(),
  })
  .passthrough();

/** The documented attachment response: metadata plus a presigned download URL. */
const attachmentResponseSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().nullish(),
    size: z.number(),
    content_type: z.string().nullish(),
    download_url: z.string(),
    expires_at: z.string(),
  })
  .passthrough();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** AgentMail's error body is { name, message, fix?, docs? } — surface the useful parts. */
function apiError(status: number, body: unknown): string {
  const err = body as { message?: string; fix?: string } | null;
  if (err && typeof err.message === "string") {
    return err.fix
      ? `${err.message} (HTTP ${status}) — ${err.fix}`
      : `${err.message} (HTTP ${status})`;
  }
  return `AgentMail request failed with HTTP ${status}.`;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars
    ? `${value.slice(0, maxChars)}\n\n[truncated]`
    : value;
}

function safeFileName(value: string | undefined): string {
  const cleaned = (value ?? "attachment")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._ ()-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 140);
  return cleaned || "attachment";
}

async function saveAttachment(input: {
  bytes: ArrayBuffer;
  messageId: string;
  attachmentId: string;
  filename?: string;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
}): Promise<{ path: string; sha256: string }> {
  const identity = createHash("sha256")
    .update(input.messageId)
    .update("\0")
    .update(input.attachmentId)
    .digest("hex")
    .slice(0, 16);
  const destination = `${ATTACHMENT_DIR}/${identity}-${safeFileName(input.filename)}`;
  await input.write(destination, new Uint8Array(input.bytes));
  return {
    path: destination,
    sha256: createHash("sha256")
      .update(new Uint8Array(input.bytes))
      .digest("hex"),
  };
}

export default defineTool({
  description:
    "Read one AgentMail message in full: body (plain text, plus the reply-extracted text and " +
    "optional HTML) and its attachment list. To download an attachment (invoice PDFs are the " +
    "point), pass its attachmentId. For another tool to process the file, set " +
    "saveAttachmentToHome and pass the returned path; this keeps attachment bytes out of model " +
    "context. A short-lived downloadUrl is returned by default. Inline base64 is for small " +
    "compatibility cases only.",
  inputSchema: z.object({
    inboxId: z
      .string()
      .min(1)
      .max(255)
      .describe("Inbox id or email address the message lives in."),
    messageId: z
      .string()
      .min(1)
      .max(500)
      .describe("Message id, from agentmail-list-messages."),
    includeHtml: z
      .boolean()
      .optional()
      .describe(
        "Also return the HTML body. Off by default — text is usually enough.",
      ),
    maxBodyChars: z
      .number()
      .int()
      .min(500)
      .max(100000)
      .optional()
      .describe(
        "Maximum characters per body field returned to the model. Defaults to 20000.",
      ),
    attachmentId: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Download this attachment (from the message's attachments list).",
      ),
    includeAttachmentContent: z
      .boolean()
      .optional()
      .describe(
        "Inline the attachment's bytes as base64 instead of just returning its downloadUrl. " +
          "Off by default; capped by maxAttachmentBytes.",
      ),
    saveAttachmentToHome: z
      .boolean()
      .optional()
      .describe(
        "Download the attachment under /workspace/home and return its local path for another " +
          "installed tool. Prefer this over inline base64 for PDFs and other documents.",
      ),
    maxAttachmentBytes: z
      .number()
      .int()
      .min(1024)
      .max(4194304)
      .optional()
      .describe(
        "Largest attachment to download, in bytes. Defaults to 4 MiB when saving to home and " +
          "256 KiB when returning inline base64. Hard cap 4 MiB.",
      ),
  }),
  async execute(input, ctx) {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing AGENTMAIL_API_KEY. Set it as a harnesst secret on this agent before using the AgentMail tools.",
      };
    }
    if (input.includeAttachmentContent && input.saveAttachmentToHome) {
      return {
        ok: false,
        error:
          "Choose saveAttachmentToHome or includeAttachmentContent, not both. Prefer saving to home for tool-to-tool workflows.",
      };
    }

    try {
      const maxBodyChars = input.maxBodyChars ?? 20000;
      const headers = { Authorization: `Bearer ${apiKey}` };
      const messageUrl =
        `${AGENTMAIL_API_URL}/inboxes/${encodeURIComponent(input.inboxId)}` +
        `/messages/${encodeURIComponent(input.messageId)}`;

      const messageResponse = await fetch(messageUrl, { headers });
      const messageBody: unknown =
        messageResponse.status === 204
          ? null
          : await messageResponse.json().catch(() => null);
      if (!messageResponse.ok) {
        return {
          ok: false,
          status: messageResponse.status,
          error: apiError(messageResponse.status, messageBody),
        };
      }
      const parsed = messageSchema.safeParse(messageBody);
      if (!parsed.success) {
        return {
          ok: false,
          status: messageResponse.status,
          error: "AgentMail returned an unexpected response shape.",
          response: messageBody,
        };
      }
      const message = parsed.data;

      const attachments = (message.attachments ?? []).map((attachment) => ({
        attachmentId: attachment.attachment_id,
        filename: attachment.filename ?? undefined,
        contentType: attachment.content_type ?? undefined,
        size: attachment.size,
      }));

      const result: Record<string, unknown> = {
        ok: true,
        messageId: message.message_id,
        threadId: message.thread_id ?? undefined,
        timestamp: message.timestamp ?? undefined,
        from: message.from ?? undefined,
        to: message.to ?? undefined,
        cc: message.cc ?? undefined,
        subject: message.subject ?? undefined,
        labels: message.labels ?? undefined,
        text: message.text ? truncate(message.text, maxBodyChars) : undefined,
        extractedText: message.extracted_text
          ? truncate(message.extracted_text, maxBodyChars)
          : undefined,
        html:
          input.includeHtml && message.html
            ? truncate(message.html, maxBodyChars)
            : undefined,
        attachments,
      };

      if (!input.attachmentId) return result;

      const known = attachments.find(
        (a) => a.attachmentId === input.attachmentId,
      );
      if (!known) {
        return {
          ok: false,
          error:
            `No attachment "${input.attachmentId}" on this message. ` +
            `Available: ${attachments.map((a) => a.attachmentId).join(", ") || "(none)"}.`,
          attachments,
        };
      }

      const maxBytes =
        input.maxAttachmentBytes ??
        (input.saveAttachmentToHome ? MAX_ATTACHMENT_BYTES : 256 * 1024);
      const attachmentResponse = await fetch(
        `${messageUrl}/attachments/${encodeURIComponent(input.attachmentId)}`,
        { headers },
      );
      const contentType = attachmentResponse.headers.get("content-type") ?? "";

      // The documented response is JSON metadata with a presigned download_url; some deployments
      // stream the raw file instead. Handle both — but never buffer the bytes until we know the
      // caller asked to stage or inline content AND the declared size is under the cap.
      let downloadUrl: string | undefined;
      let expiresAt: string | undefined;
      let filename = known.filename;
      let mimeType = known.contentType;
      let declaredSize = known.size;
      let streamed = false;

      if (contentType.includes("json")) {
        const attachmentBody: unknown = await attachmentResponse
          .json()
          .catch(() => null);
        if (!attachmentResponse.ok) {
          return {
            ok: false,
            status: attachmentResponse.status,
            error: apiError(attachmentResponse.status, attachmentBody),
          };
        }
        const parsedAttachment =
          attachmentResponseSchema.safeParse(attachmentBody);
        if (!parsedAttachment.success) {
          return {
            ok: false,
            status: attachmentResponse.status,
            error:
              "AgentMail returned an unexpected attachment response shape.",
            response: attachmentBody,
          };
        }
        downloadUrl = parsedAttachment.data.download_url;
        expiresAt = parsedAttachment.data.expires_at;
        filename = parsedAttachment.data.filename ?? filename;
        mimeType = parsedAttachment.data.content_type ?? mimeType;
        declaredSize = parsedAttachment.data.size ?? known.size;
      } else {
        if (!attachmentResponse.ok) {
          return {
            ok: false,
            status: attachmentResponse.status,
            error: `Attachment download failed with HTTP ${attachmentResponse.status}.`,
          };
        }
        streamed = true;
        mimeType = contentType || mimeType;
      }

      if (!input.includeAttachmentContent && !input.saveAttachmentToHome) {
        if (!downloadUrl) {
          return {
            ok: false,
            error:
              "AgentMail streamed the attachment without a download URL — retry with includeAttachmentContent to receive the bytes as base64.",
          };
        }
        return {
          ok: true,
          attachment: {
            attachmentId: input.attachmentId,
            filename,
            contentType: mimeType,
            size: declaredSize,
            downloadUrl,
            expiresAt,
          },
        };
      }

      // Pre-check the declared size before pulling any bytes into memory.
      if (declaredSize > maxBytes) {
        return {
          ok: false,
          error:
            `Attachment is ${declaredSize} bytes, over the ${maxBytes}-byte download cap. ` +
            "Raise maxAttachmentBytes within the 4 MiB hard limit or handle the attachment outside this workflow.",
          attachment: {
            attachmentId: input.attachmentId,
            filename,
            contentType: mimeType,
            size: declaredSize,
            downloadUrl,
            expiresAt,
          },
        };
      }

      let bytes: ArrayBuffer | null = null;
      if (streamed) {
        bytes = await attachmentResponse.arrayBuffer();
      } else if (downloadUrl) {
        const downloadResponse = await fetch(downloadUrl);
        if (!downloadResponse.ok) {
          return {
            ok: false,
            status: downloadResponse.status,
            error: `Downloading the attachment from its presigned URL failed with HTTP ${downloadResponse.status}.`,
          };
        }
        bytes = await downloadResponse.arrayBuffer();
      }
      if (!bytes) {
        return { ok: false, error: "No attachment bytes available to return." };
      }

      // The declared size can lie — re-check the real byte count after buffering.
      if (bytes.byteLength > maxBytes) {
        return {
          ok: false,
          error:
            `Attachment is ${bytes.byteLength} bytes, over the ${maxBytes}-byte download cap. ` +
            "Raise maxAttachmentBytes within the 4 MiB hard limit or handle the attachment outside this workflow.",
          attachment: {
            attachmentId: input.attachmentId,
            filename,
            contentType: mimeType,
            size: bytes.byteLength,
            downloadUrl,
            expiresAt,
          },
        };
      }

      const attachment = {
        attachmentId: input.attachmentId,
        filename,
        contentType: mimeType,
        size: bytes.byteLength,
        expiresAt,
      };
      if (input.saveAttachmentToHome) {
        const sandbox = await ctx.getSandbox();
        const saved = await saveAttachment({
          bytes,
          messageId: input.messageId,
          attachmentId: input.attachmentId,
          filename,
          write: (path, content) =>
            Promise.resolve(
              sandbox.writeBinaryFile({
                path,
                content,
                abortSignal: ctx.abortSignal,
              }),
            ),
        });
        return {
          ok: true,
          attachment: { ...attachment, ...saved },
        };
      }

      return {
        ok: true,
        attachment: {
          ...attachment,
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: `AgentMail request failed: ${errorMessage(err)}`,
      };
    }
  },
});
