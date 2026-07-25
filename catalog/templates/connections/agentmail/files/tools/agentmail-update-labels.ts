/**
 * Add and/or remove labels on an AgentMail message.
 *
 * One of the four AgentMail billing-inbox tools (read + label only — nothing here can send,
 * delete, or provision mail). Labels are the write surface the bookkeeping flow gets: mark a
 * message processed by adding "read" and removing "unread", or tag it for a workflow
 * ("needs-review", "invoice-entered"). Set AGENTMAIL_API_KEY as a harnesst secret; the value is
 * read from the tool process environment and is never accepted as model input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";

const responseSchema = z
  .object({
    message_id: z.string(),
    labels: z.array(z.string()).nullish(),
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

export default defineTool({
  description:
    "Add and/or remove labels on one AgentMail message — the only write this connection " +
    "allows. Labels are free-form; the convention for processing state is to add \"read\" and " +
    "remove \"unread\" once a message has been handled. Returns the message's full label set " +
    "after the change.",
  inputSchema: z
    .object({
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
      addLabels: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(20)
        .optional()
        .describe("Labels to add, e.g. [\"read\", \"invoice-entered\"]."),
      removeLabels: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(20)
        .optional()
        .describe("Labels to remove, e.g. [\"unread\"]."),
    })
    .refine((input) => input.addLabels?.length || input.removeLabels?.length, {
      message: "Provide addLabels, removeLabels, or both.",
    }),
  async execute(input) {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing AGENTMAIL_API_KEY. Set it as a harnesst secret on this agent before using the AgentMail tools.",
      };
    }

    try {
      const response = await fetch(
        `${AGENTMAIL_API_URL}/inboxes/${encodeURIComponent(input.inboxId)}` +
          `/messages/${encodeURIComponent(input.messageId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            add_labels: input.addLabels,
            remove_labels: input.removeLabels,
          }),
        },
      );
      const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);

      if (!response.ok) {
        return { ok: false, status: response.status, error: apiError(response.status, body) };
      }

      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        return {
          ok: false,
          status: response.status,
          error: "AgentMail returned an unexpected response shape.",
          response: body,
        };
      }

      return {
        ok: true,
        messageId: parsed.data.message_id,
        labels: parsed.data.labels ?? [],
      };
    } catch (err) {
      return { ok: false, error: `AgentMail request failed: ${errorMessage(err)}` };
    }
  },
});
