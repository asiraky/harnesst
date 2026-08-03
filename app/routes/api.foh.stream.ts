/**
 * FOH streaming turn (resource route, action only) — the front-of-house sibling of the
 * playground stream route (D20 copy, not a shared refactor). Differences from the playground:
 * the guard is FOH scope (`requireFohProject`, never the BOH-gated `requireProject`), the
 * agent travels as `agentId` (D14 URLs are id-based), a scaled-to-zero agent is WOKEN instead
 * of rejected (§6: opening a session with a stopped agent wakes it), and the supersede rule
 * runs before the turn (`beginFohTurn`: a new message resolves any parked question — eve
 * answers from the next message, so stale inbox items must not linger, D13). Channel-homed
 * rows split by payload: an answer to a pending ask delivers through the channel answer
 * route; free text succeeds the session into a fresh HTTP-homed one (#288 3b).
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import type { ChatInputAnswer } from "~/chat/types";

import { liveTargets, type Target } from "~/chat/playground.server";
import { buildSystemNotes } from "~/chat/system-note";
import {
  asString,
  streamTurnResponse,
  TURN_IDLE_TIMEOUT_MS,
} from "~/chat/turn-stream.server";
import { listAgentEnvironments } from "~/db/queries.server";
import { isSessionWorkspaceContinuationToken } from "~/deploy/session-workspace-channel";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import { beginFohTurn } from "~/foh/inbox.server";
import { requireFohProject } from "~/foh/guard.server";
import { inferFohSessionTitle } from "~/foh/session-title.server";
import { signModelDirective } from "~/models/model-directive.server";
import { parseRequestedModelSelection } from "~/models/playground-selection";
import { type ReasoningEffort } from "~/models/reasoning";
import {
  findWorkspaceModel,
  ownsWorkspaceModelReference,
} from "~/models/union.server";
import {
  buildNoticeSeedContext,
  buildSeedContext,
  SUCCESSION_INSTRUCTION,
} from "~/playground/seed";
import {
  claimPlaygroundSessionForTurn,
  createPlaygroundSession,
  getFohSessionForViewer,
  loadPlaygroundEntriesFromEve,
  setPlaygroundSessionModel,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/**
 * Overall budget for reading the OLD session's transcript out of eve before a succession.
 * Bounded because the read sits on the send path and eve hangs (never 404s) on session ids
 * it does not know; the connect phase is capped tighter inside `readEveSessionEvents`.
 */
const SUCCESSION_PROLOGUE_TIMEOUT_MS = 5_000;

/**
 * Prologue read cap for a channel row whose park-time cursor heal never ran (streamIndex
 * still 0): a zero cursor means "nobody counted yet", not "the old session is empty", so
 * the read caps by event count instead of trusting it.
 */
const SUCCESSION_PROLOGUE_EVENT_CAP = 1_000;

/**
 * Parse the optional request-correlated answer payload (issue #221 finding 2): a JSON array
 * of eve `InputResponse`s ({requestId, optionId?|text?}) from the clicked question/approval
 * card. Malformed input is a hard 400 — silently dropping it would fall back to eve's
 * batch-wide text resolution, the exact bug this field exists to prevent.
 */
function parseInputResponses(raw: string): ChatInputAnswer[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw data({ error: "Malformed input responses." }, { status: 400 });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(
      (entry): entry is ChatInputAnswer =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ChatInputAnswer).requestId === "string" &&
        (entry as ChatInputAnswer).requestId.length > 0 &&
        ((entry as ChatInputAnswer).optionId === undefined ||
          typeof (entry as ChatInputAnswer).optionId === "string") &&
        ((entry as ChatInputAnswer).text === undefined ||
          typeof (entry as ChatInputAnswer).text === "string"),
    )
  ) {
    throw data({ error: "Malformed input responses." }, { status: 400 });
  }
  return parsed.map((entry) => ({
    requestId: entry.requestId,
    ...(entry.optionId !== undefined ? { optionId: entry.optionId } : {}),
    ...(entry.text !== undefined ? { text: entry.text } : {}),
  }));
}

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);
  const project = access.project;

  const form = await args.request.formData();
  const agentId = asString(form.get("agentId"));
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;
  const inputResponses = parseInputResponses(
    asString(form.get("inputResponses")),
  );

  const agent = agentId
    ? await getRuntime().data.agents.findById(agentId)
    : null;
  if (!agent || agent.projectId !== project.id || agent.kind !== "member") {
    throw data({ error: "That team member was not found." }, { status: 404 });
  }

  const selection = parseRequestedModelSelection({
    modelId: asString(form.get("modelId")),
    effort: asString(form.get("effort")),
  });
  if (!selection.ok) {
    throw data({ error: selection.error }, { status: 400 });
  }
  const requestedModelId = selection.modelId;
  const requestedEffort = selection.effort;
  const requestedModel = requestedModelId
    ? await findWorkspaceModel(project.orgId, requestedModelId)
    : null;
  if (requestedModelId && !requestedModel) {
    throw data(
      {
        error:
          "That model is not available from an active provider connection in this workspace.",
      },
      { status: 400 },
    );
  }
  if (
    requestedEffort &&
    !requestedModel?.supportedEfforts?.includes(requestedEffort)
  ) {
    throw data(
      {
        error: "That reasoning effort is not supported by the selected model.",
      },
      { status: 400 },
    );
  }

  let session: PlaygroundSession | null = playgroundSessionId
    ? await getFohSessionForViewer({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: agent.id,
        viewerId: auth.user.id,
        includeAll: access.backOfHouse,
      })
    : null;
  if (playgroundSessionId && !session) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }

  // Target resolution with wake-on-open. A BOUND session (externalSessionId set) lives in
  // exactly ONE environment's world store, so only a live deployment of that environment can
  // continue it — a cross-environment target never saw the session (and eve hangs, not 404s,
  // on unknown ids). When the home environment is asleep it is woken even while siblings are
  // live; when it can't be woken the send is refused, never rerouted (a foreign send would
  // fail the turn AND rebind the row away from its history). An unbound session (new,
  // post-notify, or cleared by the belt) can go anywhere: prefer whatever is live, else start
  // a stopped instance (session's environment first) and re-read the live targets — the
  // deployments row now carries the fresh url. Presence ○ agents are messageable by design.
  let targets = await liveTargets(agent.id);
  let target: Target | undefined;
  if (session?.externalSessionId) {
    const homeEnvironmentId = session.environmentId;
    target = targets.find((t) => t.environmentId === homeEnvironmentId);
    if (!target && homeEnvironmentId) {
      if (await ensureLiveDeploymentForEnvironment(homeEnvironmentId)) {
        targets = await liveTargets(agent.id);
        target = targets.find((t) => t.environmentId === homeEnvironmentId);
      }
    }
    if (!target) {
      throw data(
        {
          error: `This conversation's history lives in an environment of "${agent.name}" that harnesst couldn't reach or wake — it can't continue on a different one. Try again, or check the deployment in back of house.`,
        },
        { status: 409 },
      );
    }
  } else {
    if (targets.length === 0) {
      const environments = await listAgentEnvironments(agent.id);
      const ordered = session?.environmentId
        ? [
            session.environmentId,
            ...environments
              .map((env) => env.id)
              .filter((id) => id !== session?.environmentId),
          ]
        : environments.map((env) => env.id);
      for (const environmentId of ordered) {
        if (await ensureLiveDeploymentForEnvironment(environmentId)) break;
      }
      targets = await liveTargets(agent.id);
    }
    if (targets.length === 0) {
      throw data(
        {
          error: `"${agent.name}" has no deployment to talk to right now — deploy from back of house first.`,
        },
        { status: 400 },
      );
    }
    target =
      targets.find((t) => t.environmentId === session?.environmentId) ??
      targets[0];
  }

  const effectiveModel = requestedModelId ?? session?.modelId ?? null;
  const effectiveEffort = requestedModelId
    ? requestedEffort
    : ((session?.effort as ReasoningEffort | null) ?? null);
  const effectiveModelOwned = effectiveModel
    ? requestedModelId === effectiveModel
      ? Boolean(requestedModel)
      : await ownsWorkspaceModelReference(project.orgId, effectiveModel)
    : false;
  if (effectiveModel && !effectiveModelOwned) {
    throw data(
      {
        error:
          "This conversation's model is no longer available. Choose a model from an active provider connection.",
      },
      { status: 400 },
    );
  }

  const title = session?.title
    ? null
    : await inferFohSessionTitle({ message, project });
  const isNewSession = !session;
  if (!session) {
    session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: auth.user.id,
      surface: "foh",
      environmentId: target.environmentId,
      version: target.version,
      title,
      modelId: requestedModelId,
      effort: requestedEffort,
    });
  } else if (
    requestedModelId &&
    (requestedModelId !== session.modelId || requestedEffort !== session.effort)
  ) {
    await setPlaygroundSessionModel({
      id: session.id,
      projectId: project.id,
      agentId: agent.id,
      userId: session.createdBy ?? auth.user.id,
      modelId: requestedModelId,
      effort: requestedEffort,
      surface: "foh",
    });
    session = {
      ...session,
      modelId: requestedModelId,
      effort: requestedEffort,
    };
  }

  // Atomic turn claim (issue #221 finding 5): compare-and-swap the session to `running` with
  // this request's fencing token — two tabs (or two members, or two harnesst replicas) posting to
  // one session race here, and exactly one wins. Runs after target resolution (the claim
  // writes the target fields) and BEFORE `beginFohTurn`: a losing request must not
  // clear the pending park or resolve inbox items. A stale `running` row (drain dead for the
  // idle timeout) is taken over. The fresh-session path claims its own new row too — the
  // uniform code path costs one UPDATE and cannot lose.
  const claimId = crypto.randomUUID();
  // Kept for the refusal path (issue #282): a send refused before delivery restores the row
  // to exactly this status instead of settling a turn that never happened.
  const preClaimStatus = session.status;
  const claimed = await claimPlaygroundSessionForTurn({
    id: session.id,
    target,
    title,
    claimId,
    staleAfterMs: TURN_IDLE_TIMEOUT_MS,
  });
  if (!claimed) {
    throw data(
      { error: "Someone else's turn is already running in this conversation." },
      { status: 409 },
    );
  }
  session = claimed;

  // Post-claim re-decisions (#288): the pre-claim snapshot can be minutes stale (the wake
  // loop above blocks), so everything below is judged on the CLAIMED row. Answers correlate
  // only to a LIVE pending ask — when the park is gone (another tab answered it, or a
  // completed succession rebound the row to a fresh eve session), the requestIds name asks
  // the row's current session never issued, so they are dropped and the text travels as a
  // plain message instead.
  const answers =
    inputResponses && session.pendingInputAt ? inputResponses : null;
  // Succession (#288 3b): free text into a channel-homed row starts a fresh HTTP-homed
  // successor seeded with the old session's transcript. An answer to a pending ask keeps
  // flowing through the channel answer route; anything else can never be delivered there
  // (eve's channel `send()` only takes answers), so the conversation moves home instead of
  // being refused. Re-decided from the claimed row: a racer that claims after another tab's
  // succession finds resumeVia already null and simply continues the successor — never a
  // second succession (a conversation spans at most two eve sessions).
  const succeedsChannelSession = Boolean(
    !isNewSession && session.resumeVia && !answers,
  );

  let seedContext: string | null = null;
  if (succeedsChannelSession) {
    // Prologue from the OLD session's durable stream, rendered through the same strippable
    // seed block the replay pipeline already removes. Best-effort by design: a dead session
    // (`session_gone`), an unreachable eve, or a hung read yields an empty prologue —
    // succession must never fail the send. The old eve session itself is never touched; it
    // stays completed-but-readable in its world store. The row's handles are NOT touched
    // here either — the drain rebinds them in one write only once the successor provably
    // exists (its `session` event), so a failure anywhere before that leaves the
    // conversation exactly as it was and a retry re-runs the succession.
    try {
      seedContext = buildSeedContext(
        await loadPlaygroundEntriesFromEve({
          session,
          target,
          timeoutMs: SUCCESSION_PROLOGUE_TIMEOUT_MS,
          limit:
            session.streamIndex > 0 ? undefined : SUCCESSION_PROLOGUE_EVENT_CAP,
        }),
        SUCCESSION_INSTRUCTION,
      );
    } catch {
      seedContext = null;
    }
  } else if (!session.externalSessionId && session.openingMessage) {
    // Agent-opened row (#288 3c): notify-user created it with no eve session, so this first
    // reply starts one — carry the notification in as the same strippable seed block, so the
    // fresh session knows what the human is replying to and the transcript never shows it twice.
    seedContext = buildNoticeSeedContext(session.openingMessage);
  }

  if (!isNewSession && !session.resumeVia) {
    // Supersede (D13): whatever this turn says, eve resolves any parked ask from it — clear
    // the needs-you park and its inbox items before streaming. NOT for a channel-homed row
    // (issue #282): its send can still be refused before the agent is contacted (an
    // unmintable bearer, an invalid descriptor), and clearing the park first is how a
    // refusal used to delete the needs-you question while eve kept waiting. The drain runs
    // the same clear on the first streamed event instead — proof the agent was reached.
    // A succession send (#288 3b) keeps resumeVia until the drain's rebind, so it rides the
    // same deferral: a succession that dies before eve leaves the parked ask answerable.
    await beginFohTurn(session.id);
  }

  const directive = effectiveModel
    ? signModelDirective(
        {
          id: effectiveModel,
          contextWindowTokens: requestedModel?.contextWindow ?? undefined,
          effort: effectiveEffort ?? undefined,
        },
        target.deploymentId,
        message,
      )
    : null;
  const usesIsolatedWorkspace =
    succeedsChannelSession ||
    !session.externalSessionId ||
    isSessionWorkspaceContinuationToken(session.continuationToken);
  const workspaceNote = usesIsolatedWorkspace
    ? buildSystemNotes([
        "[harnesst] This conversation's private working root is /workspace/home. Keep all project files and generated artifacts there; no other conversation's working files are mounted. /workspace/shared is only for environment-level setup that should deliberately persist across conversations.",
      ])
    : null;
  // Directive first (it must be the first line for the agent-side verifier), then the succession
  // prologue, then the ordinary strippable system note. Replay strips them in that same order.
  const messagePrefix =
    [directive, seedContext, workspaceNote].filter(Boolean).join("\n\n") ||
    null;

  // Answers correlate to requests only on the session that parked them: a fresh session has
  // nothing pending, and a succession turn starts one, so drop the responses rather than
  // send eve ids the receiving session never issued.
  const continuingSession = Boolean(
    !succeedsChannelSession &&
    session.externalSessionId &&
    session.continuationToken,
  );

  if (succeedsChannelSession) {
    // Stop-fence (#288): a Stop landing between the claim and this dispatch sees no local
    // turn controller yet, marks the row stopped, and reports success — dispatching after
    // that would run an orphan successor turn. Re-check just before the POST; the residual
    // window after this read matches the pre-existing new-session window.
    const latest = await getFohSessionForViewer({
      id: session.id,
      projectId: project.id,
      agentId: agent.id,
      viewerId: auth.user.id,
      includeAll: access.backOfHouse,
    });
    if (!latest || latest.status === "stopped") {
      throw data(
        { error: "This conversation was stopped before the message was sent." },
        { status: 409 },
      );
    }
  }

  return streamTurnResponse({
    projectId: project.id,
    target,
    session,
    message,
    channel: "foh",
    title,
    messagePrefix,
    inputResponses: continuingSession ? answers : null,
    claimId,
    preClaimStatus,
    succession: succeedsChannelSession,
  });
}
