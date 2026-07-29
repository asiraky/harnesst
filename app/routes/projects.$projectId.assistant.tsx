/**
 * Assistant — harnesst's built-in, project-level authoring agent as a durable, streaming chat.
 *
 * A real eve instance, not an in-process loop: the composer POSTs to the
 * streaming resource route (api.projects.$projectId.assistant.stream) and this component reads the
 * same NDJSON turn feed the playground uses. harnesst's durable event cache is the transcript source;
 * the owning Eve instance is consulted only for bounded recovery and legacy backfill. First use
 * shows a provisioning state while the instance builds/deploys.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  CheckCircle2,
  Info,
  Loader2,
  MessageSquare,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  redirect,
  useFetcher,
  useNavigate,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  ensureAssistantAgent,
  ensureAssistantInstance,
  peekAssistantInstance,
} from "~/assistant/instance.server";
import { getCheckoutRow } from "~/assistant/checkout-sync.server";
import { hasActiveTurn, TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import {
  AssistantTurn,
  ChatComposer,
  ChatTranscript,
  InputRequestsBlock,
  MarkdownText,
  StepsCard,
  TurnMeta,
  UserBubble,
} from "~/components/chat";
import { TurnError } from "~/components/turn-error";
import { usePublishHref } from "~/components/publish";
import { EmptyTeamState } from "~/components/empty-team-state";
import { LocalizedDate } from "~/components/localized-values";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { listAgents } from "~/db/queries.server";
import { contextPath } from "~/lib/paths";
import {
  cacheCoversCompletedLiveTurn,
  liveTurnIsForDifferentSession,
  shouldPollRemoteSession,
} from "~/playground/handoff";
import {
  backfillPlaygroundEventsFromEve,
  createPlaygroundSession,
  listPlaygroundSessions,
  loadPlaygroundEntriesFromCache,
  playgroundCacheIsComplete,
  reconcilePlaygroundSessionFromEve,
  settleAbandonedPlaygroundSession,
  summarizePlaygroundSession,
} from "~/playground/sessions.server";
import {
  findSessionOwnerTarget,
  sessionContinuationIsBlocked,
} from "~/playground/ownership";
import { shouldSettleAbandonedSession } from "~/playground/settle";
import { requireProject, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";
import type { Route } from "./+types/projects.$projectId.assistant";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const [snapshot, roster] = await Promise.all([
        peekAssistantInstance(project.id),
        listAgents(project.id),
      ]);
      const isTeam = project.layout === "team";

      let entries: ChatEntry[] = [];
      let historyError: string | null = null;
      let currentSessionId: string | null = null;
      let currentSessionStatus: string | null = null;
      let currentSessionOwnerLive: boolean | null = null;
      let currentSessionContinuationBlocked = false;
      let sessions: ReturnType<typeof summarizePlaygroundSession>[] = [];
      let syncWarnings: string[] = [];

      if (snapshot.agentId) {
        const rows = await listPlaygroundSessions({
          surface: "assistant",
          projectId: project.id,
          agentId: snapshot.agentId,
          userId: auth.user!.id,
        });
        const selected = args.url.searchParams.get("session");
        let currentSession =
          (selected ? rows.find((s) => s.id === selected) : null) ??
          rows[0] ??
          null;
        if (currentSession) {
          const historyTarget = findSessionOwnerTarget(
            currentSession,
            snapshot.target ? [snapshot.target] : [],
          );
          const ownerDeploymentLive = historyTarget !== null;
          currentSessionOwnerLive = ownerDeploymentLive;
          currentSessionContinuationBlocked = sessionContinuationIsBlocked(
            currentSession,
            snapshot.target ? [snapshot.target] : [],
          );

          // Recover a drain that died with harnesst only from the exact assistant instance that owns
          // the Eve session. A replacement instance does not know the old external session id.
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
              // A later load can retry while the owner remains live.
            }
          }

          if (
            shouldSettleAbandonedSession({
              status: currentSession.status,
              activeTurnInProcess: hasActiveTurn(currentSession.id),
              ownerDeploymentLive,
              msSinceLastActivity:
                Date.now() - currentSession.updatedAt.getTime(),
              idleTimeoutMs: TURN_IDLE_TIMEOUT_MS,
            })
          ) {
            currentSession =
              await settleAbandonedPlaygroundSession(currentSession);
          }

          // Sessions created before the durable event cache may be missing their oldest rows.
          // Backfill once, but only from the exact owning instance; never ask a replacement about
          // an unknown Eve session because that endpoint can hang indefinitely.
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
                historyError = `Couldn't recover all of the assistant's older history: ${(error as Error).message}`;
              }
            } else {
              historyError =
                "harnesst is showing the history it cached, but some older messages may be missing while the original assistant instance is unavailable.";
            }
          }

          // Cached rows render regardless of instance health, including when the owner is gone.
          entries = await loadPlaygroundEntriesFromCache(currentSession);
          currentSessionId = currentSession.id;
          currentSessionStatus = currentSession.status;
          // Last sync's policy notes / failure — shown as a banner so a sync problem is visible
          // even after a reload (the live `sync` stream event is gone by then).
          const checkout = await getCheckoutRow(currentSession.id).catch(
            () => null,
          );
          syncWarnings = checkout?.warnings ?? [];
        }
        sessions = rows.map((session) =>
          summarizePlaygroundSession(
            currentSession?.id === session.id ? currentSession : session,
          ),
        );
      }

      // Publish-failure handoff (#225 §4.3): the publish panel's "Ask the assistant to fix
      // this" links here with ?fix=<taskId>; the failed step's output pre-fills the composer
      // as context for the model. The task must belong to this project and have failed.
      let fixPrefill: string | null = null;
      const fixTaskId = args.url.searchParams.get("fix");
      if (fixTaskId) {
        const fixTask = await getRuntime()
          .data.workspaceTasks.findById(fixTaskId)
          .catch(() => null);
        if (fixTask && fixTask.projectId === project.id && fixTask.status === "failed") {
          const failedStep = fixTask.steps?.find((s) => s.status === "failed");
          const error = failedStep?.error ?? fixTask.error;
          if (error) {
            fixPrefill = `I tried to publish and it failed at "${
              failedStep?.label ?? "Publish"
            }". Please fix this so I can publish again:\n\n${error}`;
          }
        }
      }

      return {
        project,
        fixPrefill,
        instanceStatus: snapshot.status,
        provisionStage: snapshot.provisionStage,
        provisionStartedAt: snapshot.provisionStartedAt,
        sessions,
        currentSessionId,
        currentSessionStatus,
        currentSessionOwnerLive,
        currentSessionContinuationBlocked,
        entries,
        historyError,
        syncWarnings,
        isTeam,
        roster: roster.map((a) => ({ name: a.name })),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const form = await args.request.formData();
  const intent = String(form.get("intent"));

  if (intent === "provision") {
    // Kick off (or wake) the instance; the page then polls until it's live.
    await ensureAssistantInstance(project.id);
    throw redirect(`/repos/${project.id}/assistant`);
  }
  if (intent === "new-session") {
    const { agent } = await ensureAssistantAgent(project.id);
    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: auth.user.id,
      surface: "assistant",
    });
    throw redirect(
      `/repos/${project.id}/assistant?session=${encodeURIComponent(session.id)}`,
    );
  }
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Assistant · harnesst" }];
}

interface LiveTurn {
  playgroundSessionId: string | null;
  /** Loader entry boundary at send time, used to hide the cached copy during handoff. */
  baseEntryCount: number;
  userText: string;
  text: string;
  steps: ChatStep[];
  activity: string | null;
  modelId: string | null;
  inputRequests: ChatInputRequest[];
  error: string | null;
  errorDetail: string | null;
  errorRetryable: boolean;
  done: boolean;
  /** Post-turn checkout sync outcome — arrives after `done`, absent for pure-Q&A turns. */
  sync: {
    synced: boolean;
    stagedCount: number;
    error: string | null;
  } | null;
}

export default function Assistant({ loaderData }: Route.ComponentProps) {
  const {
    project,
    fixPrefill,
    instanceStatus,
    provisionStage,
    provisionStartedAt,
    sessions,
    currentSessionId,
    currentSessionStatus,
    currentSessionOwnerLive,
    currentSessionContinuationBlocked,
    entries,
    historyError,
    syncWarnings,
    isTeam,
    roster,
  } = loaderData;
  const base = contextPath(project.id, null);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const provisionFetcher = useFetcher<typeof action>();
  const newSessionFetcher = useFetcher<typeof action>();
  const NewSessionForm = newSessionFetcher.Form;
  const ProvisionForm = provisionFetcher.Form;

  // The ?fix= handoff is one-shot: once the composer is seeded from the loader, strip the
  // param so a reload (or sending the message) doesn't re-fill it. The textarea is
  // uncontrolled, so its seeded text survives the revalidation this triggers.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (!searchParams.has("fix")) return;
    const params = new URLSearchParams(searchParams);
    params.delete("fix");
    setSearchParams(params, { replace: true, preventScrollReset: true });
  }, [searchParams, setSearchParams]);

  const [live, setLive] = useState<LiveTurn | null>(null);
  // A turn from another selected session is never rendered here. For the current session, keep a
  // completed/errored live turn until the DB status settles AND its cached assistant side arrives;
  // a cached user-only prefix is not enough to replace the final browser-side reply.
  const liveSessionMismatch = live
    ? liveTurnIsForDifferentSession(live.playgroundSessionId, currentSessionId)
    : false;
  const liveCoveredByCache =
    live !== null &&
    cacheCoversCompletedLiveTurn({
      liveSessionId: live.playgroundSessionId,
      currentSessionId,
      currentSessionStatus,
      liveDone: live.done,
      baseEntryCount: live.baseEntryCount,
      entries,
    });
  const visibleLive = liveSessionMismatch || liveCoveredByCache ? null : live;
  const [sendError, setSendError] = useState<string | null>(null);

  const remoteBusy = currentSessionStatus === "running";
  // Treat the in-flight "provision" click as provisioning for instant feedback; once the action
  // redirects, the loader reports "provisioning" from the `pending` deployment row that
  // ensureAssistantInstance now persists synchronously, so the spinner stays put and polling keeps
  // running instead of flickering back to the empty state (#17).
  const provisioning =
    instanceStatus === "provisioning" || provisionFetcher.state !== "idle";
  const busy = (live !== null && !live.done) || remoteBusy || provisioning;
  const pollRemoteSession = shouldPollRemoteSession(remoteBusy, visibleLive);
  // Keep the display state separate from polling: a completed errored bubble can remain visible
  // while the loader polls for the detached server drain to finish caching the reply.
  const replayingRunningSession = remoteBusy && !visibleLive;

  // Poll while provisioning or while a remote turn has no active visible stream — the loader
  // re-derives state each time.
  useEffect(() => {
    if (!provisioning && !pollRemoteSession) return;
    const id = window.setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2_500);
    return () => window.clearInterval(id);
  }, [pollRemoteSession, provisioning, revalidator]);

  const sessionPicker = useMemo(() => {
    if (!currentSessionId || sessions.length === 0) return null;
    return (
      <Select
        value={currentSessionId}
        disabled={busy && !currentSessionContinuationBlocked}
        onValueChange={(id) =>
          navigate(`${base}/assistant?session=${encodeURIComponent(id)}`)
        }
      >
        <SelectTrigger
          className="h-8 w-56 gap-1.5 border-0 bg-muted/60 text-xs shadow-none hover:bg-muted"
          aria-label="Assistant conversation"
        >
          <MessageSquare
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {formatSessionLabel(s.title, s.updatedAt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }, [
    base,
    busy,
    currentSessionContinuationBlocked,
    currentSessionId,
    navigate,
    sessions,
  ]);

  // The cache can include the in-flight turn before its browser stream has handed off. Hide only
  // the entries appended after send time while the live view renders that same turn.
  const shownEntries = useMemo<ChatEntry[]>(() => {
    if (!visibleLive) return entries;
    if (
      visibleLive.playgroundSessionId &&
      currentSessionId &&
      visibleLive.playgroundSessionId !== currentSessionId
    ) {
      return entries;
    }
    return entries.length > visibleLive.baseEntryCount
      ? entries.slice(0, visibleLive.baseEntryCount)
      : entries;
  }, [currentSessionId, entries, visibleLive]);

  const send = useCallback(
    async (message: string) => {
      setSendError(null);
      setLive({
        playgroundSessionId: currentSessionId,
        baseEntryCount: entries.length,
        userText: message,
        text: "",
        steps: [],
        activity: "Thinking…",
        modelId: null,
        inputRequests: [],
        error: null,
        errorDetail: null,
        errorRetryable: false,
        done: false,
        sync: null,
      });
      const apply = (evt: StreamEvent) =>
        setLive((prev) => (prev ? reduceLive(prev, evt) : prev));

      const form = new FormData();
      form.set("message", message);
      if (currentSessionId) form.set("playgroundSessionId", currentSessionId);

      try {
        const res = await fetch(`/api/repos/${project.id}/assistant/stream`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: unknown;
            provisioning?: unknown;
          } | null;
          const errorMessage =
            typeof detail?.error === "string" ? detail.error : null;
          if (detail?.provisioning === true) {
            setLive(null);
            setSendError(
              "Your assistant is starting up — it'll be ready in a moment.",
            );
            await revalidator.revalidate();
            return;
          }
          if (res.status === 409) {
            setLive(null);
            setSendError(
              errorMessage ??
                "This conversation can no longer be continued. Start a new conversation.",
            );
            return;
          }
          throw new Error(errorMessage ?? `Stream failed (${res.status}).`);
        }
        if (!res.body) throw new Error("The stream returned no response body.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let nextSessionId = currentSessionId;
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
            if (
              (evt.type === "session" || evt.type === "done") &&
              evt.playgroundSessionId
            ) {
              nextSessionId = evt.playgroundSessionId;
            }
            apply(evt);
          }
        }
        // A transport can close without the terminal event. Settle the live view before
        // revalidating, then let the derived cache handoff hide it only when rows have arrived.
        setLive((prev) =>
          prev && !prev.done ? { ...prev, activity: null, done: true } : prev,
        );
        await revalidator.revalidate();
        if (!currentSessionId && nextSessionId) {
          navigate(
            `${base}/assistant?session=${encodeURIComponent(nextSessionId)}`,
            {
              replace: true,
            },
          );
        }
      } catch (error) {
        setLive((prev) =>
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
    [base, currentSessionId, entries.length, navigate, project.id, revalidator],
  );

  const headerActions = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-2">
        {sessionPicker}
        <NewSessionForm method="post">
          <input type="hidden" name="intent" value="new-session" />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={
              (busy && !currentSessionContinuationBlocked) ||
              newSessionFetcher.state !== "idle"
            }
          >
            <Plus aria-hidden />
            New chat
          </Button>
        </NewSessionForm>
        <Button asChild variant="ghost" size="sm">
          <Link to={`${base}/assistant/config`}>Configure</Link>
        </Button>
      </div>
    ),
    [
      NewSessionForm,
      base,
      busy,
      currentSessionContinuationBlocked,
      newSessionFetcher.state,
      sessionPicker,
    ],
  );

  // One slim status area with strict precedence (error > blocked > send feedback > sync note)
  // instead of a stack of full Alert boxes — the transcript never opens under a wall of chrome.
  // Provisioning isn't repeated here: the in-transcript ProvisioningCard and the composer's
  // busy hint already carry that state.
  const statusStrip = useMemo(() => {
    if (historyError) {
      return <StatusStrip tone="error">{historyError}</StatusStrip>;
    }
    if (currentSessionContinuationBlocked) {
      return (
        <StatusStrip
          tone="error"
          title="This conversation can't be continued"
          action={
            <NewSessionForm method="post">
              <input type="hidden" name="intent" value="new-session" />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={newSessionFetcher.state !== "idle"}
              >
                <Plus aria-hidden />
                New chat
              </Button>
            </NewSessionForm>
          }
        >
          Its assistant instance was replaced, so the old session can&apos;t
          resume. The history stays visible — start a new chat to keep going.
        </StatusStrip>
      );
    }
    if (sendError) {
      return <StatusStrip tone="info">{sendError}</StatusStrip>;
    }
    if (syncWarnings.length > 0) {
      return (
        <StatusStrip tone="info" title="Last sync note">
          {syncWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </StatusStrip>
      );
    }
    return null;
  }, [
    NewSessionForm,
    currentSessionContinuationBlocked,
    historyError,
    newSessionFetcher.state,
    sendError,
    syncWarnings,
  ]);

  const transcriptLead = useMemo(
    () => (
      <>
        <PageHeader
          icon={Sparkles}
          accent="brand"
          title="Assistant"
          description="Tell it what your agents should do. It writes the code, verifies the build, and saves everything for you to review and publish from the header — you never touch git."
          actions={headerActions}
        />
        {statusStrip}
      </>
    ),
    [headerActions, statusStrip],
  );

  const idle = instanceStatus === "idle";
  const failed = instanceStatus === "failed";

  return (
    <AppShell
      fullHeight
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        tail: [{ label: "Assistant" }],
      })}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-6">
        <AgentNav
          base={base}
          level={isTeam ? "repo" : "single"}
          roster={roster}
          className="mb-0"
        />
        {isTeam && roster.length === 0 && (
          <div className="mt-6">
            <EmptyTeamState overviewHref={`/repos/${project.id}`} />
          </div>
        )}
      </div>

      <ChatTranscript
        dep={`${shownEntries.length}:${shownEntries.at(-1)?.text.length ?? 0}:${shownEntries.at(-1)?.steps?.length ?? 0}:${currentSessionStatus ?? ""}:${instanceStatus}:${visibleLive ? visibleLive.text.length + visibleLive.steps.length + visibleLive.inputRequests.length : 0}`}
        forceScrollDep={visibleLive?.userText}
        lead={transcriptLead}
      >
        {(failed || idle) &&
          shownEntries.length === 0 &&
          !visibleLive &&
          !provisioning && (
            <div className="py-6">
              <Alert variant={failed ? "destructive" : undefined}>
                <AlertTitle>
                  {failed
                    ? "The assistant failed to start"
                    : "Your assistant isn't running yet"}
                </AlertTitle>
                <AlertDescription className="space-y-3">
                  <p>
                    {failed
                      ? "The last attempt to start the assistant failed. Try starting it again."
                      : "Start it once and it stays available. It builds and deploys as its own eve instance."}
                  </p>
                  <ProvisionForm method="post">
                    <input type="hidden" name="intent" value="provision" />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={provisionFetcher.state !== "idle"}
                    >
                      {failed ? "Try again" : "Set up the assistant"}
                    </Button>
                  </ProvisionForm>
                </AlertDescription>
              </Alert>
            </div>
          )}

        {provisioning && !visibleLive && (
          <div className="py-6">
            <ProvisioningCard
              stage={provisionStage}
              startedAt={provisionStartedAt}
            />
          </div>
        )}

        {shownEntries.length === 0 &&
          !visibleLive &&
          !remoteBusy &&
          !idle &&
          !failed &&
          !provisioning && (
            <div className="py-10 text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/20">
                <Sparkles className="size-6" aria-hidden />
              </div>
              <h2 className="text-base font-medium">
                Start with what you want built
              </h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                The assistant keeps context across turns, so you can refine as
                you go.
              </p>
              <div className="mx-auto mt-5 flex max-w-xl flex-wrap items-center justify-center gap-2">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="rounded-full border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    onClick={() => send(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

        {shownEntries.map((e, i) =>
          e.role === "user" ? (
            <UserBubble key={e.id} text={e.text} />
          ) : (
            <AgentEntry
              key={e.id}
              entry={e}
              onAnswer={
                i === shownEntries.length - 1 &&
                !visibleLive &&
                !currentSessionContinuationBlocked
                  ? send
                  : undefined
              }
              onRetry={
                i === shownEntries.length - 1 &&
                !visibleLive &&
                !currentSessionContinuationBlocked &&
                e.errorRetryable
                  ? () => {
                      const userText = [...shownEntries.slice(0, i)]
                        .reverse()
                        .find((x) => x.role === "user")?.text;
                      if (userText) send(userText);
                    }
                  : undefined
              }
              busy={busy}
              running={replayingRunningSession && i === shownEntries.length - 1}
            />
          ),
        )}
        {replayingRunningSession &&
          shownEntries.at(-1)?.role !== "assistant" && (
            <AssistantTurn>
              <StepsCard
                steps={[]}
                idPrefix="running-session"
                activity="Still working…"
              />
            </AssistantTurn>
          )}
        {currentSessionStatus === "failed" &&
          !visibleLive &&
          shownEntries.at(-1)?.role === "user" && (
            <AssistantTurn>
              <p className="text-muted-foreground">
                {currentSessionContinuationBlocked
                  ? "This turn was interrupted when its assistant instance was replaced. Start a new conversation to continue."
                  : currentSessionOwnerLive
                    ? "This turn was interrupted before it finished. Send the message again to retry."
                    : "This turn was interrupted before it finished while the assistant was unavailable. Restart the assistant before retrying."}
              </p>
            </AssistantTurn>
          )}
        {visibleLive && (
          <>
            <UserBubble text={visibleLive.userText} />
            <LiveBubble
              live={visibleLive}
              onRetry={
                currentSessionContinuationBlocked
                  ? undefined
                  : () => send(visibleLive.userText)
              }
              busy={busy}
            />
          </>
        )}
      </ChatTranscript>

      <div className="mx-auto w-full max-w-5xl px-4 pb-4 pt-3 sm:px-6">
        <ChatComposer
          placeholder={
            currentSessionContinuationBlocked
              ? "Start a new chat to continue…"
              : idle || failed
                ? "Set up the assistant to start…"
                : provisioning
                  ? "Setting up your assistant…"
                  : "What should your agent be able to do?"
          }
          busy={busy}
          busyHint={
            provisioning
              ? "Setting up your assistant…"
              : "The assistant is working…"
          }
          // Not-yet-provisioned reads as unavailable (setup card explains), not as in-flight work.
          disabled={currentSessionContinuationBlocked || idle || failed}
          initialValue={fixPrefill ?? undefined}
          onSend={send}
        />
      </div>
    </AppShell>
  );
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
      type: "sync";
      synced: boolean;
      stagedCount: number;
      error: string | null;
    }
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
        activity: evt.summary
          ? `${evt.toolName}: ${evt.summary}`
          : evt.toolName,
      };
    case "text":
      return { ...prev, text: evt.text };
    case "step":
      return {
        ...prev,
        steps: [...prev.steps, evt.step],
        activity: "Thinking…",
      };
    case "input":
      return {
        ...prev,
        inputRequests: [...prev.inputRequests, ...evt.requests],
        activity: null,
      };
    case "sync":
      return {
        ...prev,
        sync: {
          synced: evt.synced,
          stagedCount: evt.stagedCount,
          error: evt.error,
        },
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

const STARTER_PROMPTS = [
  "What can this repo's agents do today?",
  "Create an agent that summarizes new GitHub issues",
  "Add a scheduled daily report to my agent",
];

/**
 * The page's single status surface: one slim strip above the transcript. Callers pick the one
 * highest-precedence item to show — this renders it with a tone icon, optional title, and an
 * optional trailing action.
 */
function StatusStrip({
  tone,
  title,
  action,
  children,
}: {
  tone: "error" | "info";
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const Icon = tone === "error" ? TriangleAlert : Info;
  return (
    <div
      className={`mb-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
        tone === "error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-muted/40"
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          tone === "error" ? "text-destructive" : "text-muted-foreground"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-medium leading-snug">{title}</p>}
        <div className="text-muted-foreground">{children}</div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function formatSessionLabel(title: string, updatedAt: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return title;
  return (
    <>
      {title} ·{" "}
      <LocalizedDate
        value={date}
        options={{ month: "short", day: "numeric" }}
      />
    </>
  );
}

function ProvisioningCard({
  stage,
  startedAt,
}: {
  stage: string | null;
  startedAt: string | null;
}) {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt) {
      setElapsed(null);
      return;
    }
    const start = new Date(startedAt).getTime();
    if (Number.isNaN(start)) return;
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div className="mx-auto w-full max-w-md rounded-xl border bg-muted/40 px-4 py-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        <span>{stage ?? "Setting up your assistant…"}</span>
        {elapsed !== null && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        It builds and deploys as its own eve instance. The first build can take
        a few minutes — this stays in sync automatically, so you can leave the
        page and come back.
      </p>
    </div>
  );
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The in-flight turn, rendered with the same anatomy as a cached AgentEntry so the handoff from
 * live stream to cache is visually seamless: activity/steps first (what it's doing), then the
 * streaming reply, pending questions, the quiet sync confirmation, and a de-emphasized meta line.
 */
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
    <AssistantTurn>
      <StepsCard
        steps={live.steps}
        idPrefix="live"
        activity={live.done ? null : live.activity}
      />
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
      <InputRequestsBlock requests={live.inputRequests} busy />
      {live.sync && <SyncNote sync={live.sync} />}
      <TurnMeta items={[live.done && live.modelId]} />
    </AssistantTurn>
  );
}

/** Post-turn checkout sync outcome as a quiet, icon-led confirmation line — not a banner. */
function SyncNote({ sync }: { sync: NonNullable<LiveTurn["sync"]> }) {
  const publishHref = usePublishHref();
  if (sync.error) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          harnesst couldn&apos;t save this turn&apos;s changes ({sync.error}).
          They&apos;re safe in the conversation checkout and will be picked up
          after the next turn.
        </span>
      </p>
    );
  }
  const n = sync.stagedCount;
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2
        className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
      <span>
        {/* n counts what this sync actually changed; 0 means everything was already saved. */}
        {n === 0 ? "Everything from this turn was already saved" : (
          <>Saved {n} change{n === 1 ? "" : "s"}</>
        )}{" "}
        —{" "}
        {/* `?publish=1` opens the publish panel from the workspace-header Publish control. */}
        <Link to={publishHref} className="font-medium underline underline-offset-4">
          review and publish
        </Link>{" "}
        when you&apos;re ready.
      </span>
    </p>
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
  onAnswer?: (text: string) => void;
  /** Set on the newest errored entry only — resends the message to retry the turn. */
  onRetry?: () => void;
  busy?: boolean;
  running?: boolean;
}) {
  // A still-running turn rebuilt from the event cache (e.g. after navigating away and back
  // mid-turn) has steps but no reply text yet. Rendering the "(empty reply)" fallback there
  // reads as a broken message — suppress the bubble and let the steps card carry the
  // "Still working…" state, matching how LiveBubble renders the same moment.
  const awaitingReply =
    running &&
    !entry.error &&
    !entry.structured &&
    !entry.text &&
    !entry.inputRequests?.length;
  return (
    <AssistantTurn>
      <StepsCard
        steps={entry.steps ?? []}
        idPrefix={entry.id}
        activity={running ? "Still working…" : undefined}
      />
      {!awaitingReply && (
        <>
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
          <TurnMeta items={[entry.version, entry.modelId]} />
        </>
      )}
    </AssistantTurn>
  );
}
