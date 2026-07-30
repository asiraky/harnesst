/**
 * FOH session view (D14: /t/:projectId/:agentId/s/:sessionId) — the right pane: one
 * conversation with a team member. A deliberate COPY of the playground page's loader
 * pipeline (reconcile → settle → backfill → cache read) and client machinery (LiveTurn
 * reducer, NDJSON send/stop, 2s reconnect poll, newest-entry-only onAnswer) per D20 — the
 * regression criterion outweighs DRY.
 *
 * FOH differences: the guard is FOH scope (members open only their own or agent-opened
 * sessions), opening the session posts the read acknowledgement (D3/D13 — an explicit
 * action, never the prefetchable GET loader), the target is server-picked (no
 * deployment/model pickers — wake-on-send covers
 * scaled-to-zero agents), and parked questions render as the same answerable callouts wired
 * into the ordinary send path (answering resumes the parked eve session — or the parked
 * PEER session for delegation-opened rows).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Square } from "lucide-react";
import {
  data,
  Link,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";

import { liveTargets } from "~/chat/playground.server";
import type {
  ChatEntry,
  ChatInputAnswer,
  ChatInputRequest,
  ChatStep,
} from "~/chat/types";
import {
  ArtifactCard,
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
  InputRequestsBlock,
  MarkdownText,
  StepsCard,
  UserBubble,
} from "~/components/chat";
import { SessionStatusDot } from "~/components/foh/session-list";
import { TurnError } from "~/components/turn-error";
import { Button } from "~/components/ui/button";
import { sessionLoader } from "~/auth/session.server";
import { newestTurnEntry } from "~/foh/artifact-entries";
import { requireFohProject } from "~/foh/guard.server";
import { channelLabelFor } from "~/foh/channel-resume";
import { openInboxQuestion, resolveInboxForSession } from "~/foh/inbox.server";
import {
  composerAnswerFor,
  freeformAnswerable,
  newestPendingRequest,
  repairFohSessionState,
} from "~/foh/needs-you";
import { fohSessionStatus } from "~/foh/status";
import {
  cacheCoversCompletedLiveTurn,
  guardStaleLiveUpdate,
  liveTurnIsForDifferentSession,
  shouldPollRemoteSession,
} from "~/playground/handoff";
import {
  backfillPlaygroundEventsFromEve,
  clearSessionPendingInput,
  getFohSessionForViewer,
  loadPlaygroundEntriesFromCache,
  markSessionPendingInput,
  playgroundCacheIsComplete,
  reconcilePlaygroundSessionFromEve,
  restoreRepairedSessionToWaiting,
  settleAbandonedPlaygroundSession,
} from "~/playground/sessions.server";
import { shouldSettleAbandonedSession } from "~/playground/settle";
import { findSessionOwnerTarget } from "~/playground/ownership";
import { finalizeDelegationOnResume } from "~/team/resume.server";
import { hasActiveTurn, TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import { getRuntime } from "~/seams/index.server";
import type { ReasoningEffort } from "~/models/reasoning";
import type { Route } from "./+types/foh.session";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const access = await requireFohProject(auth, args.params.projectId, {
        request: args.request,
      });
      const agent = args.params.agentId
        ? await getRuntime().data.agents.findById(args.params.agentId)
        : null;
      if (
        !agent ||
        agent.projectId !== access.project.id ||
        agent.kind !== "member"
      ) {
        throw data("Team member not found", { status: 404 });
      }
      let currentSession = args.params.sessionId
        ? await getFohSessionForViewer({
            id: args.params.sessionId,
            projectId: access.project.id,
            agentId: agent.id,
            viewerId: auth.user.id,
            includeAll: access.backOfHouse,
          })
        : null;
      if (!currentSession) throw data("Session not found", { status: 404 });

      const targets = await liveTargets(agent.id);
      const historyTarget = findSessionOwnerTarget(currentSession, targets);
      let historyError: string | null = null;

      // Dead-drain recovery (chokepoint #2 rides inside): a turn whose drain died with the
      // harnesst process must not read "busy" forever — and a park it recorded is recovered
      // into pendingInputAt/inbox by the reconcile itself.
      if (
        (currentSession.status === "running" ||
          currentSession.status === "failed") &&
        historyTarget &&
        !hasActiveTurn(currentSession.id)
      ) {
        try {
          currentSession = await reconcilePlaygroundSessionFromEve({
            session: currentSession,
            target: historyTarget,
          });
        } catch {
          // Eve unreachable — a later load retries.
        }
      }

      if (
        shouldSettleAbandonedSession({
          status: currentSession.status,
          activeTurnInProcess: hasActiveTurn(currentSession.id),
          ownerDeploymentLive: historyTarget !== null,
          msSinceLastActivity: Date.now() - currentSession.updatedAt.getTime(),
          idleTimeoutMs: TURN_IDLE_TIMEOUT_MS,
        })
      ) {
        currentSession = await settleAbandonedPlaygroundSession(currentSession);
      }

      // Incomplete-cache backfill: agent-opened (relay-parked) rows start with a best-effort
      // transcript copy — if the relay's backfill missed, this is where it heals (D8), same
      // as legacy playground sessions.
      if (
        currentSession.externalSessionId &&
        !(await playgroundCacheIsComplete(currentSession))
      ) {
        if (historyTarget) {
          try {
            await backfillPlaygroundEventsFromEve({
              session: currentSession,
              target: historyTarget,
            });
          } catch (error) {
            historyError = `Couldn't reload the conversation history: ${(error as Error).message}`;
          }
        } else {
          historyError =
            "harnesst is showing the history it cached, but some older messages may be missing because the original deployment is unavailable.";
        }
      }

      const entries = await loadPlaygroundEntriesFromCache(currentSession);

      // Loader-side repair (issue #221 finding 4): the durable retry for a park/settle
      // write the drain swallowed. The durable transcript cache is the truth; when the
      // session row disagrees (a lost park, a lying needs-you badge, a stranded waiting
      // delegation), repair it here. Every write is idempotent, the whole block is
      // exception-swallowed (bookkeeping never breaks the page), and the repaired flag is
      // reflected into the returned session so THIS load's UI is already honest.
      try {
        // Artifact cards trail their turn (#290), so the repair reads the newest conversational
        // entry — a card must never look like "the turn ended without a reply".
        const lastEntry = newestTurnEntry(entries);
        const repair = repairFohSessionState({
          status: currentSession.status,
          pendingInputAt: currentSession.pendingInputAt,
          channelHomed: currentSession.resumeVia != null,
          lastEntry,
        });
        if (repair.action === "park") {
          // Status first, park second (issue #282 review): if the park write below fails
          // transiently, a `waiting` row with the flag unset re-enters this branch on the
          // next load — the reverse order could leave `failed` + flag set, a state no
          // repair predicate matches, so the restore would never be retried.
          if (
            repair.restoreStatus &&
            (await restoreRepairedSessionToWaiting(currentSession.id))
          ) {
            currentSession = { ...currentSession, status: "waiting" };
          }
          const at = new Date();
          // The park claim reports whether it won its stop-wins guard; a stop that raced
          // us must not get inbox items filed for its stopped session.
          const parked = await markSessionPendingInput(currentSession.id, at);
          if (parked) {
            for (const request of repair.requests) {
              await openInboxQuestion({
                projectId: access.project.id,
                sessionId: currentSession.id,
                agentId: currentSession.agentId,
                userId: currentSession.createdBy,
                delegationId: currentSession.delegationId,
                request,
              });
            }
            currentSession = { ...currentSession, pendingInputAt: at };
          }
        } else if (repair.action === "settle") {
          await clearSessionPendingInput(currentSession.id);
          await resolveInboxForSession(currentSession.id);
          currentSession = { ...currentSession, pendingInputAt: null };
        }
        // Delegation half: a terminal, not-parked session must not strand its delegation
        // `waiting` forever because the drain's finalize write failed — and finalize itself
        // only touches delegations still `waiting`, so repeating it here is a no-op when
        // the drain succeeded. (Known residual, by design: a missed `finished` inbox item
        // for OTHER viewers is not refiled — opening the session is the acknowledgement.)
        const terminal =
          currentSession.status === "waiting" ||
          currentSession.status === "completed" ||
          currentSession.status === "failed";
        if (
          currentSession.delegationId &&
          terminal &&
          repair.action !== "park" &&
          currentSession.pendingInputAt === null
        ) {
          await finalizeDelegationOnResume({
            delegationId: currentSession.delegationId,
            outcome:
              currentSession.status === "failed" ? "failed" : "completed",
            error:
              currentSession.status === "failed"
                ? (lastEntry?.error ?? null)
                : null,
          });
        }
      } catch (e) {
        console.error("[foh] loader repair failed", e);
      }

      // Opening the conversation IS the acknowledgement — but this loader also runs on
      // hover/focus prefetch, so the read-cursor mutation lives in /api/foh/:projectId/read
      // and the component posts it after committed navigation (issue #221 finding 8). GET
      // stays read-only; `lastEventAt` drives the client effect.

      return {
        projectId: access.project.id,
        agentId: agent.id,
        agentName: agent.name,
        online: targets.length > 0,
        sessionId: currentSession.id,
        sessionTitle: currentSession.title ?? "New conversation",
        sessionStatus: currentSession.status,
        sessionFohStatus: fohSessionStatus(currentSession),
        openedByAgent: currentSession.openedByAgentId != null,
        // Channel-homed rows (resumeVia set) live on that channel's thread and only take
        // answers — the UI must say so. The label is the only thing exposed; nothing
        // channel-specific leaks to the client.
        channelLabel: currentSession.resumeVia
          ? channelLabelFor(currentSession.resumeVia.channel)
          : null,
        lastEventAt: currentSession.lastEventAt?.toISOString() ?? null,
        entries,
        historyError,
      };
    },
    { ensureSignedIn: true },
  );

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.sessionTitle ?? "Session"} · harnesst` }];
}

/** Local mirror of an in-flight turn, driven by the NDJSON stream (playground copy). */
interface LiveTurn {
  playgroundSessionId: string | null;
  baseEntryCount: number;
  userText: string;
  text: string;
  steps: ChatStep[];
  activity: string | null;
  modelId: string | null;
  effort: ReasoningEffort | null;
  inputRequests: ChatInputRequest[];
  error: string | null;
  errorDetail: string | null;
  errorRetryable: boolean;
  done: boolean;
}

export default function FohSession({ loaderData }: Route.ComponentProps) {
  const {
    projectId,
    agentId,
    agentName,
    online,
    sessionId,
    sessionTitle,
    sessionStatus,
    sessionFohStatus,
    openedByAgent,
    channelLabel,
    lastEventAt,
    entries,
    historyError,
  } = loaderData;
  const revalidator = useRevalidator();

  // Committed-navigation acknowledgement (D3/D13): the loader is prefetch-safe and
  // read-only, so the MOUNTED page posts the read mark — and again whenever new events
  // arrive while it stays open (lastEventAt advances on each revalidation).
  useEffect(() => {
    const form = new FormData();
    form.set("playgroundSessionId", sessionId);
    void fetch(`/api/foh/${projectId}/read`, {
      method: "POST",
      body: form,
    }).catch(() => {});
  }, [projectId, sessionId, lastEventAt]);

  const [live, setLive] = useState<LiveTurn | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  // The session on screen, readable from inside a long-lived send() closure (issue #221
  // finding 6): a reader started for session A must stop touching shared state once the
  // user navigates to session B.
  const currentSessionRef = useRef(sessionId);

  // Switching sessions drops any live view from the previous one and aborts its browser
  // reader. Only the client copy of the stream stops — the server drain is detached and
  // finishes the turn regardless.
  useEffect(() => {
    currentSessionRef.current = sessionId;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    stopRequestedRef.current = false;
    setLive((prev) =>
      prev && prev.playgroundSessionId !== sessionId ? null : prev,
    );
    setSendError(null);
  }, [sessionId]);

  const liveSessionMismatch = live
    ? liveTurnIsForDifferentSession(live.playgroundSessionId, sessionId)
    : false;
  const liveCoveredByCache =
    live !== null &&
    cacheCoversCompletedLiveTurn({
      liveSessionId: live.playgroundSessionId,
      currentSessionId: sessionId,
      currentSessionStatus: sessionStatus,
      liveDone: live.done,
      baseEntryCount: live.baseEntryCount,
      entries,
    });
  const visibleLive = liveSessionMismatch || liveCoveredByCache ? null : live;

  const remoteBusy = sessionStatus === "running";
  const busy = (live !== null && !live.done) || remoteBusy;
  const pollRemoteSession = shouldPollRemoteSession(remoteBusy, visibleLive);
  const replayingRunningSession = remoteBusy && !visibleLive;

  useEffect(() => {
    if (!pollRemoteSession) return;
    const id = window.setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2_000);
    return () => window.clearInterval(id);
  }, [pollRemoteSession, revalidator]);

  const shownEntries = useMemo<ChatEntry[]>(() => {
    if (!visibleLive) return entries;
    if (
      visibleLive.playgroundSessionId &&
      visibleLive.playgroundSessionId !== sessionId
    ) {
      return entries;
    }
    return entries.length > visibleLive.baseEntryCount
      ? entries.slice(0, visibleLive.baseEntryCount)
      : entries;
  }, [entries, sessionId, visibleLive]);

  // The newest CONVERSATIONAL entry, which is what "newest turn" means for answering and for the
  // running indicator. Not simply the last entry: an artifact card (#290) can trail the turn that
  // produced it, and it must not take the answer/retry affordances off the question above it.
  const newestTurn = useMemo(() => {
    const entry = newestTurnEntry(shownEntries);
    return { entry, index: entry ? shownEntries.indexOf(entry) : -1 };
  }, [shownEntries]);

  // The one request a typed composer answer would resolve (issue #282): the newest pending
  // ask of the newest turn — from the live turn once it settles, else from the cached
  // transcript. Mirrors the onAnswer wiring below (newest entry only).
  const pendingRequest = useMemo<ChatInputRequest | null>(() => {
    if (visibleLive) {
      if (!visibleLive.done) return null;
      if (!visibleLive.error) return visibleLive.inputRequests.at(-1) ?? null;
      // An errored live turn that produced no transcript entry (e.g. a send refused
      // before delivery) settled nothing at eve — the cached ask is still the live one,
      // and without this fallback the error would hide the answer box until a reload.
      return newestPendingRequest(newestTurnEntry(entries));
    }
    return newestPendingRequest(newestTurnEntry(entries));
  }, [entries, visibleLive]);
  // Only a request that ACCEPTS typed input turns the composer into the answer box — an
  // options-only approval is answered by its buttons, never by free text.
  const typedAnswerRequest =
    pendingRequest && freeformAnswerable(pendingRequest) ? pendingRequest : null;

  const send = useCallback(
    async (message: string, answer?: ChatInputAnswer) => {
      // This closure outlives navigation (the reader keeps draining the fetch), so every
      // state update below is keyed to the session it was started for — a stale reader
      // must not touch the live view, error banner, or revalidation of the session the
      // user navigated to (issue #221 finding 6).
      const forSession = sessionId;
      const isCurrent = () => currentSessionRef.current === forSession;
      const applyIfCurrent = (fn: (prev: LiveTurn | null) => LiveTurn | null) =>
        setLive((prev) =>
          guardStaleLiveUpdate(currentSessionRef.current, forSession, prev, fn),
        );

      setSendError(null);
      stopRequestedRef.current = false;
      applyIfCurrent(() => ({
        playgroundSessionId: forSession,
        baseEntryCount: entries.length,
        userText: message,
        text: "",
        steps: [],
        activity: "Thinking…",
        modelId: null,
        effort: null,
        inputRequests: [],
        error: null,
        errorDetail: null,
        errorRetryable: false,
        done: false,
      }));
      const apply = (evt: StreamEvent) =>
        applyIfCurrent((prev) => (prev ? reduceLive(prev, evt) : prev));

      const form = new FormData();
      form.set("message", message);
      form.set("agentId", agentId);
      form.set("playgroundSessionId", forSession);
      // A clicked question/approval card answers exactly ITS request (issue #221 finding
      // 2). On an HTTP-homed session, composer text stays the intentional continue/
      // supersede path; on a channel-homed one it correlates to the newest pending ask —
      // the only thing such a session can deliver (issue #282).
      const correlated =
        answer ??
        composerAnswerFor({
          channelHomed: channelLabel != null,
          pendingRequest: typedAnswerRequest,
          text: message,
        });
      if (correlated) form.set("inputResponses", JSON.stringify([correlated]));

      const controller = new AbortController();
      streamAbortRef.current = controller;
      try {
        const res = await fetch(`/api/foh/${projectId}/stream`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: unknown;
          } | null;
          const errorMessage =
            typeof detail?.error === "string" ? detail.error : null;
          throw new Error(errorMessage ?? `Stream failed (${res.status}).`);
        }
        if (!res.body) throw new Error("The stream returned no response body.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let evt: StreamEvent;
            try {
              evt = JSON.parse(line) as StreamEvent;
            } catch {
              continue;
            }
            if (stopRequestedRef.current && evt.type === "done") continue;
            apply(evt);
          }
        }
        applyIfCurrent((prev) =>
          prev && !prev.done ? { ...prev, activity: null, done: true } : prev,
        );
        if (isCurrent()) await revalidator.revalidate();
        // Only the send that owns the controller may clear the ref — a newer send (or the
        // navigation effect) may have replaced it with its own.
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
      } catch (error) {
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
        // A navigation-triggered abort lands here for the stale session — report nothing.
        if (!isCurrent()) return;
        if (stopRequestedRef.current) {
          await revalidator.revalidate();
          setLive(null);
          stopRequestedRef.current = false;
          return;
        }
        applyIfCurrent((prev) =>
          prev
            ? {
                ...prev,
                error: `Lost the live stream: ${(error as Error).message}`,
                errorDetail: null,
                errorRetryable: false,
                activity: null,
                done: true,
              }
            : prev,
        );
        setSendError(
          "The live view dropped — the reply may still have been recorded.",
        );
        await revalidator.revalidate();
      }
    },
    [
      agentId,
      channelLabel,
      entries.length,
      typedAnswerRequest,
      projectId,
      revalidator,
      sessionId,
    ],
  );

  const stopTurn = useCallback(async () => {
    setSendError(null);
    const form = new FormData();
    form.set("playgroundSessionId", sessionId);
    stopRequestedRef.current = true;
    try {
      const res = await fetch(`/api/foh/${projectId}/stop`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail && typeof detail === "object" && "error" in detail
            ? String((detail as { error: unknown }).error)
            : null) ?? `Stop failed (${res.status}).`,
        );
      }
      streamAbortRef.current?.abort();
      setLive((prev) =>
        prev
          ? { ...prev, error: "Stopped by user.", activity: null, done: true }
          : prev,
      );
      await revalidator.revalidate();
      setLive(null);
    } catch (error) {
      stopRequestedRef.current = false;
      setSendError((error as Error).message);
    }
  }, [projectId, revalidator, sessionId]);

  const composerControls = useMemo(
    () =>
      busy ? (
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="gap-1.5"
          onClick={stopTurn}
        >
          <Square className="size-3.5" />
          Stop
        </Button>
      ) : null,
    [busy, stopTurn],
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-2 shrink-0 gap-0.5 px-1.5 md:hidden"
        >
          <Link to={`/t/${projectId}/${agentId}`} aria-label="Back to sessions">
            <ChevronLeft className="size-4" aria-hidden />
            Sessions
          </Link>
        </Button>
        <SessionStatusDot status={sessionFohStatus} />
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {sessionTitle}
        </h1>
        {openedByAgent && (
          // Agent names run to 64 chars: the chip has to give way on a phone rather
          // than shove the title to zero width and the status off-screen.
          <span className="min-w-0 max-w-[45%] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            opened by {agentName}
          </span>
        )}
        {channelLabel && (
          // Channel-homed (issue #282): the conversation lives on the channel's thread and
          // this page can only deliver answers — say so where the status chips live.
          <span className="min-w-0 max-w-[45%] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            on {channelLabel} · answers only
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {statusLabel(sessionFohStatus)}
        </span>
      </header>

      <ChatTranscript
        dep={`${shownEntries.length}:${shownEntries.at(-1)?.text.length ?? 0}:${shownEntries.at(-1)?.steps?.length ?? 0}:${sessionStatus}:${visibleLive ? visibleLive.text.length + visibleLive.steps.length + visibleLive.inputRequests.length : 0}`}
        forceScrollDep={visibleLive?.userText}
        lead={
          <>
            {historyError && (
              <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {historyError}
              </p>
            )}
            {sendError && (
              <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {sendError}
              </p>
            )}
          </>
        }
      >
        {shownEntries.length === 0 && !visibleLive && !remoteBusy && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Say something to {agentName} — the conversation keeps its context
            across turns.
          </p>
        )}
        {shownEntries.map((e, i) =>
          e.role === "user" ? (
            <UserBubble key={e.id} text={e.text} />
          ) : e.role === "artifact" ? (
            // A published image (#290) is not the reply — it sits under the turn that made it as
            // its own card, and carries no answer/retry affordances.
            e.artifact && <ArtifactCard key={e.id} artifact={e.artifact} />
          ) : (
            <AgentEntry
              key={e.id}
              entry={e}
              // Only the newest turn's pending requests are answerable.
              onAnswer={
                i === newestTurn.index && !visibleLive ? send : undefined
              }
              onRetry={
                i === newestTurn.index && !visibleLive && e.errorRetryable
                  ? () => {
                      const userText = [...shownEntries.slice(0, i)]
                        .reverse()
                        .find((x) => x.role === "user")?.text;
                      if (userText) send(userText);
                    }
                  : undefined
              }
              busy={busy}
              running={replayingRunningSession && i === newestTurn.index}
            />
          ),
        )}
        {replayingRunningSession && newestTurn.entry?.role !== "assistant" && (
            <StepsCard
              steps={[]}
              idPrefix="running-session"
              activity="Still working…"
            />
          )}
        {sessionStatus === "failed" &&
          !visibleLive &&
          newestTurn.entry?.role === "user" && (
            <AssistantBubble>
              <p className="text-sm text-muted-foreground">
                This turn was interrupted before it finished. Send the message
                again to retry.
              </p>
            </AssistantBubble>
          )}
        {visibleLive && (
          <>
            <UserBubble text={visibleLive.userText} />
            <LiveBubble
              live={visibleLive}
              onRetry={() => send(visibleLive.userText)}
              busy={busy}
            />
          </>
        )}
      </ChatTranscript>

      <div className="mx-auto w-full max-w-5xl px-4 pb-4 pt-3 sm:px-6">
        {channelLabel && !typedAnswerRequest && !busy ? (
          // Channel-homed with nothing to answer (issue #282): no free-text box the user
          // isn't allowed to use — the conversation continues on the channel's thread.
          <p className="rounded-2xl border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            This conversation continues on {agentName}&rsquo;s {channelLabel}{" "}
            thread. When {agentName} asks a question here, you can answer it —
            to say anything else, reply on the {channelLabel} thread.
          </p>
        ) : (
          <>
            {!online && (
              <p className="mb-2 pl-1 text-xs text-muted-foreground">
                {agentName} is asleep — your next message wakes them (this can
                take a couple of minutes).
              </p>
            )}
            {channelLabel && typedAnswerRequest && !busy && (
              <p className="mb-2 pl-1 text-xs text-muted-foreground">
                Your reply answers {agentName}&rsquo;s question above and goes
                back to the {channelLabel} thread.
              </p>
            )}
            <ChatComposer
              placeholder={
                channelLabel
                  ? `Answer ${agentName}’s question…`
                  : `Message ${agentName}…`
              }
              busy={busy}
              onSend={send}
              controls={composerControls}
            />
          </>
        )}
      </div>
    </section>
  );
}

function statusLabel(status: "working" | "needs_you" | "done" | "error") {
  if (status === "working") return "working";
  if (status === "needs_you") return "needs you";
  if (status === "error") return "failed";
  return "done";
}

type StreamEvent =
  | { type: "session"; playgroundSessionId: string }
  | { type: "model"; modelId: string }
  | { type: "thinking" }
  | { type: "action"; toolName: string; summary: string | null }
  | { type: "text"; text: string }
  | { type: "step"; step: ChatStep }
  | { type: "input"; requests: ChatInputRequest[] }
  | {
      type: "done";
      ok: boolean;
      playgroundSessionId?: string;
      reply: string | null;
      structured: boolean;
      inputRequests?: ChatInputRequest[];
      error: string | null;
      errorDetail?: string | null;
      errorRetryable?: boolean;
      modelId: string | null;
      version: string;
    };

/** Fold one stream event into the live turn state (pure — playground copy). */
function reduceLive(prev: LiveTurn, evt: StreamEvent): LiveTurn {
  switch (evt.type) {
    case "session":
      return { ...prev, playgroundSessionId: evt.playgroundSessionId };
    case "model":
      return { ...prev, modelId: evt.modelId };
    case "thinking":
      return { ...prev, activity: "Thinking…" };
    case "action":
      return {
        ...prev,
        activity: evt.summary ? `${evt.toolName}: ${evt.summary}` : evt.toolName,
      };
    case "text":
      return { ...prev, text: evt.text };
    case "step":
      return { ...prev, steps: [...prev.steps, evt.step], activity: "Thinking…" };
    case "input":
      return {
        ...prev,
        inputRequests: [...prev.inputRequests, ...evt.requests],
        activity: null,
      };
    case "done":
      return {
        ...prev,
        text: evt.reply ?? prev.text,
        inputRequests:
          evt.inputRequests && evt.inputRequests.length > 0
            ? evt.inputRequests
            : prev.inputRequests,
        error: evt.error,
        errorDetail: evt.errorDetail ?? null,
        errorRetryable: evt.errorRetryable ?? false,
        modelId: evt.modelId ?? prev.modelId,
        activity: null,
        done: true,
      };
    default:
      return prev;
  }
}

function LiveBubble({
  live,
  onRetry,
  busy,
}: {
  live: LiveTurn;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="space-y-2">
      {(live.text || live.error || live.inputRequests.length > 0) && (
        <AssistantBubble>
          {live.error ? (
            <TurnError
              message={live.error}
              detail={live.errorDetail}
              retryable={live.errorRetryable}
              onRetry={onRetry}
              busy={busy}
            />
          ) : live.text ? (
            <MarkdownText text={live.text} />
          ) : null}
          {/* Static while the stream is open — the buttons go live on the persisted
              entry once the turn settles and history revalidates. */}
          <InputRequestsBlock requests={live.inputRequests} busy />
        </AssistantBubble>
      )}
      <StepsCard
        steps={live.steps}
        idPrefix="live"
        activity={live.done ? null : live.activity}
      />
    </div>
  );
}

export function AgentEntry({
  entry,
  onAnswer,
  onRetry,
  busy,
  running,
}: {
  entry: ChatEntry;
  /** Set on the newest entry only — answers a pending input request via the send path. */
  onAnswer?: (text: string, answer?: ChatInputAnswer) => void;
  /** Set on the newest errored entry only — resends the message to retry the turn. */
  onRetry?: () => void;
  busy?: boolean;
  running?: boolean;
}) {
  // A still-running turn rebuilt from the event cache (e.g. after switching to another
  // session and back mid-turn) has steps but no reply text yet. Rendering the
  // "(empty reply)" fallback there reads as a broken message — suppress the bubble and
  // let the steps card carry the "Still working…" state, matching LiveBubble.
  const awaitingReply =
    running &&
    !entry.error &&
    !entry.structured &&
    !entry.text &&
    !entry.inputRequests?.length;
  return (
    <div className="space-y-2">
      {!awaitingReply && (
        <AssistantBubble>
          {entry.error ? (
            <TurnError
              message={entry.error}
              detail={entry.errorDetail}
              retryable={entry.errorRetryable}
              onRetry={onRetry}
              busy={busy}
            />
          ) : entry.structured ? (
            <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">
              {entry.text}
            </pre>
          ) : entry.text || !entry.inputRequests?.length ? (
            <MarkdownText text={entry.text || "(empty reply)"} />
          ) : null}
          {entry.inputRequests && (
            <InputRequestsBlock
              requests={entry.inputRequests}
              onAnswer={onAnswer}
              busy={busy}
            />
          )}
        </AssistantBubble>
      )}
      <StepsCard
        steps={entry.steps ?? []}
        idPrefix={entry.id}
        activity={running ? "Still working…" : undefined}
      />
    </div>
  );
}
