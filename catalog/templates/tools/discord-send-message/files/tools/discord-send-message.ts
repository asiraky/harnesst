import { defineTool } from "eve/tools";
import { z } from "zod";

// Sends via harnesst's control-plane Discord proxy (issue #32) instead of talking to Discord
// directly: the shared bot token never reaches the instance. HARNESST_DISCORD_SEND_URL and
// HARNESST_TEAM_TOKEN are injected at deploy; the proxy scopes sends to servers this agent is
// connected to.
export default defineTool({
  description:
    "Send a message to a Discord channel by channel id. Use this when the user asks you to notify or update Discord.",
  inputSchema: z.object({
    channelId: z
      .string()
      .min(1)
      .describe("Discord channel id to send the message to."),
    message: z
      .string()
      .min(1)
      .max(1900)
      .describe("Plain text message to send. Keep it concise."),
  }),
  async execute({ channelId, message }) {
    const sendUrl = process.env.HARNESST_DISCORD_SEND_URL;
    const token = process.env.HARNESST_TEAM_TOKEN;
    if (!sendUrl || !token) {
      return {
        ok: false,
        error: "Discord sending is not configured for this deployment.",
      };
    }

    const res = await fetch(sendUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channelId, message }),
    });

    return (await res.json()) as
      | { ok: true; channelId: string; messageId: string | null }
      | { ok: false; error: string };
  },
});
