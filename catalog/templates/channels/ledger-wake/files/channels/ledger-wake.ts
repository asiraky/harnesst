import { timingSafeEqual } from "node:crypto";
import { defineChannel, POST } from "eve/channels";
import { ledgerRpc, type LedgerCaller } from "../lib/ledger.js";
import { createLeaseKeeper } from "../lib/ledger-lease.js";
// claimToken is the issue lease this session holds; the ledger refuses writes from any other session.
type LedgerState = { itemId: string; outboxId: string; claimToken: string };
type Channel = { state: LedgerState };
const leases = createLeaseKeeper(ledgerRpc);
const release = (_event: unknown, channel: Channel) =>
  leases.release(channel.state.claimToken);
export default defineChannel({
  context: (state: LedgerState) => ({ state }),
  state: { itemId: "", outboxId: "", claimToken: "" },
  events: {
    // Also restarts the heartbeat when eve resumes the run after a process restart.
    "turn.started": (_event: unknown, channel: Channel, ctx: LedgerCaller) =>
      leases.hold(channel.state.claimToken, ctx?.session?.id),
    "turn.completed": release,
    "turn.failed": release,
    "session.failed": release,
    // Parked: stop renewing. If it resumes before expiry nothing changed; otherwise a wake takes over.
    "session.waiting": (_event: unknown, channel: Channel) =>
      leases.drop(channel.state.claimToken),
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
      // Another session holds this issue: the ledger redelivers when it is released or expires.
      if (claim.data.deferred)
        return Response.json({ ok: true, deferred: true, until: claim.data.until });
      const item = claim.data.item;
      const token: string = claim.data.lease_token ?? claim.data.claim_token;
      const state: LedgerState = {
        itemId: item.id,
        outboxId: body.outbox_id,
        claimToken: token,
      };
      await leases.hold(token);
      try {
        const session = await send(
          {
            message: `Ledger: item ${item.id} is at ${item.stage} (${claim.data.kind}). Read it with ledger-get-item and act from your instructions. The channel has already claimed wake ${body.outbox_id}. After a human notification, use ledger-complete-wake with that ID.`,
          },
          {
            auth: null,
            // No human watches a wake session; human questions go through ledger-block.
            // Task mode hides ask_question from this session and its subagents, and fails a
            // turn that would wait for input so the lease lapses and the ledger redelivers.
            mode: "task",
            // One session per lease grant: a redelivery after takeover never resumes the old session.
            continuationToken: `ledger:${body.outbox_id}:${claim.data.fence ?? 0}`,
            state,
          },
        );
        await leases.hold(token, session.id);
        return Response.json({ ok: true, sessionId: session.id });
      } catch {
        await leases.release(token);
        return Response.json(
          { error: "dispatch failed; the ledger redelivers this wake" },
          { status: 503 },
        );
      }
    }),
  ],
});
