import { timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { ledgerRpc } from "../lib/ledger.js";
import { startLeaseHeartbeat } from "../lib/ledger-lease.js";
type LedgerState = { itemId: string; outboxId: string; claimToken: string };
const heartbeats = new Map<string, { stop: () => void }>();
function stopHeartbeat(state: LedgerState): void {
  heartbeats.get(state.claimToken)?.stop();
  heartbeats.delete(state.claimToken);
}
function beginHeartbeat(state: LedgerState): void {
  if (!state.claimToken || heartbeats.has(state.claimToken)) return;
  const heartbeat = startLeaseHeartbeat(async () => {
    const result = await ledgerRpc("renew_claim", {
      outbox_id: state.outboxId,
      claim_token: state.claimToken,
    });
    if (result.ok && !result.data?.renewed) heartbeats.delete(state.claimToken);
    return result as { ok: boolean; data?: { renewed?: boolean } };
  });
  heartbeats.set(state.claimToken, heartbeat);
}
export default defineChannel({
  context: (state: LedgerState) => ({ state }),
  state: { itemId: "", outboxId: "", claimToken: "" },
  events: {
    "turn.started": (_event: unknown, channel: { state: LedgerState }) =>
      beginHeartbeat(channel.state),
    "turn.completed": (_event: unknown, channel: { state: LedgerState }) =>
      stopHeartbeat(channel.state),
    "turn.failed": (_event: unknown, channel: { state: LedgerState }) =>
      stopHeartbeat(channel.state),
    "session.failed": (_event: unknown, channel: { state: LedgerState }) =>
      stopHeartbeat(channel.state),
  },
  routes: [
    POST("/eve/v1/ledger/wake", async (request, { send }) => {
      const expected = process.env.LEDGER_WAKE_TOKEN;
      const got = (request.headers.get("authorization") ?? "").replace(
        /^Bearer\s+/i,
        "",
      );
      if (
        !expected ||
        Buffer.byteLength(got) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(got), Buffer.from(expected))
      )
        return Response.json({ error: "unauthorized" }, { status: 401 });
      let body: { outbox_id?: string };
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (
        !body ||
        typeof body.outbox_id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.outbox_id)
      )
        return Response.json({ error: "outbox_id required" }, { status: 400 });
      const claim = await ledgerRpc("claim", { outbox_id: body.outbox_id });
      if (!claim.ok) return Response.json(claim, { status: 503 });
      if (claim.data.already_claimed || claim.data.gone)
        return Response.json({ ok: true, skipped: true });
      const item = claim.data.item;
      const state: LedgerState = {
        itemId: item.id,
        outboxId: body.outbox_id,
        claimToken: claim.data.claim_token,
      };
      beginHeartbeat(state);
      try {
        const session = await send(
          {
            message: `Ledger: item ${item.id} is at ${item.stage} (${claim.data.kind}). Read it with ledger-get-item and act from your instructions. The channel has already claimed wake ${body.outbox_id}. After a human notification, use ledger-complete-wake with that ID.`,
          },
          {
            auth: null,
            continuationToken: "ledger:" + body.outbox_id,
            state,
          },
        );
        return Response.json({ ok: true, sessionId: session.id });
      } catch {
        stopHeartbeat(state);
        return Response.json(
          { error: "dispatch failed; lease will expire for redelivery" },
          { status: 503 },
        );
      }
    }),
  ],
});
