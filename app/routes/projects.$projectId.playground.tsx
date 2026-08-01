/**
 * Playground — persistent Eve sessions with a live deployment of this agent.
 *
 * Eve's durable stream is the transcript source (#288): the loader renders the conversation
 * from `GET /eve/v1/session/:id/stream`, waking a scaled-to-zero instance when it must.
 *
 * Turns STREAM: the composer POSTs to the streaming resource route
 * (api.projects.$projectId.playground.stream) and this component reads back an NDJSON feed of
 * the turn — live reply text, current activity, and completed steps — so long agent turns show
 * progress instead of one spinner. On completion it revalidates the cached transcript.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlaskConical,
  MessageSquare,
  Plus,
  Server,
  Square,
} from "lucide-react";
import {
  redirect,
  useFetcher,
  useNavigate,
  useRevalidator,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { liveTargets, type Target } from "~/chat/playground.server";
import type { ChatEntry, ChatInputRequest, ChatStep } from "~/chat/types";
import {
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
  InputRequestsBlock,
  MarkdownText,
  StepsCard,
  UserBubble,
} from "~/components/chat";
import { TurnError } from "~/components/turn-error";
import { AgentNav, AppShell, PageHeader, repoCrumbs } from "~/components/shell";
import { LocalizedDate } from "~/components/localized-values";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ModelSelection } from "~/components/model-select";
import { resolveAgentModel } from "~/models/agent-model-config.server";
import { contextPath } from "~/lib/paths";
import { cn } from "~/lib/utils";
import { findWorkspaceModel } from "~/models/union.server";
import { isReasoningEffort, type ReasoningEffort } from "~/models/reasoning";
import {
  cacheCoversCompletedLiveTurn,
  liveTurnIsForDifferentSession,
  shouldPollRemoteSession,
} from "~/playground/handoff";
import {
  createPlaygroundSession,
  loadPlaygroundEntriesFromEve,
  listPlaygroundSessions,
  reconcilePlaygroundSessionFromEve,
  setPlaygroundSessionModel,
  settleAbandonedPlaygroundSession,
  summarizePlaygroundSession,
} from "~/playground/sessions.server";
import { shouldSettleAbandonedSession } from "~/playground/settle";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import { newPlaygroundSessionPath } from "~/playground/url";
import { hasActiveTurn, TURN_IDLE_TIMEOUT_MS } from "~/chat/turn-stream.server";
import {
  agentFromParams,
  agentParamRedirect,
  resolveAgentContext,
  requireActiveAgent,
} from "~/project/agent-context.server";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.playground";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(auth, args.params.projectId, {
          request: args.request,
        }),
      );
      const agentName = agentFromParams(args.params);
      if (!agentName) {
        const legacy = agentParamRedirect(args.request, project.id);
        if (legacy) throw legacy;
      }
      const { roster, active, isTeam } = await resolveAgentContext(
        project.id,
        agentName,
      );
      requireActiveAgent(active, project.id);
      // Teams have no repo-level Playground — the tab exists only at the member level.
      if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);

      const [initialTargets, sessions, defaultSelection] = await Promise.all([
        liveTargets(active.id),
        listPlaygroundSessions({
          projectId: project.id,
          agentId: active.id,
          userId: auth.user!.id,
        }),
        // The selector's default: the agent's configured model, resolved by name from harnesst's
        // control plane (never parsed from agent.ts). Best-effort — a lookup hiccup must not
        // take down the playground.
        resolveAgentModel(project.orgId, active.name)
          .then((r) => ({ model: r?.model ?? null, effort: r?.effort ?? null }))
          .catch(() => ({ model: null, effort: null })),
      ]);
      const selectedSessionId = args.url.searchParams.get("session");
      let currentSession =
        (selectedSessionId
          ? sessions.find((session) => session.id === selectedSessionId)
          : null) ??
        sessions[0] ??
        null;
      let targets = initialTargets;
      let entries: ChatEntry[] = [];
      let historyError: string | null = null;
      let currentSessionOwnerLive: boolean | null = null;
      if (currentSession) {
        // Wake-on-view (#288): the transcript lives in eve's durable stream, so viewing a
        // conversation whose HOME environment is scaled to zero starts it. A bound session is
        // served only by its own environment's world store (a cross-environment eve never saw
        // the session and hangs, not 404s, on unknown ids), so the home environment is woken
        // even while siblings are live, and nothing else is ever asked for the history.
        const sessionEnvironmentId = currentSession.environmentId;
        if (
          currentSession.externalSessionId &&
          sessionEnvironmentId &&
          !targets.some((t) => t.environmentId === sessionEnvironmentId)
        ) {
          if (await ensureLiveDeploymentForEnvironment(sessionEnvironmentId)) {
            targets = await liveTargets(active.id);
          }
        }
        const historyTarget = currentSession.externalSessionId
          ? (targets.find((t) => t.environmentId === sessionEnvironmentId) ??
            null)
          : (targets[0] ?? null);
        const ownerDeploymentLive = historyTarget !== null;
        currentSessionOwnerLive = ownerDeploymentLive;
        // Recover a session whose drain died with the harnesst process (restart/redeploy mid-turn):
        // stuck "running", or marked "failed" even though Eve actually finished. Reconciling
        // settles the status from Eve and advances the cursor, so the recovered final reply is
        // part of the eve render below — not just a status flip. A turn actively streaming in
        // this process is skipped, so the 2s reconnect poll never re-opens an Eve stream for a
        // healthy running session.
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
            // Eve unreachable (e.g. the instance is also gone) — leave status as-is; a later load retries.
          }
        }

        // Still `running` with no drain that could ever finish it (nothing live to serve it,
        // or Eve has been silent past the drain's own idle budget)? Settle it to `failed` so the
        // session stops reading as busy and the 2s reconnect poll ends — otherwise a redeploy
        // mid-turn leaves the playground "thinking" forever with no way to stop it (#73).
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

        // The transcript renders from eve's durable stream (#288) — harnesst keeps no copy.
        if (
          currentSession.externalSessionId &&
          currentSession.streamIndex > 0
        ) {
          if (historyTarget) {
            try {
              entries = await loadPlaygroundEntriesFromEve({
                session: currentSession,
                target: historyTarget,
              });
            } catch (error) {
              historyError = `Couldn't load the conversation history: ${(error as Error).message}`;
            }
          } else {
            historyError =
              "The conversation history lives on the agent's instance, which harnesst couldn't reach or wake — it will load once the agent is reachable.";
          }
        }
      }
      return {
        project,
        targets,
        sessions: sessions.map((session) =>
          summarizePlaygroundSession(session),
        ),
        currentSessionId: currentSession?.id ?? null,
        currentSessionEnvironmentId: currentSession?.environmentId ?? null,
        currentSessionStatus: currentSession?.status ?? null,
        currentSessionOwnerLive,
        currentSessionModelId: currentSession?.modelId ?? null,
        currentSessionEffort:
          (currentSession?.effort as ReasoningEffort | null) ?? null,
        defaultModelId: defaultSelection.model,
        defaultEffort: defaultSelection.effort,
        entries,
        historyError,
        roster: roster.map((a) => ({ name: a.name })),
        activeAgent: active.name,
        isTeam,
      };
    },
    { ensureSignedIn: true },
  );

/** The action creates a new harnesst session row; turns go through the stream route. */
export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const agentName = agentFromParams(args.params);
  const { active, isTeam } = await resolveAgentContext(project.id, agentName);
  requireActiveAgent(active, project.id);
  if (isTeam && !agentName) throw redirect(`/repos/${project.id}`);

  const form = await args.request.formData();
  if (String(form.get("intent")) === "new-session") {
    const session = await createPlaygroundSession({
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      surface: "playground",
    });
    throw redirect(newPlaygroundSessionPath(args.url, session.id));
  }
  // Persist the selector on change (not just on send) so the choice survives a reload.
  if (String(form.get("intent")) === "set-session-model") {
    const sessionId = String(form.get("playgroundSessionId") ?? "");
    const modelId = String(form.get("modelId") ?? "").trim();
    const effortValue = String(form.get("effort") ?? "").trim();
    const effort =
      effortValue && isReasoningEffort(effortValue) ? effortValue : null;
    if (effortValue && !effort)
      return { error: "That reasoning effort is not valid." };
    if (sessionId && modelId) {
      const model = await findWorkspaceModel(project.orgId, modelId);
      if (!model) {
        return {
          error:
            "That model is not available from an active provider connection in this workspace.",
        };
      }
      if (effort && !model.supportedEfforts?.includes(effort)) {
        return {
          error:
            "That reasoning effort is not supported by the selected model.",
        };
      }
      await setPlaygroundSessionModel({
        id: sessionId,
        projectId: project.id,
        agentId: active.id,
        userId: auth.user.id,
        modelId,
        effort,
      });
    }
    return { ok: true as const };
  }
  return { ok: true as const };
}

export function meta() {
  return [{ title: "Playground · harnesst" }];
}

/**
 * Shared styling for the equal-height control pills (session, deployment, model, effort).
 * Height is left to the SelectTrigger's native h-9 — an explicit h-8 loses to the trigger's
 * own `data-[size=default]:h-9` on specificity, so pills would silently mismatch. Non-Select
 * pills (the model Button) pin `h-9` explicitly to line up.
 */
const CONTROL_PILL = "border-0 bg-muted/60 text-xs shadow-none hover:bg-muted";

/** Local mirror of an in-flight turn, driven by the NDJSON stream. */
interface LiveTurn {
  playgroundSessionId: string | null;
  /**
   * How many loader entries existed when this turn was launched. Anything the loader appends
   * past this boundary IS this turn (persisted by the drain mid-flight) — `shownEntries` hides
   * it while `live` still renders the turn, without touching earlier entries.
   */
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

export default function Playground({ loaderData }: Route.ComponentProps) {
  const {
    project,
    targets,
    sessions,
    currentSessionId,
    currentSessionEnvironmentId,
    currentSessionStatus,
    currentSessionOwnerLive,
    currentSessionModelId,
    currentSessionEffort,
    defaultModelId,
    defaultEffort,
    entries,
    historyError,
    roster,
    activeAgent,
    isTeam,
  } = loaderData;
  const base = contextPath(project.id, isTeam ? activeAgent : null);
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const newSessionFetcher = useFetcher<typeof action>();
  const NewSessionForm = newSessionFetcher.Form;
  const modelFetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();

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
  // The user's not-yet-persisted selector choice; the stored session override wins otherwise.
  const [selectionOverride, setSelectionOverride] = useState<{
    model: string;
    effort: ReasoningEffort | null;
  } | null>(null);
  useEffect(() => {
    setSelectionOverride(null);
  }, [currentSessionId]);
  const selectedModelId = selectionOverride?.model ?? currentSessionModelId;
  const selectedEffort = selectionOverride
    ? selectionOverride.effort
    : currentSessionModelId
      ? currentSessionEffort
      : defaultEffort;
  const [sendError, setSendError] = useState<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const remoteBusy = currentSessionStatus === "running";
  const busy = (live !== null && !live.done) || remoteBusy;
  const creatingSession = newSessionFetcher.state !== "idle";
  const pollRemoteSession = shouldPollRemoteSession(remoteBusy, visibleLive);
  // Keep the display state separate from polling: a completed errored bubble can remain visible
  // while the loader polls for the detached server drain to finish caching the reply.
  const replayingRunningSession = remoteBusy && !visibleLive;

  useEffect(() => {
    if (!pollRemoteSession) return;
    const id = window.setInterval(() => {
      // Skip a tick while the previous revalidation is still in flight — firing anyway cancels
      // the running loader (visible as a refresh-loop of aborted .data requests when the loader
      // is slow, e.g. blocked on an unresponsive Eve instance) (#73).
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2_000);
    return () => window.clearInterval(id);
  }, [pollRemoteSession, revalidator]);

  const defaultTarget =
    targets.find((t) => t.environmentId === currentSessionEnvironmentId) ??
    targets[0];
  const requestedDeploymentId = searchParams.get("deployment");
  const selectedTarget =
    targets.find(
      (target) =>
        target.deploymentId === requestedDeploymentId &&
        (!currentSessionEnvironmentId ||
          target.environmentId === currentSessionEnvironmentId),
    ) ?? defaultTarget;
  const deploymentId = selectedTarget?.deploymentId ?? "";

  const sessionPicker = useMemo(() => {
    if (!currentSessionId || sessions.length === 0) return null;
    return (
      <Select
        value={currentSessionId}
        disabled={busy}
        onValueChange={(id) =>
          navigate(`${base}/playground?session=${encodeURIComponent(id)}`)
        }
      >
        <SelectTrigger
          className={cn(CONTROL_PILL, "w-56 gap-1.5")}
          aria-label="Playground session"
        >
          <MessageSquare
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {sessions.map((session) => (
            <SelectItem key={session.id} value={session.id}>
              {formatSessionLabel(session.title, session.updatedAt)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }, [base, busy, currentSessionId, navigate, sessions]);

  // The client-streamed `live` turn and the loader's cached transcript can briefly hold the SAME
  // turn at once: the reconnect fix persists events as they stream, so any revalidation while
  // `live` is active (turn completion, or recovering from a dropped stream) pulls that turn into
  // `entries` while `live` is still rendering it — the user message and reply appear twice until
  // `live` clears (a refresh, which drops `live`, is why it "fixes itself"). Entries only ever
  // append within a session, so everything past the count recorded at launch
  // (`live.baseEntryCount`) is the in-flight turn's cached copy — hide exactly that. (Matching by
  // turn position, not message text: a repeated message like "continue" must not slice off the
  // earlier identical turn.)
  const shownEntries = useMemo<ChatEntry[]>(() => {
    if (!visibleLive) return entries;
    // A session switch mid-turn shows the other session's transcript untouched.
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
      stopRequestedRef.current = false;
      setLive({
        playgroundSessionId: currentSessionId,
        baseEntryCount: entries.length,
        userText: message,
        text: "",
        steps: [],
        activity: "Thinking…",
        modelId: null,
        effort: selectedEffort,
        inputRequests: [],
        error: null,
        errorDetail: null,
        errorRetryable: false,
        done: false,
      });
      const apply = (evt: StreamEvent) =>
        setLive((prev) => (prev ? reduceLive(prev, evt) : prev));

      const form = new FormData();
      form.set("message", message);
      form.set("deploymentId", deploymentId);
      form.set("agentName", activeAgent);
      if (currentSessionId) form.set("playgroundSessionId", currentSessionId);
      // The current model selection applies to this and subsequent turns (and is persisted on
      // the session server-side, so a first-send selection survives the session's creation).
      if (selectedModelId) form.set("modelId", selectedModelId);
      // Effort rides along only with an explicit model selection: without one, the agent's
      // deployed fallback (which already encodes its own effort) handles the turn, and the
      // server rejects effort-only requests it can't validate against a model.
      if (selectedModelId && selectedEffort) form.set("effort", selectedEffort);

      const controller = new AbortController();
      streamAbortRef.current = controller;
      let res: Response;
      let body: NonNullable<Response["body"]>;
      try {
        res = await fetch(`/api/repos/${project.id}/playground/stream`, {
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
          if (res.status === 409) {
            streamAbortRef.current = null;
            setLive(null);
            setSendError(
              errorMessage ??
                "This conversation can no longer be continued. Start a new conversation.",
            );
            return false;
          }
          throw new Error(errorMessage ?? `Stream failed (${res.status}).`);
        }
        if (!res.body) throw new Error("The stream returned no response body.");
        body = res.body;
      } catch (error) {
        if (streamAbortRef.current === controller)
          streamAbortRef.current = null;
        setLive(null);
        setSendError((error as Error).message);
        await revalidator.revalidate();
        return false;
      }

      // HTTP success means the turn was accepted. Drain the durable stream in the
      // background so the shared composer can clear immediately without waiting for the
      // whole agent turn to finish.
      void (async () => {
        try {
          const reader = body.getReader();
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
              if (evt.type === "done" && evt.playgroundSessionId) {
                nextSessionId = evt.playgroundSessionId;
              }
              // A user-requested stop cancels the turn server-side, which flushes a
              // final "done" event carrying a "Turn was stopped." error before the
              // /stop fetch resolves. Don't fold that into the live view — stopTurn
              // clears it cleanly, so surfacing it here would only flash an error.
              if (stopRequestedRef.current && evt.type === "done") continue;
              apply(evt);
            }
          }
          // Stream ended — the server has persisted the cursor. Settle the live view (a stream
          // can close without a "done" event) and revalidate; the derived handoff hides `live`
          // once the revalidated entries cover this turn. If persistence failed, the live copy
          // stays on screen instead of the turn vanishing.
          setLive((prev) =>
            prev && !prev.done ? { ...prev, activity: null, done: true } : prev,
          );
          await revalidator.revalidate();
          if (!currentSessionId && nextSessionId) {
            navigate(
              `${base}/playground?session=${encodeURIComponent(nextSessionId)}`,
              {
                replace: true,
              },
            );
          }
          streamAbortRef.current = null;
        } catch (error) {
          streamAbortRef.current = null;
          if (stopRequestedRef.current) {
            await revalidator.revalidate();
            setLive(null);
            stopRequestedRef.current = false;
            return;
          }
          // The server still persists in the background — revalidate so the reply isn't lost.
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
          // No setLive(null): the handoff effect clears it once the revalidated entries include
          // the turn; until then the errored live view (with the user's message) stays visible.
          await revalidator.revalidate();
        }
      })();
      return true;
    },
    [
      activeAgent,
      base,
      currentSessionId,
      deploymentId,
      entries.length,
      navigate,
      project.id,
      revalidator,
      selectedModelId,
      selectedEffort,
    ],
  );

  const changeModel = useCallback(
    (modelId: string, effort: ReasoningEffort | null) => {
      setSelectionOverride({ model: modelId, effort });
      // Persist immediately when the conversation already exists; a brand-new conversation has
      // no row yet — the first send carries the selection and creates it with the override.
      if (currentSessionId) {
        modelFetcher.submit(
          {
            intent: "set-session-model",
            playgroundSessionId: currentSessionId,
            modelId,
            effort: effort ?? "",
          },
          { method: "post" },
        );
      }
    },
    [currentSessionId, modelFetcher],
  );

  const stopTurn = useCallback(async () => {
    const playgroundSessionId =
      visibleLive?.playgroundSessionId ?? currentSessionId;
    if (!playgroundSessionId || !deploymentId) return;
    setSendError(null);

    const form = new FormData();
    form.set("playgroundSessionId", playgroundSessionId);
    form.set("agentName", activeAgent);
    form.set("deploymentId", deploymentId);

    // Mark the stop up-front: cancelling the turn server-side can close the stream
    // (and flush a "Turn was stopped." error) before this fetch resolves, so the
    // stream loop needs to know a stop is in flight to treat that as a clean stop.
    stopRequestedRef.current = true;
    try {
      const res = await fetch(`/api/repos/${project.id}/playground/stop`, {
        method: "POST",
        body: form,
        // Don't let a slow Eve cancel hang the Stop button indefinitely.
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
          ? {
              ...prev,
              error: "Stopped by user.",
              activity: null,
              done: true,
            }
          : prev,
      );
      await revalidator.revalidate();
      setLive(null);
    } catch (error) {
      // The request itself failed — the turn may still be live, so let the stream
      // keep flowing normally instead of swallowing its events as a stop.
      stopRequestedRef.current = false;
      setSendError((error as Error).message);
    }
  }, [
    activeAgent,
    currentSessionId,
    deploymentId,
    visibleLive?.playgroundSessionId,
    project.id,
    revalidator,
  ]);

  // A slim "what this turn runs on" bar that sits just ABOVE the composer — the deployment and
  // model/effort pickers used to be jammed into the composer's send-row at mismatched sizes.
  // Pulling them out gives them room and keeps the input itself clean.
  const runSettings = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
        <span className="pl-1">Talking to</span>
        <Select
          value={deploymentId}
          onValueChange={(nextDeploymentId) => {
            const next = new URLSearchParams(searchParams);
            next.set("deployment", nextDeploymentId);
            setSearchParams(next, { replace: true });
          }}
          disabled={busy}
        >
          <SelectTrigger
            className={cn(CONTROL_PILL, "max-w-56 gap-1.5")}
            aria-label="Deployment to talk to"
          >
            <Server
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {targets.map((t: Target) => (
              <SelectItem key={t.deploymentId} value={t.deploymentId}>
                {t.version} · {t.environmentName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>with</span>
        <ModelSelection
          compact
          model={selectedModelId ?? defaultModelId}
          effort={selectedEffort}
          busy={false}
          disabled={busy}
          placeholder="Deployed model"
          triggerClassName={cn(CONTROL_PILL, "h-9 max-w-56 font-normal")}
          effortTriggerClassName={CONTROL_PILL}
          onCommit={changeModel}
        />
      </div>
    ),
    [
      busy,
      changeModel,
      defaultModelId,
      deploymentId,
      searchParams,
      selectedModelId,
      selectedEffort,
      setSearchParams,
      targets,
    ],
  );

  // The composer's own control slot carries only the Stop button, and only mid-turn — right
  // next to Send where an interrupt belongs.
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

  const headerActions = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-2">
        {sessionPicker}
        <NewSessionForm method="post">
          <input type="hidden" name="intent" value="new-session" />
          <Button
            type="submit"
            variant="outline"
            size="lg"
            disabled={busy || creatingSession}
          >
            <Plus aria-hidden />
            New conversation
          </Button>
        </NewSessionForm>
      </div>
    ),
    [NewSessionForm, busy, creatingSession, sessionPicker],
  );

  const transcriptLead = useMemo(
    () => (
      <>
        <PageHeader
          icon={FlaskConical}
          accent="blue"
          title={isTeam ? `Playground — ${activeAgent}` : "Playground"}
          description="Talk to a live deployment of this agent. Conversation history lives in the agent's durable session store and survives redeploys."
          actions={headerActions}
        />
        {targets.length === 0 && (
          <Alert className="mb-4">
            <AlertTitle>No live deployment to talk to</AlertTitle>
            <AlertDescription>
              Deploy from the Deployment tab to start a new conversation.
            </AlertDescription>
          </Alert>
        )}
        {historyError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{historyError}</AlertDescription>
          </Alert>
        )}
        {sendError && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{sendError}</AlertDescription>
          </Alert>
        )}
      </>
    ),
    [
      activeAgent,
      headerActions,
      historyError,
      isTeam,
      sendError,
      targets.length,
    ],
  );

  return (
    <AppShell
      fullHeight
      breadcrumbs={repoCrumbs({
        projectId: project.id,
        repoName: project.name,
        isTeam,
        agentName: activeAgent,
        tail: [{ label: "Playground" }],
      })}
    >
      <div className="mx-auto w-full max-w-5xl px-4 pt-8 sm:px-6">
        <AgentNav
          base={base}
          level={isTeam ? "member" : "single"}
          roster={roster}
          activeAgent={isTeam ? activeAgent : undefined}
          className="mb-0"
        />
      </div>

      <ChatTranscript
        dep={`${shownEntries.length}:${shownEntries.at(-1)?.text.length ?? 0}:${shownEntries.at(-1)?.steps?.length ?? 0}:${currentSessionStatus ?? ""}:${visibleLive ? visibleLive.text.length + visibleLive.steps.length + visibleLive.inputRequests.length : 0}`}
        forceScrollDep={visibleLive?.userText}
        lead={transcriptLead}
      >
        {shownEntries.length === 0 && !visibleLive && !remoteBusy && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Say something to the agent — the conversation keeps its context
            across turns.
          </p>
        )}
        {shownEntries.map((e, i) =>
          e.role === "user" ? (
            <UserBubble key={e.id} text={e.text} />
          ) : (
            <AgentEntry
              key={e.id}
              entry={e}
              // Only the newest turn's pending requests are answerable.
              onAnswer={
                i === shownEntries.length - 1 && !visibleLive ? send : undefined
              }
              onRetry={
                i === shownEntries.length - 1 &&
                !visibleLive &&
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
            <StepsCard
              steps={[]}
              idPrefix="running-session"
              activity="Still working…"
            />
          )}
        {/* A turn the loader settled as unrecoverable (deployment replaced mid-turn, or the
                stream went silent past its budget) — say so instead of ending on the user's
                message with no explanation. */}
        {currentSessionStatus === "failed" &&
          !visibleLive &&
          shownEntries.at(-1)?.role === "user" && (
            <AssistantBubble>
              <p className="text-sm text-muted-foreground">
                {currentSessionOwnerLive
                  ? "This turn was interrupted before it finished. Send the message again to retry."
                  : "This turn was interrupted before it finished while the agent was unreachable. Send your message again to retry."}
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

      {targets.length > 0 && (
        <div className="mx-auto w-full max-w-5xl px-4 pb-4 pt-3 sm:px-6">
          <div className="mb-2">{runSettings}</div>
          <ChatComposer
            placeholder={
              isTeam
                ? `Say something to ${activeAgent}...`
                : "Say something to the agent..."
            }
            busy={busy}
            onSend={send}
            controls={composerControls}
          />
        </div>
      )}
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

/** Fold one stream event into the live turn state (pure — safe inside a functional setState). */
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

function formatModelAttribution(
  modelId: string,
  effort: ReasoningEffort | null,
): string {
  return effort ? `${modelId} · ${effort} effort` : modelId;
}

/**
 * The live, in-flight assistant turn: the reply streams first, followed by the collapsed
 * steps card (spinner + what it's doing right now) so activity stays near the scroll bottom.
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
    <div className="space-y-2">
      {(live.text || live.error || live.inputRequests.length > 0) && (
        <AssistantBubble>
          {live.modelId && (
            <span className="mb-1.5 flex items-center gap-1.5">
              {!live.done && (
                <span
                  className="size-1.5 animate-pulse rounded-full bg-blue-500"
                  aria-hidden
                />
              )}
              <span className="font-mono text-xs text-muted-foreground">
                {formatModelAttribution(live.modelId, live.effort)}
              </span>
            </span>
          )}
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
  onAnswer?: (text: string) => void;
  /** Set on the newest errored entry only — resends the message to retry the turn. */
  onRetry?: () => void;
  busy?: boolean;
  running?: boolean;
}) {
  // A still-running turn rebuilt from the event cache (e.g. after navigating away and back
  // mid-turn) has steps but no reply text yet. Rendering the "(empty reply)" fallback there
  // reads as a broken message — suppress the bubble and let the steps card carry the
  // "Still working…" state, matching LiveBubble.
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
          {entry.version && (
            <span className="mb-1.5 flex items-center gap-1.5">
              <Badge variant="secondary" className="text-xs">
                {entry.version}
              </Badge>
              {entry.modelId && (
                <span className="font-mono text-xs text-muted-foreground">
                  {formatModelAttribution(entry.modelId, entry.effort ?? null)}
                </span>
              )}
            </span>
          )}
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
