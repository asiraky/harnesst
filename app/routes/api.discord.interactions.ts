/**
 * Discord interactions relay (issue #32) — the single Interactions Endpoint URL of harnesst's
 * shared app. Discord POSTs every interaction here; the control plane verifies the Ed25519
 * signature, answers the endpoint-validation PING itself (no guild is connected at setup time),
 * and otherwise forwards the RAW request (body + signature headers untouched) to the bound
 * agent instance's eve Discord channel, which re-verifies and replies with the interaction
 * token. Command starts are indexed before that raw forward; the bot token never leaves the
 * control plane. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getDiscordAppConfig } from "~/discord/config.server";
import { DISCORD_CHANNEL_ROUTE } from "~/discord/connect.server";
import {
  defaultRelayDeps,
  discordRunStart,
  resolveRelayTarget,
  verifyDiscordSignature,
  type InteractionPayload,
} from "~/discord/relay.server";
import {
  recordTurnFailure,
  recordTurnStart,
  type TurnIds,
} from "~/observability/record.server";

/** Discord's interaction must be answered within 3s — leave slack for response serialization. */
export const DISCORD_ACTION_BUDGET_MS = 2800;
/** Normal inserts are fast; cap pathological DB waits so forwarding still owns most of the ACK. */
export const RUN_START_RECORD_BUDGET_MS = 200;

function remainingBudget(deadlineAt: number): number {
  return Math.max(1, Math.floor(deadlineAt - performance.now()));
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("operation timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function settleForwardFailure(
  runStart: TurnIds | null,
  startedAt: Date,
  error: string,
): void {
  if (!runStart) return;
  // The response is still on Discord's hard deadline. Let the durable failure write finish in
  // the background; its terminal-monotonic upsert also wins if a timed-out start write lands late.
  void recordTurnFailure({ ...runStart, error, startedAt }).catch(
    (recordError) => {
      console.warn(
        `[discord] failed to record forwarding failure for interaction ${runStart.externalRunId}`,
        recordError,
      );
    },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const deadlineAt = performance.now() + DISCORD_ACTION_BUDGET_MS;
  const config = getDiscordAppConfig();
  if (!config) throw data("discord app not configured", { status: 503 });

  const raw = await request.text();
  const sig = request.headers.get("x-signature-ed25519");
  const ts = request.headers.get("x-signature-timestamp");
  if (!verifyDiscordSignature(raw, sig, ts, config.publicKey)) {
    throw data("invalid signature", { status: 401 });
  }

  let payload: InteractionPayload;
  try {
    payload = JSON.parse(raw) as InteractionPayload;
  } catch {
    throw data("invalid payload", { status: 400 });
  }

  // PING (type 1): Discord's endpoint validation and heartbeat. Answered control-plane-side —
  // at endpoint-setup time no guild is connected yet, and it needs a signed PONG to accept the URL.
  if (payload.type === 1) {
    return data({ type: 1 });
  }

  let target: Awaited<ReturnType<typeof resolveRelayTarget>>;
  try {
    target = await within(
      resolveRelayTarget(payload, defaultRelayDeps()),
      remainingBudget(deadlineAt),
    );
  } catch {
    return data("the connected agent lookup did not respond in time", {
      status: 504,
    });
  }
  if (!target.ok) {
    return target.reason === "no-connection"
      ? data("no agent connected for this interaction", { status: 404 })
      : data("the connected agent has no live deployment", { status: 503 });
  }

  // Eve's deferred command ACK only says the background turn was accepted, not that it
  // completed. Persist the running row before forwarding so an interrupted turn still exists;
  // components and modals resume existing work and therefore produce no new row here.
  const runStart = discordRunStart(payload, target);
  const startedAt = new Date();
  let startRecorded: boolean | undefined;
  if (runStart) {
    try {
      startRecorded = await within(
        recordTurnStart(runStart),
        Math.min(RUN_START_RECORD_BUDGET_MS, remainingBudget(deadlineAt)),
      );
    } catch (error) {
      // Recording follows the same best-effort rule as playground/team turns: observability
      // must never prevent Discord from receiving its time-sensitive interaction response.
      console.warn(
        `[discord] failed to record run start for interaction ${payload.id ?? "unknown"}`,
        error,
      );
    }
  }
  if (startRecorded === false) {
    // Teardown closed the deployment gate after target resolution. The old URL may still answer
    // briefly, but forwarding there would accept untracked work that no later sweep could find.
    return data("the connected agent deployment is no longer live", {
      status: 503,
    });
  }

  // Forward the raw request unchanged — the instance re-verifies the signature over this exact
  // body, so the headers pass through verbatim. Discord's deadline is 3s.
  let res: Response;
  try {
    res = await fetch(`${target.url}${DISCORD_CHANNEL_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type":
          request.headers.get("content-type") ?? "application/json",
        "x-signature-ed25519": sig!,
        "x-signature-timestamp": ts!,
      },
      body: raw,
      signal: AbortSignal.timeout(remainingBudget(deadlineAt)),
    });
  } catch {
    settleForwardFailure(
      runStart,
      startedAt,
      "Discord relay could not reach the deployment before the interaction deadline.",
    );
    return data("the connected agent did not respond in time", { status: 504 });
  }

  if (!res.ok) {
    settleForwardFailure(
      runStart,
      startedAt,
      `Discord deployment rejected the interaction with HTTP ${res.status}.`,
    );
  }

  try {
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    // Once a 2xx response exists, Eve may already have accepted the background turn. Do not
    // mislabel it failed merely because its deferred-ACK body was interrupted in transit.
    return data("the connected agent did not respond in time", { status: 504 });
  }
}
