/**
 * Front of House inbox — thin helpers over InboxItemRepo (pattern: app/tasks/tasks.server.ts).
 *
 * An inbox item is the durable "a human should look at this" record behind the FOH bell:
 * a parked eve `input.requested` (kind `question`/`approval`, D19), a finished turn
 * (kind `finished`, D13), or an agent-initiated conversation (kind `notice`, #288 3c). Items
 * are written only at the needs-you chokepoints (drain, reconcile, relay, notify) and resolved
 * on continuation send, terminal failure, supersession by a newer turn, or — for
 * `finished`/`notice` — when the viewer opens the session.
 *
 * Every function takes `store: DataStore = getRuntime().data` so chokepoints and route actions
 * inject a fake in unit tests.
 */
import type { ChatInputRequest } from "~/chat/types";
import type { DataStore, InboxItem } from "~/data/ports";
// Function-level circular import (sessions.server ↔ inbox.server): safe — both sides only
// reference the other inside async function bodies, never during module evaluation.
import {
  clearSessionPendingInput,
  listFohSessionsByIds,
} from "~/playground/sessions.server";
import { getRuntime } from "~/seams/index.server";

/** D19: eve renders tool approvals as `display: "confirmation"`; everything else is a question. */
export function inboxKindForRequest(
  request: Pick<ChatInputRequest, "display">,
): "question" | "approval" {
  return request.display === "confirmation" ? "approval" : "question";
}

/**
 * Open (or reuse) the inbox item for one parked input request. Idempotent per (session,
 * requestId): the live drain and the loader-side reconcile can both observe the same eve
 * request, so a pending item with the same requestId short-circuits to itself.
 * `userId: null` = team-wide visibility (agent-opened sessions, D5).
 */
export async function openInboxQuestion(
  input: {
    projectId: string;
    sessionId: string;
    agentId?: string | null;
    userId: string | null;
    delegationId?: string | null;
    runId?: string | null;
    request: ChatInputRequest;
  },
  store: DataStore = getRuntime().data,
): Promise<InboxItem> {
  const pending = await store.inboxItems.findPendingBySession(input.sessionId);
  const existing = pending.find(
    (item) => item.requestId != null && item.requestId === input.request.requestId,
  );
  if (existing) return existing;
  return store.inboxItems.insert({
    projectId: input.projectId,
    sessionId: input.sessionId,
    kind: inboxKindForRequest(input.request),
    prompt: input.request.prompt,
    requestId: input.request.requestId,
    agentId: input.agentId ?? null,
    userId: input.userId,
    delegationId: input.delegationId ?? null,
    runId: input.runId ?? null,
  });
}

/**
 * Resolve a session's pending question/approval items — on continuation send (the answer
 * supersedes them), terminal failure, or a newer turn starting.
 */
export async function resolveInboxForSession(
  sessionId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.inboxItems.resolveBySession(sessionId, ["question", "approval"]);
}

/**
 * Resolve EVERY pending item for a session — archiving (#278) retracts the conversation's whole
 * claim on the team's attention, `finished` (D13) included. The narrower variant above is right
 * for stop/send/reconcile, where the row stays visible and a `finished` item is acknowledged by
 * opening it; an archived row is invisible to every FOH read, so an item left pending would be a
 * bell entry whose link 404s and which nothing can ever resolve.
 */
export async function resolveInboxForArchivedSession(
  sessionId: string,
  /**
   * The archive's own timestamp. Fences the resolve to the generation of items that existed
   * when the row was archived: a channel park landing between the archive UPDATE and this call
   * un-archives the session and files a FRESH question, and resolving that one would leave a
   * live conversation parked on a question with no bell entry behind it.
   */
  archivedAt: Date,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await store.inboxItems.resolveBySession(sessionId, undefined, archivedAt);
}

/** Record a terminal-success `finished` item (D13) for a FOH session's recipient. */
export async function recordInboxFinished(
  input: {
    projectId: string;
    sessionId: string;
    agentId?: string | null;
    userId: string | null;
    prompt?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<InboxItem> {
  return store.inboxItems.insert({
    projectId: input.projectId,
    sessionId: input.sessionId,
    kind: "finished",
    prompt: input.prompt ?? null,
    agentId: input.agentId ?? null,
    userId: input.userId,
  });
}

/**
 * Record a `notice` item (#288 3c) — an agent opened a conversation via `contact-user` and
 * the bell is how a human finds it. Team-wide by design (`userId: null`, the D5 rule): a
 * notification from an agent belongs to whoever is around to read it. Resolves on read, like
 * `finished` — opening the conversation IS the acknowledgement.
 */
export async function recordInboxNotice(
  input: {
    projectId: string;
    sessionId: string;
    agentId?: string | null;
    prompt?: string | null;
  },
  store: DataStore = getRuntime().data,
): Promise<InboxItem> {
  return store.inboxItems.insert({
    projectId: input.projectId,
    sessionId: input.sessionId,
    kind: "notice",
    prompt: input.prompt ?? null,
    agentId: input.agentId ?? null,
    userId: null,
  });
}

/**
 * The FOH send-path supersede rule (map gotcha "answering an old question"): before a new
 * turn is streamed into a session, clear the park and resolve its pending question/approval
 * items — whether the message answers the question or just moves on, eve resolves the parked
 * request from the next message, so stale items must not invite answers to questions eve no
 * longer holds. Call from the FOH stream route before `streamTurnResponse`.
 */
export async function beginFohTurn(
  sessionId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  await clearSessionPendingInput(sessionId);
  await resolveInboxForSession(sessionId, store);
}

/** One flyout row: an inbox item enriched with where clicking it jumps (§3 🔔 inbox). */
export interface InboxViewItem {
  id: string;
  kind: string;
  prompt: string | null;
  createdAt: string;
  projectId: string;
  agentId: string | null;
  agentName: string | null;
  sessionId: string;
  sessionTitle: string;
  /** FOH session path (D14) — the jump target. */
  href: string;
}

/**
 * The viewer's pending inbox, enriched for the flyout: session titles + agent names + the
 * D14 jump path. Visibility is the repo's D5 rule (own items + team-wide `userId NULL` ones
 * within the caller-scoped projects); items whose FOH session vanished are dropped.
 */
export async function listInboxForViewer(
  input: { userId: string; projectIds: string[] },
  store: DataStore = getRuntime().data,
  deps: {
    sessionsByIds?: (ids: string[]) => Promise<
      Array<{
        id: string;
        agentId: string;
        title: string | null;
        archivedAt?: Date | null;
      }>
    >;
  } = {},
): Promise<InboxViewItem[]> {
  const items = await store.inboxItems.listPendingForProjects(
    input.projectIds,
    input.userId,
  );
  if (items.length === 0) return [];
  const sessions = await (deps.sessionsByIds ?? listFohSessionsByIds)([
    ...new Set(items.map((item) => item.sessionId)),
  ]);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const agentIds = [
    ...new Set(sessions.map((session) => session.agentId).filter(Boolean)),
  ];
  const agents = await Promise.all(
    agentIds.map((id) => store.agents.findById(id)),
  );
  const agentNameById = new Map(
    agents.flatMap((agent) => (agent ? [[agent.id, agent.name] as const] : [])),
  );

  return items.flatMap((item) => {
    const session = sessionById.get(item.sessionId);
    // An archived session is dropped for the same reason a vanished one is (#278): its `href`
    // now 404s, so a row pointing at it is a dead bell entry. Archiving resolves the items it
    // can see, but a turn settling in the same instant files a `finished` item just after —
    // making this a read-side invariant means that race cannot leave a stuck row behind,
    // whereas a check-before-insert on the writer would only narrow the window.
    if (!session || session.archivedAt) return [];
    const agentId = session.agentId;
    return [
      {
        id: item.id,
        kind: item.kind,
        prompt: item.prompt,
        createdAt: item.createdAt.toISOString(),
        projectId: item.projectId,
        agentId,
        agentName: agentNameById.get(agentId) ?? null,
        sessionId: item.sessionId,
        sessionTitle: session.title ?? "New conversation",
        href: `/t/${item.projectId}/${agentId}/s/${item.sessionId}`,
      },
    ];
  });
}

/**
 * Auto-resolve `finished` and `notice` items when a viewer opens the session (their read
 * cursor passes `last_event_at`, D13; a `contact-user` notice is acknowledged by reading it,
 * #288 3c). Only items the viewer can see resolve: their own, or team-wide (`userId` null) —
 * an admin opening a member's session must not eat the member's item.
 */
export async function resolveFinishedOnRead(
  sessionId: string,
  userId: string,
  store: DataStore = getRuntime().data,
): Promise<void> {
  const pending = await store.inboxItems.findPendingBySession(sessionId);
  for (const item of pending) {
    if (item.kind !== "finished" && item.kind !== "notice") continue;
    if (item.userId !== null && item.userId !== userId) continue;
    await store.inboxItems.resolve(item.id);
  }
}
