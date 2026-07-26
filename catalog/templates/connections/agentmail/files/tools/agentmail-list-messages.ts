/**
 * List/search messages in an AgentMail inbox.
 *
 * One of the four AgentMail billing-inbox tools (read + label only — nothing here can send,
 * delete, or provision mail). Set AGENTMAIL_API_KEY as a harnesst secret; the value is read from
 * the tool process environment and is never accepted as model input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";

const attachmentSchema = z
  .object({
    attachment_id: z.string(),
    filename: z.string().nullish(),
    size: z.number(),
    content_type: z.string().nullish(),
  })
  .passthrough();

// Only message_id is hard-required: one atypical message must not fail the whole page —
// everything else degrades to undefined.
const messageItemSchema = z
  .object({
    message_id: z.string(),
    thread_id: z.string().nullish(),
    labels: z.array(z.string()).nullish(),
    timestamp: z.string().nullish(),
    from: z.string().nullish(),
    to: z.array(z.string()).nullish(),
    subject: z.string().nullish(),
    preview: z.string().nullish(),
    attachments: z.array(attachmentSchema).nullish(),
  })
  .passthrough();

const responseSchema = z
  .object({
    count: z.number(),
    next_page_token: z.string().nullish(),
    messages: z.array(messageItemSchema),
  })
  .passthrough();

/**
 * Accepts an ISO 8601 date or datetime. A time component must carry an offset (Z or ±hh:mm) —
 * offset-less datetimes are ambiguous and rejected. Bare dates are expanded by the caller.
 */
const dateFilter = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/,
    "must be an ISO 8601 date, or a datetime with an offset (e.g. 2026-07-18T10:30:00Z)",
  );

/** A bare date means the whole day UTC: start-of-day for `after`, end-of-day for `before`. */
function toIsoDatetime(value: string, boundary: "start" | "end"): string {
  if (value.length > 10) return value;
  return boundary === "start"
    ? `${value}T00:00:00Z`
    : `${value}T23:59:59.999Z`;
}

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
    "List messages in an AgentMail inbox, newest first, with filters for date range, labels, " +
    "sender, recipient, and subject. Use labels [\"unread\"] to poll for mail the agent hasn't " +
    "processed yet. Returns message metadata and previews — call agentmail-get-message for a " +
    "message's full body and attachments.",
  inputSchema: z.object({
    inboxId: z
      .string()
      .min(1)
      .max(255)
      .describe(
        "Inbox id or email address (e.g. billing@agentmail.to) — from agentmail-list-inboxes.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum messages to return. Defaults to 25."),
    pageToken: z
      .string()
      .min(1)
      .optional()
      .describe("nextPageToken from a previous call, to fetch the next page."),
    labels: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Only messages carrying ALL of these labels, e.g. [\"unread\"]. Labels are free-form; " +
          "\"unread\"/\"read\" is the convention for processing state.",
      ),
    after: dateFilter
      .optional()
      .describe(
        "Only messages at or after this ISO 8601 date/datetime. A bare date means from the " +
          "start of that day UTC.",
      ),
    before: dateFilter
      .optional()
      .describe(
        "Only messages at or before this ISO 8601 date/datetime. A bare date includes that " +
          "whole day, through 23:59:59.999 UTC.",
      ),
    from: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose sender contains this substring, e.g. a supplier domain."),
    to: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose recipients (to, cc, or bcc) contain this substring."),
    subject: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Only messages whose subject contains this substring, e.g. \"invoice\"."),
    ascending: z
      .boolean()
      .optional()
      .describe("Sort oldest-first instead of newest-first."),
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
      const params = new URLSearchParams();
      params.set("limit", String(input.limit ?? 25));
      if (input.pageToken) params.set("page_token", input.pageToken);
      for (const label of input.labels ?? []) params.append("labels", label);
      if (input.after) params.set("after", toIsoDatetime(input.after, "start"));
      if (input.before) params.set("before", toIsoDatetime(input.before, "end"));
      if (input.from) params.append("from", input.from);
      if (input.to) params.append("to", input.to);
      if (input.subject) params.append("subject", input.subject);
      if (input.ascending !== undefined) {
        params.set("ascending", String(input.ascending));
      }

      const response = await fetch(
        `${AGENTMAIL_API_URL}/inboxes/${encodeURIComponent(input.inboxId)}/messages?${params}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
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
        count: parsed.data.count,
        nextPageToken: parsed.data.next_page_token ?? undefined,
        messages: parsed.data.messages.map((message) => ({
          messageId: message.message_id,
          threadId: message.thread_id ?? undefined,
          timestamp: message.timestamp ?? undefined,
          from: message.from ?? undefined,
          to: message.to ?? undefined,
          subject: message.subject ?? undefined,
          preview: message.preview ?? undefined,
          labels: message.labels ?? [],
          attachments: (message.attachments ?? []).map((attachment) => ({
            attachmentId: attachment.attachment_id,
            filename: attachment.filename ?? undefined,
            contentType: attachment.content_type ?? undefined,
            size: attachment.size,
          })),
        })),
      };
    } catch (err) {
      return { ok: false, error: `AgentMail request failed: ${errorMessage(err)}` };
    }
  },
});
