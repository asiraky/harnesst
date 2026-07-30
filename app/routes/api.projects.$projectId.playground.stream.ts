/**
 * Playground streaming turn (resource route, action only). The page POSTs a message here and
 * reads back an NDJSON stream of the turn as it runs. The disconnect-safe drain + persistence +
 * recording live in the shared `~/chat/turn-stream.server` helper (used by the assistant surface
 * too); this route only resolves the tenancy-guarded live target + the session row.
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { liveTargets } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { listAgentEnvironments } from "~/db/queries.server";
import { signModelDirective } from "~/models/model-directive.server";
import { parseRequestedModelSelection } from "~/models/playground-selection";
import { type ReasoningEffort } from "~/models/reasoning";
import {
  findWorkspaceModel,
  ownsWorkspaceModelReference,
} from "~/models/union.server";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  markPlaygroundSessionRunning,
  setPlaygroundSessionModel,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import {
  resolveAgentContext,
  agentFromParams,
  requireActiveAgent,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const form = await args.request.formData();
  const agentName =
    agentFromParams(args.params) ?? asString(form.get("agentName"));
  const { active } = await resolveAgentContext(project.id, agentName);
  requireActiveAgent(active, project.id);

  const deploymentId = asString(form.get("deploymentId"));
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });
  // The composer's current model selection; absent = keep the session's stored override.
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

  // Only talk to live deployments that belong to THIS agent (tenancy guard) — reject with
  // JSON, not a stream, so the client can surface it.
  const targets = await liveTargets(active.id);
  const target = targets.find((t) => t.deploymentId === deploymentId);
  if (!target) {
    throw data(
      {
        error:
          "That deployment isn't live (or isn't part of this agent). Deploy first.",
      },
      { status: 400 },
    );
  }

  let playgroundSession: PlaygroundSession | null = playgroundSessionId
    ? await getPlaygroundSession({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: active.id,
        userId: auth.user.id,
      })
    : null;
  if (playgroundSessionId && !playgroundSession) {
    throw data(
      { error: "That playground session was not found." },
      { status: 404 },
    );
  }
  const effectiveModel = requestedModelId ?? playgroundSession?.modelId ?? null;
  const effectiveEffort = requestedModelId
    ? requestedEffort
    : ((playgroundSession?.effort as ReasoningEffort | null) ?? null);
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
  // A BOUND session's history lives in exactly one environment's world store (#288): a
  // cross-environment target never saw the session (eve hangs, not 404s, on unknown ids), so
  // a mismatched pick is refused outright — no reseed path exists any more, and silently
  // starting fresh (or rebinding the row) would lose the conversation's context for good.
  if (
    playgroundSession?.externalSessionId &&
    playgroundSession.environmentId &&
    target.environmentId !== playgroundSession.environmentId
  ) {
    const environments = await listAgentEnvironments(active.id);
    const home = environments.find(
      (env) => env.id === playgroundSession?.environmentId,
    );
    throw data(
      {
        error: `This conversation lives in the "${home?.name ?? "original"}" environment — pick a deployment there, or start a new session to talk to this one.`,
      },
      { status: 409 },
    );
  }
  const title = playgroundSession?.title ? null : titleFromMessage(message);
  if (!playgroundSession) {
    playgroundSession = await createPlaygroundSession({
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      surface: "playground",
      environmentId: target.environmentId,
      version: target.version,
      title,
      modelId: requestedModelId,
      effort: requestedEffort,
    });
  } else if (
    requestedModelId &&
    (requestedModelId !== playgroundSession.modelId ||
      requestedEffort !== playgroundSession.effort)
  ) {
    // The selector changed since the last turn — remember it on the conversation.
    await setPlaygroundSessionModel({
      id: playgroundSession.id,
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      modelId: requestedModelId,
      effort: requestedEffort,
    });
    playgroundSession = {
      ...playgroundSession,
      modelId: requestedModelId,
      effort: requestedEffort,
    };
  }
  await markPlaygroundSessionRunning({
    id: playgroundSession.id,
    target,
    title,
  });

  // A model override travels as one machine-readable line prepended to the SENT message (eve's
  // session API has no per-turn model field); the deployed agent's dynamic-model resolver reads
  // it, and every display surface strips it. The catalog lookup supplies the model's context
  // window; when the catalog is unreachable the directive simply omits it.
  const directive = effectiveModel
    ? signModelDirective(
        {
          id: effectiveModel,
          // A newly requested selection was catalog-validated above. An already-stored selection
          // uses active ownership only, so a transient catalog outage does not block inference.
          contextWindowTokens: requestedModel?.contextWindow ?? undefined,
          effort: effectiveEffort ?? undefined,
        },
        target.deploymentId,
        message,
      )
    : null;
  // The model directive stays the first line of the sent message (both the agent-side resolver
  // and `stripModelDirective` anchor to start-of-string).
  const messagePrefix = directive || null;

  return streamTurnResponse({
    projectId: project.id,
    target,
    session: playgroundSession,
    message,
    channel: "playground",
    title,
    messagePrefix,
  });
}
