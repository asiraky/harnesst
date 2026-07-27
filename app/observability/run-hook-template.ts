/**
 * The generated `harnesst-runs` hook (WS2 — run visibility). This exports the SOURCE TEXT of a
 * static eve hook that harnesst bakes into EVERY agent image at build time (never the repo) —
 * the same mechanism as the `ask-teammate` tool (app/team/tool-template.ts), one directory over.
 *
 * Why this exists at all
 * ----------------------
 * Run observability was designed as a PULL: a reconciler reads each environment's Workflow world
 * database (`workflow.workflow_runs`) to discover channel-homed sessions, then drains eve's
 * replay stream. A production run on 2026-07-26/27 established that path has never produced a
 * single row, for any channel, on any environment — the deployed eve (0.22.6) ships no Postgres
 * workflow backend at all, so the world databases harnesst provisions stay permanently empty and
 * `listWorldSessions` swallows the resulting `42P01`. Worse, `listWorldSessions` is implemented by
 * exactly ONE of four deploy targets, so nomad/vercel/container deployments were never reachable
 * by the pull design even in principle.
 *
 * eve 0.22.6 does ship the lever that fixes it, and it is agent-level rather than per-channel:
 * `agent/hooks/*.ts` files (`eve/hooks`, `defineHook`) subscribe to runtime stream events AFTER
 * eve has durably recorded them, on EVERY channel, with `ctx.session.id`, `ctx.session.turn` and
 * `ctx.channel.kind` in scope. So the container can report its own turns outward and harnesst
 * folds them with the same pure `foldSessionEvents` and ingests them through the same
 * `recordTurnStart`/`recordTurnFinish` chokepoint the playground uses. No eve change, no world
 * database, and it works for every deploy target because it is just an HTTP POST.
 *
 * Contract this source must uphold (also what tests/unit/run-hook-template.test.ts pins):
 *  - imports ONLY `eve/hooks` (eve is in every agent's package.json — it is the framework);
 *  - module-load is crash-proof and the handler body is inside a `try/catch` that SWALLOWS.
 *    This is not defensive style, it is required: `dispatchStreamEventHooks` lets hook errors
 *    PROPAGATE, and the harness converts them into the recoverable `turn.failed` cascade. A hook
 *    that throws would break the very agent it is trying to observe. (Channel adapter handlers
 *    swallow; hooks do the opposite — the asymmetry is the trap.)
 *  - it never awaits its own network call, so a slow or unreachable control plane adds ZERO
 *    latency to a turn and can never wedge one; delivery is best-effort and ordered by a promise
 *    chain, so a late `running` report cannot overtake the settled one;
 *  - no-ops entirely when `HARNESST_RUNS_URL` / `HARNESST_TEAM_TOKEN` are unset, so a harnesst-built
 *    image still runs anywhere;
 *  - the buffer is bounded in events AND bytes, and is dropped when its turn settles.
 *
 * The source is deliberately plain JavaScript in a `.ts` file (same as the ask-teammate tool): it
 * is compiled by eve's bundler, and staying syntax-compatible with JS keeps it evaluable in a
 * unit test without a TypeScript pass.
 *
 * The hook holds almost no business logic: it forwards raw events and the control plane decides
 * what is a run. It makes exactly ONE judgement, and only to suppress work — an `http`-homed
 * turn is dropped at the door. That is not policy the control plane could move later: harnesst
 * records those turns in-process and `ingestPushedTurn` discards them unconditionally, so
 * reporting them meant every playground and assistant turn uploading its whole transcript
 * several times over (the buffer is resent whole on each of seven flush events) to be parsed and
 * thrown away. Every other kind — including an absent or unrecognised one — is still reported,
 * so a classifier fix still ships with a control-plane deploy rather than a rebuild of every
 * agent image.
 */

/** Repo-relative path the hook is written to inside an agent's build context. */
export const HARNESST_RUN_HOOK_PATH = "agent/hooks/harnesst-runs.ts";

/** The full source text of the generated hook file. */
export const HARNESST_RUN_HOOK_SOURCE = `// @ts-nocheck -- generated, plain JS: harnesst injects this into EVERY agent image, and some repos
// run \`tsc\` as part of their build script. A harnesst-owned file must never be able to fail a
// user's publish check (the handler's parameters are untyped by design, since eve's event union
// is not narrowed here).
import { defineHook } from "eve/hooks";

// harnesst bakes this file into every agent image (see app/observability/run-hook-template.ts).
// It reports each turn's raw event list to the control plane so the Runs tab can show work that
// happened on a channel (a GitHub issue, Discord, a schedule) rather than in the playground. All
// variability arrives via env — do not edit; a repo file at this path overrides it.

/** Hard caps so a pathological turn can never grow the buffer without bound. */
var MAX_EVENTS = 2000;
var MAX_BYTES = 1000000;
/** How many buffered turns to keep at once (a turn is normally dropped the moment it settles). */
var MAX_TURNS = 32;
/** Head kept when a turn overflows — the MIDDLE is what gets dropped, never the outcome. */
var KEEP_HEAD = 200;

/**
 * The ONE classification the hook makes, and it only ever suppresses work: an \`http\`-homed turn
 * is playground/assistant/teammate traffic that harnesst already records in-process, so the
 * control plane discards it — after reading and JSON-parsing a body that can reach megabytes.
 * Every HTTP turn flushes several times, so reporting them meant uploading each transcript
 * several times over to be thrown away. Nothing else is judged here: an unrecognised or absent
 * kind is still reported, so the control plane stays the only place channel policy lives.
 */
function isDiscardedKind(kind) {
  var k = String(kind || "").trim();
  if (k.indexOf("channel:") === 0) k = k.slice("channel:".length).trim();
  return k === "http";
}

/** Events worth reporting on. Everything else only appends to the buffer. */
var FLUSH_ON = [
  "turn.started",
  "message.received",
  "input.requested",
  "session.waiting",
  "turn.completed",
  "turn.failed",
  "session.failed",
];
/** After these the turn is over: flush, then forget it. */
var FINAL_ON = ["turn.completed", "turn.failed", "session.failed"];

/** turnKey -> buffer. Module scope: one instance per agent process, shared across sessions. */
var turns = new Map();
/** sessionId -> runtime model id, sticky (session.started fires only on a session's first turn). */
var models = new Map();
/** Serializes the POSTs so a late "running" report can never overtake the settled one. */
var chain = Promise.resolve();

function endpoint() {
  var url = process.env.HARNESST_RUNS_URL;
  var token = process.env.HARNESST_TEAM_TOKEN;
  if (!url || !token) return null;
  return { url: String(url).replace(/\\/+$/, ""), token: String(token) };
}

function timeoutMs() {
  var raw = Number(process.env.HARNESST_RUNS_TIMEOUT_MS || "10000");
  return Number.isFinite(raw) && raw > 0 ? raw : 10000;
}

/** Approximate serialized size of one event — cheap, and good enough to bound the buffer. */
function sizeOf(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Drop from the MIDDLE so the turn keeps both its opening and its outcome. */
function trim(buffer) {
  while (
    buffer.events.length > MAX_EVENTS ||
    (buffer.bytes > MAX_BYTES && buffer.events.length > KEEP_HEAD + 1)
  ) {
    var index = buffer.events.length > KEEP_HEAD ? KEEP_HEAD : 0;
    var dropped = buffer.events.splice(index, 1)[0];
    buffer.bytes -= sizeOf(dropped);
    buffer.truncated = true;
  }
}

/** Forget every buffered turn of this session except the live one — a new turn ends the old. */
function evict(sessionId, keepKey) {
  var keys = Array.from(turns.keys());
  for (var i = 0; i < keys.length; i++) {
    var held = turns.get(keys[i]);
    if (keys[i] !== keepKey && held && held.sessionId === sessionId) turns.delete(keys[i]);
  }
  while (turns.size > MAX_TURNS) {
    var oldest = turns.keys().next();
    if (oldest.done) break;
    turns.delete(oldest.value);
  }
}

function post(target, body) {
  return fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + target.token,
      // Declared up front so the control plane can reject a turn it would discard without
      // reading the body at all.
      "x-harnesst-channel-kind": String(body.channelKind || ""),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs()),
  }).then(function (res) {
    // Drain the body so the socket is released; the response is not otherwise interesting.
    return res.text().then(
      function () {},
      function () {},
    );
  });
}

export default defineHook({
  events: {
    // ONE wildcard subscriber: the control plane needs the whole turn, so per-type handlers would
    // buy nothing — and one body means exactly one place that must not throw.
    "*": (event, ctx) => {
      try {
        var target = endpoint();
        if (!target) return;

        var session = ctx && ctx.session ? ctx.session : null;
        var sessionId = session && typeof session.id === "string" ? session.id : "";
        var turn = session && session.turn ? session.turn : null;
        var turnId = turn && typeof turn.id === "string" ? turn.id : "";
        if (!sessionId || !turnId) return;

        var channelKind =
          ctx && ctx.channel && typeof ctx.channel.kind === "string" ? ctx.channel.kind : null;
        // Before the buffer, not just before the POST: an http-homed turn should cost this
        // process no memory either.
        if (isDiscardedKind(channelKind)) return;

        // Read the event through an untyped alias: the runtime event is a union and some members
        // (session.completed) carry no \`data\` at all.
        var raw = Object(event);
        var type = typeof raw.type === "string" ? raw.type : "";
        if (!type) return;
        var data = raw.data && typeof raw.data === "object" ? raw.data : {};

        // session.started carries the runtime model id, and only on a session's first turn.
        if (type === "session.started") {
          var runtime = data.runtime;
          if (runtime && typeof runtime.modelId === "string") {
            models.set(sessionId, runtime.modelId);
            while (models.size > MAX_TURNS) {
              var stale = models.keys().next();
              if (stale.done) break;
              models.delete(stale.value);
            }
          }
        }

        var key = sessionId + "\\u0000" + turnId;
        var buffer = turns.get(key);
        if (!buffer) {
          buffer = {
            sessionId: sessionId,
            turnId: turnId,
            events: [],
            bytes: 0,
            truncated: false,
          };
          turns.set(key, buffer);
          evict(sessionId, key);
        }

        // Stamp turnId and a timestamp so the control-plane fold can group and order events even
        // for the session-scoped ones (session.waiting / session.failed carry neither).
        var meta = raw.meta && typeof raw.meta === "object" ? raw.meta : null;
        var at = meta && typeof meta.at === "string" ? meta.at : new Date().toISOString();
        var forwarded = {
          type: type,
          data: Object.assign({}, data, { turnId: data.turnId || turnId }),
          meta: { at: at },
        };
        buffer.events.push(forwarded);
        buffer.bytes += sizeOf(forwarded);
        trim(buffer);

        if (FLUSH_ON.indexOf(type) < 0) return;
        var isFinal = FINAL_ON.indexOf(type) >= 0;
        var payload = {
          sessionId: sessionId,
          turnId: turnId,
          turnSequence: turn && typeof turn.sequence === "number" ? turn.sequence : null,
          channelKind: channelKind,
          modelId: models.get(sessionId) || null,
          agentName: ctx && ctx.agent && typeof ctx.agent.name === "string" ? ctx.agent.name : null,
          final: isFinal,
          truncated: buffer.truncated,
          // The COMPLETE list for this turn, resent whole on every flush. A tail-only batch would
          // truncate an already-recorded transcript, because the control plane replaces a run's
          // steps wholesale on each ingest.
          events: buffer.events.slice(),
        };
        // A settled turn is done, but its SESSION is not: a channel thread runs many turns and
        // session.started (the only carrier of the model id) fired on the first one. Keep the
        // model, drop the buffer.
        if (isFinal) turns.delete(key);

        // Fire and forget, ordered. Never awaited: reporting a run must not add latency to the
        // turn it reports on, and must never be able to fail it.
        chain = chain.then(function () {
          return post(target, payload).then(
            function () {},
            function () {},
          );
        });
      } catch {
        // Never rethrow: eve propagates hook errors into the recoverable turn.failed cascade.
      }
    },
  },
});
`;
