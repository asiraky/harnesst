/**
 * List the AgentMail account's inboxes.
 *
 * One of the four AgentMail billing-inbox tools (read + label only — nothing here can send,
 * delete, or provision mail). Set AGENTMAIL_API_KEY as a harnesst secret; the value is read from
 * the tool process environment and is never accepted as model input.
 */
import { defineTool } from "eve/tools";
import { z } from "zod";

const AGENTMAIL_API_URL = "https://api.agentmail.to/v0";

const inboxSchema = z
  .object({
    inbox_id: z.string(),
    email: z.string(),
    display_name: z.string().nullish(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const responseSchema = z
  .object({
    count: z.number(),
    next_page_token: z.string().nullish(),
    inboxes: z.array(inboxSchema),
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
    "List the inboxes on the AgentMail account (the billing inbox among them). Returns each " +
    "inbox's id and email address — use one as the inboxId for the other agentmail tools.",
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum inboxes to return. Defaults to 25."),
    pageToken: z
      .string()
      .min(1)
      .optional()
      .describe("nextPageToken from a previous call, to fetch the next page."),
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
      if (input.ascending !== undefined) {
        params.set("ascending", String(input.ascending));
      }

      const response = await fetch(`${AGENTMAIL_API_URL}/inboxes?${params}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
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
        inboxes: parsed.data.inboxes.map((inbox) => ({
          inboxId: inbox.inbox_id,
          email: inbox.email,
          displayName: inbox.display_name ?? undefined,
          createdAt: inbox.created_at,
        })),
      };
    } catch (err) {
      return { ok: false, error: `AgentMail request failed: ${errorMessage(err)}` };
    }
  },
});
