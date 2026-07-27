/**
 * Pushed run reporting (WS2). Every harnesst-built agent image carries `agent/hooks/harnesst-runs.ts`
 * (app/observability/run-hook-template.ts), which POSTs each turn's raw event list here with
 * `Authorization: Bearer <HARNESST_TEAM_TOKEN>` — the SAME delegation bearer the team relay, the
 * Discord send proxy and the channel park (`/api/foh/park`) use. No new secret, no new auth
 * mechanism: the token authenticates a DEPLOYMENT ID and nothing else, and every other identity
 * (environment → agent → project → release) is re-derived server-side.
 *
 * Transport shell only, the division `routes/api.team.ask.ts` and `routes/api.foh.park.ts` set:
 * a bad token is the only 401, an oversized or malformed body is a 400, and every business
 * outcome the agent could read is a 200 `{ ok }`. That matters here more than usual — the caller
 * is a fire-and-forget hook, so a 5xx would be retried forever by nobody and a 4xx it cannot act
 * on is just noise in the container log.
 *
 * Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import {
  defaultPushIngestDeps,
  ingestPushedTurn,
  normalizePushedEvents,
  MAX_PUSHED_BODY_BYTES,
} from "~/observability/push-ingest.server";
import { channelForTrigger } from "~/observability/session-turns.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId) throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  // Decide from the HEADER, before the body is read or parsed. A turn whose channel classifies
  // to null is discarded by `ingestPushedTurn` anyway; doing it here means the control plane
  // never buffers and JSON-parses a multi-megabyte transcript to reach that conclusion. An
  // ABSENT header claims nothing and falls through — only a header the classifier actually
  // rejects short-circuits, so an older agent image behaves exactly as it did.
  const declaredKind = request.headers.get("x-harnesst-channel-kind");
  if (declaredKind !== null && channelForTrigger(declaredKind) === null) {
    return data({ ok: true, recorded: false, reason: "channel-not-recorded" });
  }

  // Cheap pre-check on the declared length, then the real one on the decoded text: a lying (or
  // absent) content-length must not get a body past the cap.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PUSHED_BODY_BYTES) {
    throw data({ ok: false, error: "Run report is too large." }, { status: 413 });
  }

  // The real size check is on the decoded text, and it lives OUTSIDE the parse try/catch on
  // purpose: `data()` returns a plain `DataWithResponseInit`, not a `Response`, so a 413 thrown
  // inside that try would be caught by its own handler and downgraded to a 400.
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PUSHED_BODY_BYTES) {
    throw data({ ok: false, error: "Run report is too large." }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    throw data({ ok: false, error: "Malformed JSON body." }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const turnId = typeof body.turnId === "string" ? body.turnId : "";
  const events = normalizePushedEvents(body.events);
  if (!sessionId || !turnId || !events) {
    throw data(
      { ok: false, error: "Send sessionId, turnId and an events array." },
      { status: 400 },
    );
  }

  const result = await ingestPushedTurn(
    {
      deploymentId,
      sessionId,
      turnId,
      turnSequence:
        typeof body.turnSequence === "number" ? body.turnSequence : null,
      channelKind: typeof body.channelKind === "string" ? body.channelKind : null,
      modelId: typeof body.modelId === "string" ? body.modelId : null,
      agentName: typeof body.agentName === "string" ? body.agentName : null,
      final: body.final === true,
      truncated: body.truncated === true,
      events,
    },
    defaultPushIngestDeps(),
  );
  return data(result);
}
