import {
  discordChannel,
  discordContinuationToken,
  renderInputRequestComponents,
  splitDiscordMessageContent,
} from "eve/channels/discord";

// DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY are provisioned automatically by harnesst at
// deploy from the installation's shared Discord app — no need to set them yourself. No bot
// token is provided to the instance: the shared token stays on the control plane, and
// interaction replies use the interaction token, so the channel works without it.

const HARNESST_REPLY_REQUEST_ID = "harnesst:reply";
// = eve's DISCORD_HITL_FREEFORM_CUSTOM_ID_PREFIX ("eve_input_freeform:") +
//   base64url(JSON.stringify({ requestId: HARNESST_REPLY_REQUEST_ID })) — 54 chars, under
//   Discord's 100-char custom_id cap. Hardcoded so eve's built-in freeform route decodes the
//   click with zero code on our side; if eve's decoder format ever drifts, clicks degrade to
//   an acked no-op rather than an error.
const HARNESST_REPLY_CUSTOM_ID =
  "eve_input_freeform:eyJyZXF1ZXN0SWQiOiJlZGVuOnJlcGx5In0";

const base = discordChannel({
  events: {
    // Supplying a "turn.started" override replaces eve's built-in handler, so we re-assert its
    // default behavior (startTyping) here. We also reset the per-turn flag that tracks whether
    // this turn already posted its own question — see the "session.waiting" workaround below.
    async "turn.started"(event, channel) {
      (channel.state as any).harnesstTurnAskedQuestion = false;
      channel.discord.startTyping();
    },

    // Work around eve anchoring the continuation token to the session's first posted message
    // while Discord component and modal answers route by the clicked message id. Remove this
    // override once eve re-keys input requests upstream. Each post replaces the token, so only
    // the latest question routes; older superseded buttons remain stale. If one event contains
    // multiple requests, only the last posted request routes.
    async "input.requested"(event, channel) {
      (channel.state as any).harnesstTurnAskedQuestion = true;
      for (const request of event.requests) {
        const content =
          splitDiscordMessageContent(request.prompt)[0] ?? request.prompt;
        const posted = await channel.discord.post({
          components: renderInputRequestComponents(request),
          content,
        });

        if (posted.id && channel.discord.channelId) {
          channel.setContinuationToken(
            discordContinuationToken(channel.discord.channelId, posted.id),
          );
        }
      }
    },

    // Work around eve lacking a "reply to continue" affordance: when a turn ends with prose (no
    // ask_question) the session parks at wait: "next-user-message", but Discord instances have
    // no bot token/gateway so there is no reply path — the conversation dead-ends. We post a
    // "Reply" button whose custom_id is eve's own freeform-modal format, then re-key the
    // continuation token to it so eve's built-in freeform route handles the click end-to-end
    // (opens a modal, decodes the submit). Skip when the turn already posted a question, so we
    // do not clobber that question's own button routing. Remove once eve grows this upstream.
    async "session.waiting"(event, channel) {
      if (event.wait !== "next-user-message") return;
      if ((channel.state as any).harnesstTurnAskedQuestion) return; // question buttons already routing
      const posted = await channel.discord.post({
        content: "_Reply to continue this conversation._",
        components: [
          {
            type: 1, // ACTION_ROW
            components: [
              {
                type: 2, // BUTTON
                style: 1, // PRIMARY
                label: "Reply",
                custom_id: HARNESST_REPLY_CUSTOM_ID,
              },
            ],
          },
        ],
      });
      if (posted.id && channel.discord.channelId) {
        channel.setContinuationToken(
          discordContinuationToken(channel.discord.channelId, posted.id),
        );
      }
    },
  },
});

// Work around eve lacking a "reply to continue" affordance: eve silently drops inputResponses
// when no input batch is pending, so the Reply modal's sentinel answer must be re-shaped into a
// plain user message — exactly what a next-user-message wait consumes. Wraps the compiled
// adapter because DiscordChannelConfig exposes no deliver hook; remove once eve has a
// first-class reply-to-continue affordance.
const deliver: typeof base.adapter.deliver = (payload, ctx) => {
  const replies = (payload.inputResponses ?? []).filter(
    (r) => r.requestId === HARNESST_REPLY_REQUEST_ID && typeof r.text === "string",
  );
  if (replies.length === 0) return base.adapter.deliver(payload, ctx);
  const rest = (payload.inputResponses ?? []).filter(
    (r) => r.requestId !== HARNESST_REPLY_REQUEST_ID,
  );
  return {
    message: replies.map((r) => r.text).join("\n\n"),
    ...(rest.length > 0 ? { inputResponses: rest } : {}),
    context: payload.context,
    outputSchema: payload.outputSchema,
  };
};

export default {
  ...base,
  adapter: {
    ...base.adapter,
    deliver,
  },
};
