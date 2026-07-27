/**
 * Channel park (WS1) — the control-plane half of "an agent working a GitHub issue asked a
 * question and a human in harnesst should be able to answer it".
 *
 * A production run on 2026-07-26/27 established the gap this closes: eve dispatched on the
 * GitHub channel, ran three turns, and twice raised `input.requested` with a real question that
 * reached NO surface — `githubChannel` installs no handler, so the parked question died inside
 * the container. The harnesst-authored channel template now handles the event and POSTs it here.
 *
 * Shape follows `app/team/ask.server.ts` deliberately (it is the same problem one hop further
 * out): the route verifies a bearer to a DEPLOYMENT ID and nothing else, and everything about
 * who the caller is — environment, agent, project — is derived server-side from that id. The
 * body is never trusted for identity, and `routePath` is allowlisted before it can become an
 * outbound URL. Collaborators are injected so the whole flow unit-tests with zero I/O.
 *
 * Idempotency is structural, because the agent's fetch is best-effort and WILL be retried:
 * the session upserts on `(project_id, external_session_id)` and each inbox item short-circuits
 * on `(session_id, request_id)`. A redelivered park returns the same ids and writes nothing new.
 */
import type { Target } from "~/chat/playground.server";
import type { ChatInputOption, ChatInputRequest } from "~/chat/types";
import type { DataStore } from "~/data/ports";
import { buildResumeVia } from "~/foh/channel-resume";
import { openInboxQuestion } from "~/foh/inbox.server";
import {
  adoptChannelHomedSession,
  backfillChannelHomedSessionTranscript,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/** Refuse absurd payloads before they reach the database. */
const MAX_REQUESTS = 20;
const MAX_PROMPT_BYTES = 20_000;
const MAX_STATE_BYTES = 100_000;

export interface ParkDeps {
  store: DataStore;
  adoptSession: typeof adoptChannelHomedSession;
  /** Copy the pre-question transcript into the cache. Best-effort — never fails the park. */
  backfillTranscript: (input: {
    session: PlaygroundSession;
    target: Target;
  }) => Promise<void>;
  openQuestion: typeof openInboxQuestion;
  now: () => Date;
}

export function defaultParkDeps(): ParkDeps {
  return {
    store: getRuntime().data,
    adoptSession: adoptChannelHomedSession,
    backfillTranscript: backfillChannelHomedSessionTranscript,
    openQuestion: openInboxQuestion,
    now: () => new Date(),
  };
}

export interface ParkInput {
  /** The caller deployment id the route's bearer authenticated. Never from the body. */
  deploymentId: string;
  channel: string;
  routePath: string;
  /** eve's session id (`ctx.session.id` inside the channel handler). */
  eveSessionId: string;
  /** The continuation token as eve reported it — namespaced; stripping happens here. */
  continuationToken: string;
  /** The channel's durable state, needed verbatim by `SendOptions` at resume time. */
  state: Record<string, unknown>;
  title?: string | null;
  requests: ChatInputRequest[];
}

export type ParkResult =
  | { ok: true; sessionId: string; inboxItemIds: string[] }
  | { ok: false; error: string };

function deny(error: string): ParkResult {
  return { ok: false, error };
}

/**
 * Validate one inbound request into the harnesst-side shape. eve's `InputRequest` carries more
 * (the originating tool call); only what a human needs to answer is persisted.
 */
export function normalizeParkRequests(value: unknown): ChatInputRequest[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_REQUESTS) return null;
  const out: ChatInputRequest[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    const requestId = typeof entry.requestId === "string" ? entry.requestId : "";
    const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
    if (!requestId || !prompt.trim()) return null;
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) return null;
    const display =
      entry.display === "confirmation" ||
      entry.display === "select" ||
      entry.display === "text"
        ? entry.display
        : null;
    const options: ChatInputOption[] = Array.isArray(entry.options)
      ? entry.options.flatMap((option): ChatInputOption[] => {
          if (typeof option !== "object" || option === null) return [];
          const o = option as Record<string, unknown>;
          if (typeof o.id !== "string" || typeof o.label !== "string") return [];
          return [
            {
              id: o.id,
              label: o.label,
              description:
                typeof o.description === "string" ? o.description : null,
              style:
                o.style === "danger" || o.style === "primary" || o.style === "default"
                  ? o.style
                  : null,
            },
          ];
        })
      : [];
    out.push({
      requestId,
      prompt,
      display,
      allowFreeform:
        typeof entry.allowFreeform === "boolean" ? entry.allowFreeform : null,
      options,
    });
  }
  return out;
}

export async function parkChannelQuestion(
  input: ParkInput,
  deps: ParkDeps,
): Promise<ParkResult> {
  const { store } = deps;

  if (!input.eveSessionId) return deny("No eve session id was sent.");
  if (input.requests.length === 0) return deny("No input requests were sent.");
  if (Buffer.byteLength(JSON.stringify(input.state ?? {}), "utf8") > MAX_STATE_BYTES) {
    return deny("Channel state is too large to park.");
  }

  // Guard first: an unknown channel or a route path that is not the one harnesst registers for
  // it is refused BEFORE any write, and long before the path could reach an outbound fetch.
  const resumeVia = buildResumeVia({
    channel: input.channel,
    routePath: input.routePath,
    continuationToken: input.continuationToken,
    state: input.state ?? {},
  });
  if (!resumeVia) {
    return deny(
      `harnesst cannot park questions from the "${input.channel}" channel on that route.`,
    );
  }

  // Caller resolution — deployment → environment → agent → project, all from the token's
  // deployment id (the `runAsk` rule: nothing about identity comes off the wire).
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment) return deny("Your deployment is no longer known to harnesst.");
  const environment = await store.environments.findById(deployment.environmentId);
  if (!environment) return deny("Your environment is no longer known to harnesst.");
  const agent = await store.agents.findById(environment.agentId);
  if (!agent) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(agent.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // The release-joined row carries version/gitSha, which the plain deployment row does not.
  const withRelease = (
    await store.deployments.listByEnvironment(environment.id)
  ).find((d) => d.id === deployment.id);

  const now = deps.now();
  const session = await deps.adoptSession({
    projectId: project.id,
    agentId: agent.id,
    environmentId: environment.id,
    deploymentId: deployment.id,
    releaseId: withRelease?.releaseId ?? null,
    version: withRelease?.version ?? null,
    externalSessionId: input.eveSessionId,
    // Store the NAMESPACED token as the session's continuation token — it is what eve reported
    // and what any future channel-side call expects. The stripped form lives in resumeVia.
    continuationToken: input.continuationToken,
    resumeVia,
    title: input.title?.trim() || titleFromMessage(input.requests[0].prompt),
    now,
  });

  // Show the conversation that led to the question, not a bare prompt. Best-effort by design:
  // the FOH loader re-backfills an incomplete cache, so a miss here defers the copy, never
  // loses it — and a park that reached the inbox is worth more than a complete transcript.
  const url = deployment.url ?? withRelease?.url ?? null;
  if (url) {
    try {
      await deps.backfillTranscript({
        session,
        target: {
          deploymentId: deployment.id,
          environmentId: environment.id,
          releaseId: withRelease?.releaseId ?? "",
          url,
          version: withRelease?.version ?? "",
          environmentName: environment.name,
          gitSha: withRelease?.gitSha ?? "",
        },
      });
    } catch (error) {
      console.error("[foh] channel park transcript backfill failed:", error);
    }
  }

  const inboxItemIds: string[] = [];
  for (const request of input.requests) {
    const item = await deps.openQuestion(
      {
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        // Team-wide (D5): a question raised on a public GitHub issue belongs to whoever is
        // around to answer it, not to one member.
        userId: null,
        request,
      },
      store,
    );
    inboxItemIds.push(item.id);
  }

  return { ok: true, sessionId: session.id, inboxItemIds };
}
