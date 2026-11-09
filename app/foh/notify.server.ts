/**
 * Agent-initiated conversations (#288 3c) — the control-plane half of the baked `notify-user`
 * tool. An agent on any run POSTs `{message, title?}` to `/api/foh/notify`; this opens a Front
 * of House conversation carrying the message and files a `notice` inbox item so a human finds
 * it from the bell. The row has NO eve session — the human's first reply seeds a fresh
 * HTTP-homed one with the notification as strippable context (`api.foh.stream.ts`).
 *
 * Shape follows `app/foh/park.server.ts` deliberately (same trust boundary, one event earlier
 * in a conversation's life): the route verifies a bearer to a DEPLOYMENT ID and nothing else,
 * everything about who the caller is — environment, agent, project — is derived server-side
 * from that id, and collaborators are injected so the whole flow unit-tests with zero I/O.
 *
 * A notice never parks the run: `pendingInputAt` stays null, `lastEventAt` drives the unread
 * badge and the `notice` inbox item drives the bell. By default the row reads "done". With
 * `awaitsReply` (the agent's work waits on a human answering in the conversation, e.g. an
 * engineer starting a design session) it reads "needs you" until a human replies, and the
 * inbox item is a `reply` that counts toward the needs-you badge.
 *
 * Duplicates: an agent woken repeatedly can send the same notification many times. While an
 * earlier one with the same explicit title is still unreplied and unarchived, a repeat opens
 * nothing new and returns that conversation with `alreadyOpen`, so a dozen wakes leave one
 * thread. Inferred titles are not compared: they vary run to run, so they would rarely match.
 *
 * Topics: a notification may name what it is about (`topic`, the ledger issue id). Once the new
 * conversation is open, older unreplied ones on that topic are archived: a status update
 * replaces earlier updates, and a new ask also replaces the same agent's earlier asks. A
 * human therefore sees the latest word on each subject, not its history.
 */
import type { DataStore } from "~/data/ports";
import { recordInboxNotice } from "~/foh/inbox.server";
import { inferFohSessionTitle } from "~/foh/session-title.server";
import {
  countAgentInitiatedFohSessions,
  createPlaygroundSession,
  deleteBareNotificationSession,
  listUnrepliedAgentNotifications,
  markNotificationAwaitingReply,
  supersedeTopicNotifications,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/** Refuse absurd payloads before they reach the database. */
const MAX_MESSAGE_BYTES = 20_000;
const MAX_TITLE_BYTES = 500;
const MAX_TOPIC_BYTES = 200;
/**
 * Ceiling on live agent-initiated conversations per agent — the `foh.agent.tsx` new-session
 * row-spam guard, applied to the writer that never sees a form. Archiving frees rows.
 */
const MAX_OPEN_AGENT_SESSIONS = 100;

export interface NotifyDeps {
  store: DataStore;
  createSession: typeof createPlaygroundSession;
  countOpenAgentSessions: typeof countAgentInitiatedFohSessions;
  openNotice: typeof recordInboxNotice;
  /** Compensation when the notice write fails after the session write succeeded. */
  deleteBareSession: typeof deleteBareNotificationSession;
  inferTitle: typeof inferFohSessionTitle;
  listUnreplied: typeof listUnrepliedAgentNotifications;
  markAwaitingReply: typeof markNotificationAwaitingReply;
  supersedeTopic: typeof supersedeTopicNotifications;
  now: () => Date;
}

export function defaultNotifyDeps(): NotifyDeps {
  return {
    store: getRuntime().data,
    createSession: createPlaygroundSession,
    countOpenAgentSessions: countAgentInitiatedFohSessions,
    openNotice: recordInboxNotice,
    deleteBareSession: deleteBareNotificationSession,
    inferTitle: inferFohSessionTitle,
    listUnreplied: listUnrepliedAgentNotifications,
    markAwaitingReply: markNotificationAwaitingReply,
    supersedeTopic: supersedeTopicNotifications,
    now: () => new Date(),
  };
}

export interface NotifyInput {
  /** The caller deployment id the route's bearer authenticated. Never from the body. */
  deploymentId: string;
  message: string;
  title?: string | null;
  /** The agent is waiting on a human to reply in this conversation. */
  awaitsReply?: boolean;
  /** What the notification is about; a newer one on the same topic supersedes it. */
  topic?: string | null;
}

export type NotifyResult =
  | { ok: true; sessionId: string; inboxItemId: string }
  | { ok: true; sessionId: string; alreadyOpen: true; note: string }
  | { ok: false; error: string };

/** Titles compare case-, spacing- and trailing-punctuation-insensitively. */
export function sameNotificationTitle(a: string | null, b: string): boolean {
  const norm = (t: string) =>
    t.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?:…-]+$/u, "").trim();
  return a !== null && norm(a) === norm(b);
}

function deny(error: string): NotifyResult {
  return { ok: false, error };
}

export async function notifyHumans(
  input: NotifyInput,
  deps: NotifyDeps,
): Promise<NotifyResult> {
  const { store } = deps;

  const message = input.message.trim();
  if (!message) return deny("Send a non-empty message.");
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    return deny("That message is too long — keep a notification under 20KB.");
  }
  const title = input.title?.trim() || null;
  if (title && Buffer.byteLength(title, "utf8") > MAX_TITLE_BYTES) {
    return deny("That title is too long — keep it under 500 bytes.");
  }
  const topic = input.topic?.trim() || null;
  if (topic && Buffer.byteLength(topic, "utf8") > MAX_TOPIC_BYTES) {
    return deny("That topic is too long — pass the ledger item id.");
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

  // Before the ceiling: a repeat of an open conversation costs nothing, so it is never refused.
  if (title) {
    const open = (await deps.listUnreplied(agent.id)).find((row) =>
      sameNotificationTitle(row.title, title),
    );
    if (open) {
      if (input.awaitsReply && !open.awaitingReplyAt) {
        await deps.markAwaitingReply(open.id, deps.now());
      }
      return {
        ok: true,
        sessionId: open.id,
        alreadyOpen: true,
        note: "A conversation with this title is already open and nobody has replied yet. Nothing new was sent; do not send it again.",
      };
    }
  }

  if ((await deps.countOpenAgentSessions(agent.id)) >= MAX_OPEN_AGENT_SESSIONS) {
    return deny(
      "You have too many open conversations with your humans — wait for them to tidy up before sending more notifications.",
    );
  }

  // The release-joined row carries version, which the plain deployment row does not.
  const withRelease = (
    await store.deployments.listByEnvironment(environment.id)
  ).find((d) => d.id === deployment.id);
  const sessionTitle =
    title ?? (await deps.inferTitle({ message, project }));

  const now = deps.now();
  const session = await deps.createSession({
    projectId: project.id,
    agentId: agent.id,
    // Team-wide (D5): an agent's notification belongs to whoever is around to read it.
    userId: null,
    // The list and session-header "agent-opened" badges key on this field alone — a
    // notification without it renders as an ordinary team conversation.
    openedByAgentId: agent.id,
    surface: "foh",
    environmentId: environment.id,
    version: withRelease?.version ?? null,
    title: sessionTitle,
    openingMessage: message,
    // NO eve handles and NO pending-input park: the run is not paused. `lastEventAt` (set to
    // creation) drives the unread badge; `awaitingReplyAt` alone makes the row "needs you".
    lastEventAt: now,
    awaitingReplyAt: input.awaitsReply ? now : null,
    topic,
  });

  let item;
  try {
    item = await deps.openNotice(
      {
        projectId: project.id,
        sessionId: session.id,
        agentId: agent.id,
        prompt: sessionTitle,
        awaitsReply: input.awaitsReply === true,
      },
      store,
    );
  } catch (error) {
    // No shared transaction covers the two writes (this layer never opens one — the park does
    // the same sequential writes), so a failed bell write must not strand a conversation nobody
    // was told about: reap the still-bare row so the agent's retry starts clean instead of
    // opening a duplicate. Best-effort — the original failure is the one worth surfacing.
    await deps.deleteBareSession(session.id).catch((cleanupError) => {
      console.error("[foh] notify compensation delete failed:", cleanupError);
    });
    throw error;
  }

  // After the new conversation exists, so a failed write above never leaves the subject with
  // no thread at all. Best-effort: a missed supersede only leaves an older thread showing.
  if (topic) {
    try {
      await deps.supersedeTopic({
        projectId: project.id,
        topic,
        keepId: session.id,
        supersedeAsksOf: input.awaitsReply ? agent.id : null,
        now,
      });
    } catch (error) {
      console.error("[foh] notify topic supersede failed:", error);
    }
  }

  return { ok: true, sessionId: session.id, inboxItemId: item.id };
}
