/**
 * Teammate delegation relay (Team delegation — D1/§2). A team member's `ask-teammate` or
 * `tell-teammate` tool POSTs `{ teammate, message, mode }` here with its `HARNESST_TEAM_TOKEN`;
 * the route verifies the token to a deployment id and hands that plus the body to `runAsk`.
 * `mode: "ask"` blocks until the peer's turn settles; `mode: "tell"` (#269) dispatches the turn
 * and returns immediately, leaving settlement to the #267 reattach watcher — same resolution,
 * authorization, caps and wake either way. Everything else — caller resolution,
 * authorization, concurrency caps, target env/deployment resolution, the eve turn, run recording,
 * and the correlation row — lives here so the flow is unit-testable against an injected store +
 * `sendTurn` + recorders, with zero I/O.
 *
 * Business failures the model should read (no permission, no reachable peer, caps hit) come back
 * as `{ ok: false, error }` — the ROUTE returns those with HTTP 200 so the tool surfaces the
 * text. Only a bad token is a 401, and that check is the route's. A peer that parks on a human
 * question is NOT a failure (Front of House §5 relay parking): the delegation flips `waiting`,
 * an agent-opened FOH session adopts the peer's eve handles, and the caller gets a structured
 * `waiting_on_human` result — also on the 200 path.
 */
import type { DispatchResult, TurnResult } from "~/agent/talk.server";
import { dispatchTurn, sendTurn } from "~/agent/talk.server";
import type { Target } from "~/chat/playground.server";
import type { DataStore, DeploymentWithRelease } from "~/data/ports";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import { openInboxQuestion } from "~/foh/inbox.server";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import { getRunIdByExternal } from "~/observability/store.server";
import type { PlaygroundSession } from "~/playground/sessions.server";
import {
  createPlaygroundSession,
  titleFromMessage,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";
import {
  DELEGATION_REATTACH_CEILING_MS,
  scheduleDelegationReattach,
} from "./reattach.server";

/** Default relay/peer-turn budget; the tool's fetch adds 60s of slack on top. */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 600_000;
/** Slack added to the timeout when deciding whether a `running` row is stale (crash guard). */
const STALE_SLACK_MS = 60_000;
/** Max active delegations on one directed edge, and across a whole project. */
const EDGE_CAP = 3;
const PROJECT_CAP = 10;
/** Reject messages larger than this (bytes) before opening a peer session. */
const MAX_MESSAGE_BYTES = 100_000;

export function delegationTimeoutMs(): number {
  const raw = Number(process.env.HARNESST_DELEGATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DELEGATION_TIMEOUT_MS;
}

export interface AskDeps {
  store: DataStore;
  /** eve client (blocking) — injected so tests need no running instance. */
  sendTurn: typeof sendTurn;
  /** eve client (fire-and-forget, #269) — posts the turn and returns without draining it. */
  dispatchTurn: typeof dispatchTurn;
  recordStart: typeof recordTurnStart;
  recordFinish: typeof recordTurnFinish;
  resolveRunId: (
    projectId: string,
    externalRunId: string,
  ) => Promise<string | null>;
  /** Wake a stopped peer (scale-to-zero) — injected so tests fake the container start. */
  ensureLiveDeployment: (
    environmentId: string,
  ) => Promise<DeploymentWithRelease | null>;
  /** FOH session substrate for relay parking (D6/D8) — injected: unit tests stay zero-I/O. */
  createSession: typeof createPlaygroundSession;
  /** #267: hand a severed-stream turn to the background reattach watcher. */
  scheduleReattach: typeof scheduleDelegationReattach;
  now: () => Date;
  timeoutMs: number;
}

export function defaultAskDeps(): AskDeps {
  return {
    store: getRuntime().data,
    sendTurn,
    dispatchTurn,
    recordStart: recordTurnStart,
    recordFinish: recordTurnFinish,
    resolveRunId: getRunIdByExternal,
    ensureLiveDeployment: (environmentId) =>
      ensureLiveDeploymentForEnvironment(environmentId),
    createSession: createPlaygroundSession,
    scheduleReattach: scheduleDelegationReattach,
    now: () => new Date(),
    timeoutMs: delegationTimeoutMs(),
  };
}

export interface AskInput {
  /** The caller deployment id the token authenticated (route-verified). */
  deploymentId: string;
  teammate: string;
  message: string;
  /**
   * How the caller wants the delegation to run (#269). `ask` (the default) blocks until the
   * peer's turn settles; `tell` returns as soon as the turn is dispatched and leaves the
   * settlement to the background reattach watcher. Everything up to the dispatch — resolution,
   * authorization, caps, wake — is identical.
   */
  mode?: "ask" | "tell";
}

export type AskResult =
  | {
      ok: true;
      reply: string | null;
      teammate: string;
      sessionId: string | null;
      runId: string | null;
      runPath: string | null;
    }
  /**
   * The peer parked on a human question (§5 relay parking). The delegation stays open
   * (`waiting`) and resumes on its own when a human answers in harnesst — the caller should NOT
   * re-ask. Rides the same HTTP 200 path as every business outcome.
   */
  | {
      ok: true;
      status: "waiting_on_human";
      teammate: string;
      question: string;
      note: string;
    }
  /**
   * #267: harnesst lost the reply stream, NOT the turn. The peer is still working inside its
   * container; the delegation stays open and a background watcher finishes the bookkeeping.
   * Telling the caller "failed" here was the third defect in the issue — it is a lie, and it
   * invites the model to re-do work that is already in flight.
   */
  | {
      ok: true;
      status: "handed_off";
      teammate: string;
      note: string;
      runId: string | null;
      runPath: string | null;
    }
  /**
   * #269 `tell` mode: the peer's turn is dispatched and running — that is the whole promise.
   * The reply goes nowhere by design (who a peer reports to is its own instruction-level
   * policy); the run records how it ends. The note tells the calling model not to wait for or
   * invent a result.
   */
  | {
      ok: true;
      status: "dispatched";
      teammate: string;
      note: string;
      delegationId: string;
      runId: string | null;
      runPath: string | null;
    }
  | { ok: false; error: string };

function deny(error: string): AskResult {
  return { ok: false, error };
}

/** The peer member's run path (teams only reach the relay, so this is always member-scoped). */
function runPathFor(
  projectId: string,
  agentName: string,
  runId: string,
): string {
  return `/repos/${projectId}/agents/${encodeURIComponent(agentName)}/runs/${runId}`;
}

export async function runAsk(
  input: AskInput,
  deps: AskDeps,
): Promise<AskResult> {
  const { store } = deps;

  const teammate = input.teammate?.trim();
  const message = input.message ?? "";
  if (!teammate) return deny("Name the teammate to ask.");
  if (!message.trim()) return deny("The message to your teammate is empty.");
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    return deny(
      "Your message is too long — keep a delegated request under 100KB.",
    );
  }

  // 1. Resolve the caller from the token's deployment: deployment → env → agent → project.
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment)
    return deny("Your deployment is no longer known to harnesst.");
  const callerEnv = await store.environments.findById(deployment.environmentId);
  if (!callerEnv)
    return deny("Your environment is no longer known to harnesst.");
  const caller = await store.agents.findById(callerEnv.agentId);
  if (!caller) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(caller.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // 2. Resolve the target member by (project, name). Only real roster members are delegation
  //    targets — the built-in assistant (kind !== 'member') is never a teammate.
  const roster = (await store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  const target = roster.find((a) => a.name === teammate);
  if (!target) return deny(`No teammate named "${teammate}" is on this team.`);
  if (target.id === caller.id)
    return deny("You can't delegate a task to yourself.");

  // 3. Authorization — default-allow: only a disabled override row blocks the ask.
  const link = await store.agentLinks.get(caller.id, target.id);
  if (link && !link.enabled) {
    return deny(
      `You're not permitted to ask "${teammate}". Ask a human to enable it in Settings.`,
    );
  }

  // 4. Concurrency caps — count only `running` rows younger than the timeout (+ slack), so a
  //    crashed relay can never wedge the caps.
  const since = new Date(
    deps.now().getTime() - (deps.timeoutMs + STALE_SLACK_MS),
  );
  const [edgeActive, projectActive] = await Promise.all([
    store.delegations.countActiveEdge(caller.id, target.id, since),
    store.delegations.countActiveProject(project.id, since),
  ]);
  if (edgeActive >= EDGE_CAP) {
    return deny(
      `Too many in-flight asks to "${teammate}" already — wait for one to finish.`,
    );
  }
  if (projectActive >= PROJECT_CAP) {
    return deny(
      "This team already has too many delegations in flight — try again shortly.",
    );
  }

  // 5. Target env = the peer's environment with the SAME NAME as the caller's (ship-fan-out
  //    convention). 6. It must have a live deployment with a reachable url — or a `stopped`
  //    one we can wake (§5 wake-on-delegation: a scaled-to-zero peer is started, not denied).
  const targetEnvs = await store.environments.listByAgent(target.id);
  const targetEnv = targetEnvs.find((e) => e.name === callerEnv.name);
  if (!targetEnv) {
    return deny(
      `"${teammate}" has no "${callerEnv.name}" environment to reach — its environments differ from yours.`,
    );
  }
  const targetDeployments = await store.deployments.listByEnvironment(
    targetEnv.id,
  );
  const recoverable = targetDeployments.some(
    (d) => d.status === "live" || d.status === "stopped",
  );
  if (!recoverable) {
    const everDeployed = targetDeployments.length > 0;
    return deny(
      everDeployed
        ? `"${teammate}" has no live deployment in "${callerEnv.name}" right now — it needs to be deployed and running.`
        : `"${teammate}" has never been deployed to "${callerEnv.name}" — deploy it before delegating.`,
    );
  }
  // Even a persisted live row may point at a container lost in a host restart.
  const live = await deps.ensureLiveDeployment(targetEnv.id).catch(() => null);
  if (!live || !live.url) {
    return deny(
      `"${teammate}" is stopped in "${callerEnv.name}" and couldn't be woken — try again shortly.`,
    );
  }

  // 7. Open the correlation record (running), then run the peer turn.
  const delegation = await store.delegations.insert({
    projectId: project.id,
    fromAgentId: caller.id,
    fromEnvironmentId: callerEnv.id,
    toAgentId: target.id,
    toEnvironmentId: targetEnv.id,
  });

  const prefixed = `From your teammate "${caller.name}": ${message}`;
  const startedAt = deps.now();

  const runMeta = {
    delegationId: delegation.id,
    fromAgentId: caller.id,
    fromAgentName: caller.name,
  };

  /** The peer's live handles — shared by relay parking (§9b), the #267 hand-off, and tell. */
  const peerTarget: Target = {
    deploymentId: live.id,
    environmentId: targetEnv.id,
    releaseId: live.releaseId,
    url: live.url,
    version: live.version,
    environmentName: targetEnv.name,
    gitSha: live.gitSha,
  };

  // 8-tell (#269). A tell is a hand-off BY CONSTRUCTION: dispatch the turn, then run the exact
  // machinery the #267 severed-stream path runs — record the run `running`, adopt the peer
  // session into an agent-opened FOH row, enqueue the reattach watcher that drains the turn to
  // settlement in the background — and return. The delegation row stays `running`, so the
  // caps bound fire-and-forget spam exactly as they bound asks.
  if (input.mode === "tell") {
    return runTell(
      {
        delegationId: delegation.id,
        projectId: project.id,
        callerName: caller.name,
        target: { id: target.id, name: target.name },
        peerTarget,
        prefixed,
        runMeta,
        startedAt,
      },
      deps,
    );
  }

  let result: TurnResult;
  try {
    result = await deps.sendTurn({
      baseUrl: live.url,
      message: prefixed,
      timeoutMs: deps.timeoutMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error: detail,
    });
    return deny(`Couldn't reach "${teammate}": ${detail}`);
  }

  // #267: a lost reply stream is a TRANSPORT failure — the turn is still running inside the
  //   container. `streamLost` is a typed discriminator set at the three transport sites in
  //   talk.server.ts (never matched from the error text), and it only leads anywhere when eve
  //   handed us a session id to resume from.
  const handingOff = result.streamLost === true && Boolean(result.sessionId);

  // 8. Record the peer's run (channel "teammate", linked-trace metadata). Best-effort — a
  //    recording hiccup must not lose the reply.
  let runId: string | null = null;
  /**
   * The deferred finish for a handed-off turn. On the hand-off path the run row stays `running`
   * (which is TRUE — the turn is) and the reattach watcher settles it with the real outcome; but
   * if the hand-off machinery itself fails below, the ask really does end here, so the run must
   * be settled with the transport error rather than left running forever.
   */
  let finishRun: (() => Promise<void>) | null = null;
  if (result.sessionId && result.turnId) {
    const runExternalId = externalRunId(result.sessionId, result.turnId);
    const settled = result;
    const finish = async () => {
      await deps.recordFinish({
        projectId: project.id,
        deploymentId: live.id,
        releaseId: live.releaseId,
        externalRunId: runExternalId,
        externalSessionId: settled.sessionId!,
        result: settled,
        userMessage: prefixed,
        channel: "teammate",
        metadata: runMeta,
        startedAt,
        wallClockMs: deps.now().getTime() - startedAt.getTime(),
      });
    };
    try {
      await deps.recordStart(
        {
          projectId: project.id,
          deploymentId: live.id,
          releaseId: live.releaseId,
          externalRunId: runExternalId,
          externalSessionId: result.sessionId,
          userMessage: prefixed,
          channel: "teammate",
          metadata: runMeta,
        },
        startedAt,
      );
      if (handingOff) {
        finishRun = finish;
      } else {
        await finish();
      }
      runId = await deps.resolveRunId(project.id, runExternalId);
    } catch (error) {
      console.error("[team] recording delegated run failed:", error);
    }
  }

  const runPath = runId ? runPathFor(project.id, target.name, runId) : null;

  // 9. The severed stream (#267) — checked BEFORE the failure branch below, because a lost
  //    stream is not a failed turn. harnesst stopped watching it; the peer did not stop
  //    running it. Adopt the peer session into an agent-opened FOH row — the SAME machinery §9b
  //    uses, so a question the peer asks minutes from now has a surface to land on — leave the
  //    delegation `running`, and enqueue the watcher that resumes the stream, drains it to
  //    settlement, files any `input.requested` into the inbox, and finalizes delegation + run
  //    with the true outcome. The calling model is told exactly that.
  if (handingOff && result.sessionId) {
    try {
      const session = await deps.createSession({
        projectId: project.id,
        agentId: target.id,
        userId: null,
        surface: "foh",
        environmentId: targetEnv.id,
        version: live.version,
        // D6: never the delegated ask text — it can carry the caller's private context and the
        // list title is visible to every team member. Nothing has been said yet to title this by.
        title: `Delegated task from "${caller.name}"`,
        openedByAgentId: target.id,
        delegationId: delegation.id,
        externalSessionId: result.sessionId,
        continuationToken: result.continuationToken,
        streamIndex: result.streamIndex,
        // Honest: the turn IS running. The watcher bumps this row every poll so the abandoned-
        // session sweep doesn't mistake a long silent tool call for a dead drain.
        status: "running",
        lastEventAt: deps.now(),
      });
      await deps.scheduleReattach(store, {
        sessionId: session.id,
        delegationId: delegation.id,
        projectId: project.id,
        turnId: result.turnId,
        userMessage: prefixed,
        metadata: runMeta,
        startedAt: startedAt.toISOString(),
        // Anchored HERE, at the hand-off — not at the turn's start. The relay has already spent
        // its whole idle budget by this point, and a turn that streamed happily for longer than
        // the ceiling before dropping would otherwise be born already expired.
        deadlineAt: new Date(
          deps.now().getTime() + DELEGATION_REATTACH_CEILING_MS,
        ).toISOString(),
      });
      return {
        ok: true,
        status: "handed_off",
        teammate: target.name,
        note: `The reply stream from "${target.name}" dropped, but the task was handed over and their turn is still running. harnesst is watching it: if they need a human they will ask one, and the run below records how it ends. Do NOT re-ask or redo this work.`,
        runId,
        runPath,
      };
    } catch (error) {
      // The hand-off machinery failed — without a session row and a watcher, nothing would ever
      // settle this delegation, so fall through to the pre-#267 behavior: report the failure.
      console.error("[team] delegation hand-off failed:", error);
      if (finishRun) {
        await finishRun().catch((e) =>
          console.error("[team] recording delegated run failed:", e),
        );
      }
    }
  }

  // 9a. The peer turn failed outright — settle the row and surface the error.
  if (!result.ok) {
    const error =
      result.error ?? `"${teammate}" couldn't complete the request.`;
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error,
      externalSessionId: result.sessionId,
      runId,
    });
    return deny(error);
  }

  // 9b. Relay parking (§5): the peer stopped to ask a human. No longer a failure — flip the
  //     delegation `waiting` (it exits the concurrency caps by construction: caps count only
  //     `running` — D7), open an agent-opened FOH session over the SAME eve session (real
  //     handles, so the ordinary FOH continuation send resumes the peer — never a second eve
  //     stream consumer; the transcript renders from eve's durable stream), file the team-wide
  //     inbox item (D5), and hand the calling model a structured waiting result. Matches the drain's park rule
  //     (settleFohTurn): assistant text before the ask does NOT negate the park — eve still
  //     holds the request.
  if (result.inputRequests.length > 0 && result.sessionId) {
    const question = result.inputRequests[0].prompt;
    try {
      await store.delegations.finalize(delegation.id, {
        status: "waiting",
        externalSessionId: result.sessionId,
        runId,
      });
      const session = await deps.createSession({
        projectId: project.id,
        agentId: target.id,
        userId: null,
        surface: "foh",
        environmentId: targetEnv.id,
        version: live.version,
        // D6: title from the QUESTION, never from the delegated ask text — the ask can carry
        // the caller's private context, and the list title leaks to every team member.
        title: titleFromMessage(question),
        openedByAgentId: target.id,
        delegationId: delegation.id,
        externalSessionId: result.sessionId,
        continuationToken: result.continuationToken,
        streamIndex: result.streamIndex,
        status: "waiting",
        pendingInputAt: deps.now(),
        lastEventAt: deps.now(),
      });
      for (const request of result.inputRequests) {
        await openInboxQuestion(
          {
            projectId: project.id,
            sessionId: session.id,
            agentId: target.id,
            userId: null,
            delegationId: delegation.id,
            runId,
            request,
          },
          store,
        );
      }
      return {
        ok: true,
        status: "waiting_on_human",
        teammate: target.name,
        question,
        note: "The delegation is parked until a human answers in harnesst; it will resume and finish on its own — do not re-ask.",
      };
    } catch (error) {
      // The parking machinery failed — a `waiting` delegation nobody can answer would dangle
      // forever, so settle it failed and surface the question (the pre-parking behavior).
      console.error("[team] relay parking failed:", error);
      const detail = `"${teammate}" needs input to continue: ${question}`;
      await store.delegations
        .finalize(delegation.id, {
          status: "failed",
          error: detail,
          externalSessionId: result.sessionId,
          runId,
        })
        .catch(() => {});
      return deny(detail);
    }
  }

  // 9c. Parked but with NO session handle to resume on — nothing a human could answer into,
  //     so the M7 behavior stands: surface the request text as a failure.
  if (result.inputRequests.length > 0) {
    const error = `"${teammate}" needs input to continue: ${result.inputRequests[0].prompt}`;
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error,
      externalSessionId: result.sessionId,
      runId,
    });
    return deny(error);
  }

  // 9d. A turn that settled "ok" with NO reply is a failure: a "successful" delegation with
  //     nothing in it would only confuse the calling model.
  if (!result.reply || !result.reply.trim()) {
    const error = `"${teammate}" finished without a reply.`;
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error,
      externalSessionId: result.sessionId,
      runId,
    });
    return deny(error);
  }

  await store.delegations.finalize(delegation.id, {
    status: "completed",
    externalSessionId: result.sessionId,
    runId,
  });

  return {
    ok: true,
    reply: result.reply,
    teammate: target.name,
    sessionId: result.sessionId,
    runId,
    runPath,
  };
}

/** Everything `runTell` needs, all resolved by the shared front half of `runAsk`. */
interface TellContext {
  delegationId: string;
  projectId: string;
  callerName: string;
  target: { id: string; name: string };
  peerTarget: Target;
  /** The provenance-prefixed message, exactly as the ask path sends it. */
  prefixed: string;
  runMeta: Record<string, unknown>;
  startedAt: Date;
}

/**
 * The fire-and-forget back half (#269). Dispatch the peer's turn, then run the same adoption the
 * #267 severed-stream hand-off runs — run row `running`, agent-opened FOH session over the peer's
 * eve handles, reattach watcher enqueued — and return to the caller in seconds. The watcher owns
 * settlement from here: it drains the turn in the background, files any `input.requested` into
 * the inbox, and finalizes the delegation and run with the true outcome. The peer's reply goes
 * nowhere by design — who a peer reports to on completion is that agent's instruction-level
 * policy, not a platform convention.
 */
async function runTell(ctx: TellContext, deps: AskDeps): Promise<AskResult> {
  const { store } = deps;

  // The POST is the hand-off. `dispatchTurn` never throws; no session id means the message was
  // never accepted, so this really is a failure to reach the peer — nothing is running.
  const dispatched: DispatchResult = await deps.dispatchTurn({
    baseUrl: ctx.peerTarget.url,
    message: ctx.prefixed,
  });
  if (!dispatched.sessionId) {
    const detail =
      dispatched.error ?? "The teammate did not accept the message.";
    await store.delegations.finalize(ctx.delegationId, {
      status: "failed",
      error: detail,
    });
    return deny(`Couldn't reach "${ctx.target.name}": ${detail}`);
  }

  // Arm the watcher FIRST — before any best-effort bookkeeping. The dispatch above put the turn
  // beyond recall, and until the reattach job is enqueued a control-plane crash would orphan the
  // delegation with nobody watching; every await between the POST and the enqueue widens that
  // window, so the run recording waits until the hand-off is durable.
  let session: PlaygroundSession;
  try {
    session = await deps.createSession({
      projectId: ctx.projectId,
      agentId: ctx.target.id,
      userId: null,
      surface: "foh",
      environmentId: ctx.peerTarget.environmentId,
      version: ctx.peerTarget.version,
      // D6: never the delegated ask text — it can carry the caller's private context and the
      // list title is visible to every team member.
      title: `Delegated task from "${ctx.callerName}"`,
      openedByAgentId: ctx.target.id,
      delegationId: ctx.delegationId,
      externalSessionId: dispatched.sessionId,
      continuationToken: dispatched.continuationToken,
      streamIndex: dispatched.streamIndex,
      // Honest: the turn IS running. The watcher bumps this row every poll so the abandoned-
      // session sweep doesn't mistake a long silent tool call for a dead drain.
      status: "running",
      lastEventAt: deps.now(),
    });
    await deps.scheduleReattach(store, {
      sessionId: session.id,
      delegationId: ctx.delegationId,
      projectId: ctx.projectId,
      turnId: dispatched.turnId,
      userMessage: ctx.prefixed,
      metadata: ctx.runMeta,
      startedAt: ctx.startedAt.toISOString(),
      // Anchored at the dispatch — for a tell that IS the turn's start, so the watcher's
      // ceiling bounds the whole background task.
      deadlineAt: new Date(
        deps.now().getTime() + DELEGATION_REATTACH_CEILING_MS,
      ).toISOString(),
    });
  } catch (error) {
    // The tracking machinery failed. The turn itself is beyond recall — the peer is running it —
    // but with no watcher nothing would ever settle the delegation, so close it honestly and
    // tell the caller exactly what is and isn't known. (A session row created before the
    // failure is recovered by the abandoned-session sweep — it stops being bumped.)
    console.error("[team] delegation dispatch hand-off failed:", error);
    const detail = `The task reached "${ctx.target.name}", but harnesst couldn't set up tracking for it, so its outcome won't be recorded. Do not blindly re-send — the teammate may still be doing the work.`;
    await store.delegations.finalize(ctx.delegationId, {
      status: "failed",
      error: detail,
      externalSessionId: dispatched.sessionId,
    });
    return deny(detail);
  }

  // Best-effort from here — the hand-off is durable, so nothing below may cost it. Record the
  // run `running` when the dispatch watch caught the turn id (it almost always does — eve echoes
  // `message.received` in the first event batch); without one there is no external run id yet,
  // and the reattach settle records the run from the turn id it discovers instead.
  let runId: string | null = null;
  if (dispatched.turnId) {
    try {
      await deps.recordStart(
        {
          projectId: ctx.projectId,
          deploymentId: ctx.peerTarget.deploymentId,
          releaseId: ctx.peerTarget.releaseId,
          externalRunId: externalRunId(dispatched.sessionId, dispatched.turnId),
          externalSessionId: dispatched.sessionId,
          userMessage: ctx.prefixed,
          channel: "teammate",
          metadata: ctx.runMeta,
        },
        ctx.startedAt,
      );
      runId = await deps.resolveRunId(
        ctx.projectId,
        externalRunId(dispatched.sessionId, dispatched.turnId),
      );
    } catch (error) {
      console.error("[team] recording delegated run failed:", error);
    }
  }
  const runPath = runId
    ? runPathFor(ctx.projectId, ctx.target.name, runId)
    : null;

  return {
    ok: true,
    status: "dispatched",
    teammate: ctx.target.name,
    note: `"${ctx.target.name}" has the task and is working on it now. This was a hand-off: you will not receive their reply — ${
      runPath ? "the run below" : "their runs page"
    } records how it ends, and if they need a human they will ask one. Report the hand-off and move on; do NOT wait for or invent a result.`,
    delegationId: ctx.delegationId,
    runId,
    runPath,
  };
}
