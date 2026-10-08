/**
 * The chat composer.
 *
 * - Drafts persist per conversation (`draftKey`): text to localStorage, attachments + queued
 *   messages in memory for the tab. Switching sessions and coming back restores everything.
 * - Attachments: paste (screenshots straight from the clipboard), drag-and-drop anywhere on the
 *   page, or the paperclip. Big photos are downscaled client-side before upload.
 * - Never locks while the agent works: Enter queues the message and it sends itself when the turn
 *   ends. Esc (or the stop button) stops the turn and pulls the queue back into the box.
 * - ↑ on an empty box recalls previous messages; typing anywhere on the page focuses the box.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlarmClock,
  ArrowUp,
  Clock,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Send,
  Square,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import {
  filesFromDataTransfer,
  prepareAttachments,
  releaseAttachment,
} from "./attachments-client";
import {
  loadDraftAttachments,
  loadDraftText,
  loadHistory,
  loadQueue,
  moveDraft,
  pushHistory,
  saveDraftAttachments,
  saveDraftText,
  saveHistory,
  saveQueue,
  type DraftAttachment,
  type QueuedMessage,
} from "./drafts";
import { openLightbox } from "./lightbox";
import {
  formatCountdown,
  insertScheduled,
  loadScheduled,
  moveScheduled,
  partitionDue,
  saveScheduled,
  scheduledAttachments,
  schedulePresets,
  setScheduledAttachments,
  toLocalInputValue,
  type ScheduledMessage,
} from "./scheduled";

const MAX_COMPOSER_HEIGHT = 240;
/** Pastes longer than this become a text attachment instead of flooding the box. */
const LONG_PASTE_CHARS = 16_000;

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ---- external handle: lets a transcript "Edit" button load text into the composer ----------

type ComposerHandle = { load: (text: string) => void };
let activeComposer: ComposerHandle | null = null;

/** Put `text` into the page's composer (replacing its content) and focus it. */
export function loadIntoComposer(text: string): boolean {
  if (!activeComposer) return false;
  activeComposer.load(text);
  return true;
}

let queueSeq = 0;

export function ChatComposer({
  placeholder,
  busy,
  busyHint,
  disabled = false,
  initialValue,
  focusKey,
  draftKey,
  onSend,
  onStop,
  controls,
  allowAttachments = false,
  historyScope = "chat",
  carryDraftFrom,
}: {
  placeholder: string;
  busy: boolean;
  /** What the surface is waiting on while `busy` — shown with a spinner in the toolbar. */
  busyHint?: string;
  /** Disable composing entirely (e.g. an approval must be resolved first). */
  disabled?: boolean;
  /** Seed the composer's text (e.g. a publish failure handed off as context to fix). */
  initialValue?: string;
  /** Refocus the composer when the surrounding conversation changes. */
  focusKey?: unknown;
  /** Stable id of the conversation this draft belongs to (e.g. `foh:<sessionId>`). */
  draftKey?: string;
  /** Resolve true once the server accepts the turn; false keeps the draft for retry. */
  onSend: (message: string, attachments: File[]) => Promise<boolean>;
  /** Stops the in-flight turn. When given, the send button becomes Stop while busy. */
  onStop?: () => void;
  /** Optional controls rendered in the toolbar, left of the send button (e.g. a picker). */
  controls?: ReactNode;
  /** Whether this surface accepts images/files. */
  allowAttachments?: boolean;
  /** Namespace for ↑-recall history. */
  historyScope?: string;
  /**
   * A placeholder `draftKey` (e.g. `playground:<project>:new`) whose unsent state should follow
   * the conversation when, after a send from it, the key switches to the conversation's real id.
   */
  carryDraftFrom?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const key = draftKey ?? "";
  const keyRef = useRef(key);
  const [hasText, setHasText] = useState(false);
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>([]);
  const [queue, setQueueState] = useState<QueuedMessage[]>([]);
  const [scheduled, setScheduledState] = useState<ScheduledMessage[]>([]);
  const [pickingTime, setPickingTime] = useState(false);
  const [customTime, setCustomTime] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState(false);
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIdx = useRef<number | null>(null);
  /** The key the last message was sent from — gates the placeholder-key carry-over. */
  const lastSendKeyRef = useRef<string | null>(null);
  // Latest `onSend`, synced after commit (not during render) so `dispatch` — and the drain effect
  // that depends on it — keep a stable identity.
  const onSendRef = useRef(onSend);
  useLayoutEffect(() => {
    onSendRef.current = onSend;
  });
  const dispatch = useCallback((text: string, files: File[]) => {
    lastSendKeyRef.current = keyRef.current;
    return onSendRef.current(text, files);
  }, []);

  const setAttachments = useCallback(
    (update: (prev: DraftAttachment[]) => DraftAttachment[]) => {
      setAttachmentsState((prev) => {
        const next = update(prev);
        saveDraftAttachments(keyRef.current, next);
        return next;
      });
    },
    [],
  );
  const setQueue = useCallback(
    (update: (prev: QueuedMessage[]) => QueuedMessage[]) => {
      setQueueState((prev) => {
        const next = update(prev);
        saveQueue(keyRef.current, next);
        return next;
      });
    },
    [],
  );

  const setScheduled = useCallback(
    (update: (prev: ScheduledMessage[]) => ScheduledMessage[]) => {
      setScheduledState((prev) => {
        const next = update(prev);
        saveScheduled(keyRef.current, next);
        return next;
      });
    },
    [],
  );

  const flushDraft = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (ref.current) saveDraftText(keyRef.current, ref.current.value);
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (ref.current) saveDraftText(keyRef.current, ref.current.value);
    }, 250);
  }, []);

  const setText = useCallback(
    (text: string, { save = true }: { save?: boolean } = {}) => {
      const el = ref.current;
      if (!el) return;
      el.value = text;
      autoGrow(el);
      setHasText(text.trim().length > 0);
      if (save) scheduleSave();
    },
    [scheduleSave],
  );

  // Load the draft for this conversation (mount + every switch). Flush the old one first so a
  // fast switch never loses the last keystrokes.
  useEffect(() => {
    const prev = keyRef.current;
    if (
      carryDraftFrom &&
      prev === carryDraftFrom &&
      prev !== key &&
      lastSendKeyRef.current === prev
    ) {
      moveDraft(prev, key);
      moveScheduled(prev, key);
    }
    keyRef.current = key;
    const seeded = initialValue != null && initialValue !== "";
    setText(seeded ? initialValue : loadDraftText(key), { save: seeded });
    setAttachmentsState(loadDraftAttachments(key));
    setQueueState(loadQueue(key));
    setScheduledState(loadScheduled(key));
    setPickingTime(false);
    historyIdx.current = null;
    return () => flushDraft();
    // initialValue is handled by its own effect below once mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (initialValue == null || ref.current?.value === initialValue) return;
    setText(initialValue);
  }, [initialValue, setText]);

  useEffect(() => {
    historyRef.current = loadHistory(historyScope);
  }, [historyScope]);

  // Save on tab close too.
  useEffect(() => {
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [flushDraft]);

  useEffect(() => {
    if (!disabled) ref.current?.focus({ preventScroll: true });
  }, [focusKey, disabled, key]);

  // Expose load() for transcript "Edit" buttons.
  useEffect(() => {
    const handle: ComposerHandle = {
      load: (text) => {
        setText(text);
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      },
    };
    activeComposer = handle;
    return () => {
      if (activeComposer === handle) activeComposer = null;
    };
  }, [setText]);

  // Type anywhere → focus the composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (disabled || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (document.querySelector('[role="dialog"]')) return;
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled]);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!allowAttachments || files.length === 0) return;
      const origin = keyRef.current;
      const current = loadDraftAttachments(origin);
      const { added, rejected } = await prepareAttachments(current, files);
      for (const r of rejected) toast.error(`Couldn't attach ${r.name}: ${r.reason}`);
      if (added.length === 0) return;
      // Downscaling is async: if the user switched conversations meanwhile, the files still
      // belong to the draft they were dropped on.
      if (keyRef.current !== origin) {
        saveDraftAttachments(origin, [...loadDraftAttachments(origin), ...added]);
        return;
      }
      setAttachments((prev) => [...prev, ...added]);
      ref.current?.focus();
    },
    [allowAttachments, setAttachments],
  );

  const removeAttachment = (id: string) =>
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) releaseAttachment(gone);
      return prev.filter((a) => a.id !== id);
    });

  // Drag files anywhere on the page.
  useEffect(() => {
    if (!allowAttachments) return;
    let depth = 0;
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void addFiles(filesFromDataTransfer(e.dataTransfer));
    };
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
    };
  }, [allowAttachments, addFiles]);

  const rememberSent = (text: string) => {
    if (!text) return;
    historyRef.current = pushHistory(historyRef.current, text);
    saveHistory(historyScope, historyRef.current);
  };

  const submit = async () => {
    const el = ref.current;
    if (!el || disabled) return;
    const text = el.value.trim();
    const atts = attachments;
    if (!text && atts.length === 0) return;
    // An in-flight send leaves the draft populated until it's accepted; queueing it again here
    // would send the same message twice.
    if (sendingRef.current) return;

    if (busy) {
      queueSeq += 1;
      setQueue((prev) => [
        ...prev,
        { id: `q-${queueSeq}`, text, attachments: atts },
      ]);
      rememberSent(text);
      // The queued message owns these attachments now — clear without revoking previews.
      setText("", { save: false });
      saveDraftText(keyRef.current, "");
      setAttachments(() => []);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    const origin = keyRef.current;
    let accepted = false;
    try {
      accepted = await dispatch(
        text,
        atts.map((a) => a.file),
      );
    } catch {
      // A rejected callback is a refused request: keep the draft.
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
    if (accepted) {
      rememberSent(text);
      const sent = new Set(atts);
      for (const a of atts) releaseAttachment(a);
      // The upload can outlast a conversation switch: clear the draft the message was sent from,
      // never whichever conversation happens to be open now.
      if (keyRef.current !== origin) {
        if (loadDraftText(origin).trim() === text) saveDraftText(origin, "");
        saveDraftAttachments(
          origin,
          loadDraftAttachments(origin).filter((a) => !sent.has(a)),
        );
        return;
      }
      if (ref.current?.value.trim() === text) {
        setText("", { save: false });
        saveDraftText(origin, "");
      }
      setAttachments((prev) => prev.filter((a) => !sent.has(a)));
      return;
    }
    if (keyRef.current !== origin) return;
    const current = ref.current;
    if (!current) return;
    autoGrow(current);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // Drain the queue one message at a time whenever the agent is free.
  const drainingRef = useRef(false);
  useEffect(() => {
    if (busy || disabled || sending || drainingRef.current || queue.length === 0)
      return;
    const [head, ...rest] = queue;
    if (!head) return;
    drainingRef.current = true;
    const origin = keyRef.current;
    setQueue(() => rest);
    void dispatch(
      head.text,
      head.attachments.map((a) => a.file),
    )
      .catch(() => false)
      .then((ok) => {
        if (ok) {
          for (const a of head.attachments) releaseAttachment(a);
          return;
        }
        // Refused: put it back in the box rather than retrying forever — in the conversation it
        // was queued in, even if the user has since navigated away.
        if (keyRef.current !== origin) {
          const existing = loadDraftText(origin).trim();
          saveDraftText(origin, [head.text, existing].filter(Boolean).join("\n\n"));
          saveDraftAttachments(origin, [...head.attachments, ...loadDraftAttachments(origin)]);
          return;
        }
        const el = ref.current;
        const existing = el?.value.trim() ?? "";
        setText([head.text, existing].filter(Boolean).join("\n\n"));
        setAttachments((prev) => [...head.attachments, ...prev]);
      })
      .finally(() => {
        drainingRef.current = false;
      });
  }, [busy, disabled, sending, queue, setQueue, setAttachments, setText, dispatch]);

  // Scheduled sends: tick while any are pending; due ones join the queue (so they still wait for
  // a running turn). Also re-check when the tab regains focus — timers throttle in the background.
  useEffect(() => {
    if (scheduled.length === 0) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const { due, pending } = partitionDue(scheduled, t);
      if (due.length === 0) return;
      setScheduled(() => pending);
      const ready: QueuedMessage[] = [];
      const lost: typeof due = [];
      for (const m of due) {
        const atts = scheduledAttachments(m.id);
        setScheduledAttachments(m.id, []);
        // Files live in memory only; a reload keeps the names but drops the bytes. Sending the
        // text alone would silently drop the attachments, so hand it back instead.
        if (m.attachmentNames.length > 0 && atts.length < m.attachmentNames.length) lost.push(m);
        else ready.push({ id: m.id, text: m.text, attachments: atts });
      }
      if (ready.length) {
        setQueue((prev) => [...prev, ...ready]);
        toast(
          ready.length === 1
            ? "Sending scheduled message"
            : `Sending ${ready.length} scheduled messages`,
        );
      }
      if (lost.length) {
        const existing = ref.current?.value.trim() ?? "";
        setText([...lost.map((m) => m.text), existing].filter(Boolean).join("\n\n"));
        toast.error(
          `A scheduled message's attachments were lost when the page reloaded (${lost
            .flatMap((m) => m.attachmentNames)
            .join(", ")}). Re-attach them and send.`,
        );
      }
    };
    tick();
    const timer = setInterval(tick, 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [scheduled, setScheduled, setQueue, setText]);

  const scheduleCurrent = (dueAt: number) => {
    const el = ref.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text && attachments.length === 0) return;
    if (!Number.isFinite(dueAt) || dueAt <= Date.now()) {
      toast.error("Pick a time in the future");
      return;
    }
    queueSeq += 1;
    const id = `s-${Date.now().toString(36)}-${queueSeq}`;
    setScheduledAttachments(id, attachments);
    setScheduled((prev) =>
      insertScheduled(prev, {
        id,
        text,
        dueAt,
        attachmentNames: attachments.map((a) => a.name),
      }),
    );
    rememberSent(text);
    setText("", { save: false });
    saveDraftText(keyRef.current, "");
    setAttachments(() => []);
    setPickingTime(false);
    toast(`Scheduled for ${new Date(dueAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  };

  const unschedule = (id: string, mode: "edit" | "cancel" | "now") => {
    const item = scheduled.find((m) => m.id === id);
    setScheduled((prev) => prev.filter((m) => m.id !== id));
    if (!item) return;
    const atts = scheduledAttachments(id);
    setScheduledAttachments(id, []);
    if (mode === "now") {
      setQueue((prev) => [...prev, { id, text: item.text, attachments: atts }]);
    } else if (mode === "edit") {
      const existing = ref.current?.value.trim() ?? "";
      setText([item.text, existing].filter(Boolean).join("\n\n"));
      setAttachments((prev) => [...atts, ...prev]);
      ref.current?.focus();
    } else {
      atts.forEach(releaseAttachment);
    }
  };

  /**
   * Interrupt: stop the running turn and send this next. The message jumps the queue; the drain
   * effect fires it the moment the stopped turn settles.
   */
  const interruptWith = (item: QueuedMessage) => {
    setQueue((prev) => [item, ...prev.filter((q) => q.id !== item.id)]);
    onStop?.();
  };

  const interruptCurrent = () => {
    const el = ref.current;
    if (!el || !onStop) return;
    const text = el.value.trim();
    if (!text && attachments.length === 0) return;
    queueSeq += 1;
    rememberSent(text);
    interruptWith({ id: `q-${queueSeq}`, text, attachments });
    setText("", { save: false });
    saveDraftText(keyRef.current, "");
    setAttachments(() => []);
  };

  const unqueue = (id: string, edit: boolean) => {
    const item = queue.find((q) => q.id === id);
    setQueue((prev) => prev.filter((q) => q.id !== id));
    if (!item) return;
    if (edit) {
      const existing = ref.current?.value.trim() ?? "";
      setText([item.text, existing].filter(Boolean).join("\n\n"));
      setAttachments((prev) => [...item.attachments, ...prev]);
      ref.current?.focus();
    } else {
      item.attachments.forEach(releaseAttachment);
    }
  };

  const stop = () => {
    if (!onStop) return;
    // Stopping means "hold on" — the queue comes back to the box instead of firing next.
    if (queue.length > 0) {
      const existing = ref.current?.value.trim() ?? "";
      setText(
        [...queue.map((q) => q.text), existing].filter(Boolean).join("\n\n"),
      );
      setAttachments((prev) => [
        ...queue.flatMap((q) => q.attachments),
        ...prev,
      ]);
      setQueue(() => []);
    }
    onStop();
  };

  const recall = (direction: -1 | 1): boolean => {
    const history = historyRef.current;
    if (history.length === 0) return false;
    const idx = historyIdx.current;
    if (direction === -1) {
      const next = idx == null ? history.length - 1 : Math.max(0, idx - 1);
      historyIdx.current = next;
      setText(history[next]!, { save: false });
      return true;
    }
    if (idx == null) return false;
    if (idx >= history.length - 1) {
      historyIdx.current = null;
      setText("", { save: false });
      return true;
    }
    historyIdx.current = idx + 1;
    setText(history[idx + 1]!, { save: false });
    return true;
  };

  const hasContent = hasText || attachments.length > 0;
  const showStop = busy && Boolean(onStop) && !hasContent;
  const imageAttachments = attachments.filter((a) => a.previewUrl);

  return (
    <>
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-[90] flex animate-in items-center justify-center rounded-3xl border-2 border-dashed border-primary/60 bg-primary/[0.06] backdrop-blur-[1px] fade-in-0">
          <div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-5 py-3 text-sm font-medium shadow-lg">
            <Paperclip className="size-4 text-primary" />
            Drop files to attach
          </div>
        </div>
      )}

      {pickingTime && (
        <div className="chat-row-in mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm shadow-sm">
          <AlarmClock className="size-4 shrink-0 text-primary" />
          <span className="text-muted-foreground">Send at</span>
          <input
            type="datetime-local"
            aria-label="Send at"
            value={customTime}
            min={toLocalInputValue(Date.now())}
            onChange={(e) => setCustomTime(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                scheduleCurrent(new Date(customTime).getTime());
              } else if (e.key === "Escape") setPickingTime(false);
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            autoFocus
          />
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPickingTime(false)}
              className="h-8 rounded-md px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!hasContent || !customTime}
              onClick={() => scheduleCurrent(new Date(customTime).getTime())}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-40"
            >
              Schedule
            </button>
          </span>
        </div>
      )}

      {scheduled.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {scheduled.map((m) => (
            <div
              key={m.id}
              className="chat-row-in flex items-center gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2 text-sm"
            >
              <AlarmClock className="size-3.5 shrink-0 text-primary" />
              <span
                className="shrink-0 text-[11px] font-medium text-primary tabular-nums"
                title={new Date(m.dueAt).toLocaleString()}
              >
                {formatCountdown(m.dueAt, now)}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {m.text ||
                  `${m.attachmentNames.length} attachment${m.attachmentNames.length === 1 ? "" : "s"}`}
              </span>
              {m.attachmentNames.length > 0 && m.text && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {m.attachmentNames.length}
                </span>
              )}
              <button
                type="button"
                onClick={() => unschedule(m.id, "now")}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Send scheduled message now"
                title="Send now"
              >
                <Send className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => unschedule(m.id, "edit")}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Edit scheduled message"
                title="Edit"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => unschedule(m.id, "cancel")}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Cancel scheduled message"
                title="Cancel"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {queue.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {queue.map((q, i) => (
            <div
              key={q.id}
              className="chat-row-in flex items-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-3 py-2 text-sm"
            >
              <Clock className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 text-[11px] font-medium text-muted-foreground uppercase">
                {i === 0 ? "Next" : "Queued"}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {q.text ||
                  `${q.attachments.length} attachment${q.attachments.length === 1 ? "" : "s"}`}
              </span>
              {q.attachments.length > 0 && q.text && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="size-3" />
                  {q.attachments.length}
                </span>
              )}
              {busy && onStop && (
                <button
                  type="button"
                  onClick={() => interruptWith(q)}
                  className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Interrupt and send this now"
                  title="Stop the current turn and send this now"
                >
                  <Zap className="size-3.5" />
                  <span className="hidden sm:inline">Send now</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => unqueue(q.id, true)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Edit queued message"
                title="Edit"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => unqueue(q.id, false)}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Remove queued message"
                title="Remove"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          "rounded-3xl border border-border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.18)] transition-colors focus-within:border-foreground/20 dark:shadow-none",
          disabled && "bg-muted/30",
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a) =>
              a.previewUrl ? (
                <div
                  key={a.id}
                  className="group/att relative size-16 overflow-hidden rounded-lg border border-border bg-muted"
                >
                  <button
                    type="button"
                    className="size-full"
                    onClick={() =>
                      openLightbox(
                        imageAttachments.map((x) => ({
                          src: x.previewUrl!,
                          alt: x.name,
                        })),
                        imageAttachments.findIndex((x) => x.id === a.id),
                      )
                    }
                    aria-label={`Preview ${a.name}`}
                  >
                    <img
                      src={a.previewUrl}
                      alt={a.name}
                      className="size-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-90 transition hover:bg-black/80 sm:opacity-0 sm:group-hover/att:opacity-100"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : (
                <div
                  key={a.id}
                  className="group/att flex h-16 max-w-56 items-center gap-2 rounded-lg border border-border bg-muted/50 pr-1.5 pl-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <FileText className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">
                      {a.name}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {formatBytes(a.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}
        <Textarea
          ref={ref}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={1}
          className="max-h-60 min-h-12 resize-none border-0 bg-transparent px-5 pt-4 pb-2 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent sm:text-sm dark:bg-transparent dark:disabled:bg-transparent"
          disabled={disabled}
          onInput={(e) => {
            autoGrow(e.currentTarget);
            setHasText(e.currentTarget.value.trim().length > 0);
            historyIdx.current = null;
            scheduleSave();
          }}
          onBlur={flushDraft}
          onPaste={(e) => {
            if (!allowAttachments) return;
            const files = filesFromDataTransfer(e.clipboardData);
            const plain = e.clipboardData.getData("text/plain");
            const hasImage = files.some((f) => f.type.startsWith("image/"));
            if (files.length > 0 && (hasImage || !plain)) {
              e.preventDefault();
              void addFiles(files);
              return;
            }
            if (plain.length > LONG_PASTE_CHARS) {
              e.preventDefault();
              const file = new File([plain], `pasted-text-${Date.now().toString(36)}.txt`, {
                type: "text/plain",
              });
              void addFiles([file]);
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              toast("Long paste attached as a file", {
                action: {
                  label: "Paste inline",
                  onClick: () => {
                    setAttachments((prev) => {
                      const hit = prev.find((a) => a.file === file);
                      return hit ? prev.filter((a) => a !== hit) : prev;
                    });
                    const v = ref.current?.value ?? "";
                    setText(v.slice(0, start) + plain + v.slice(end));
                  },
                },
              });
            }
          }}
          onKeyDown={(e) => {
            const composing =
              e.nativeEvent.isComposing || e.keyCode === 229;
            if (e.key === "Enter" && !e.shiftKey && !composing) {
              e.preventDefault();
              if (busy && onStop && (e.metaKey || e.ctrlKey)) interruptCurrent();
              else void submit();
              return;
            }
            if (e.key === "Escape" && busy && onStop) {
              e.preventDefault();
              stop();
              return;
            }
            const el = e.currentTarget;
            const noMods = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
            if (e.key === "ArrowUp" && noMods && !composing) {
              const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
              if ((el.value === "" || (historyIdx.current != null && atStart)) && recall(-1))
                e.preventDefault();
            } else if (
              e.key === "ArrowDown" &&
              noMods &&
              historyIdx.current != null &&
              el.selectionStart === el.value.length
            ) {
              if (recall(1)) e.preventDefault();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            {allowAttachments && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    void addFiles(files);
                  }}
                />
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
                  aria-label="Attach files"
                  title="Attach images or files (or paste / drop them)"
                >
                  <Paperclip className="size-4" />
                </button>
              </>
            )}
            {controls}
            {busy ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2
                  className="size-3 shrink-0 animate-spin text-primary"
                  aria-hidden
                />
                <span className="chat-shimmer min-w-0 truncate">
                  {busyHint ?? "Working…"}
                </span>
                <span className="hidden shrink-0 text-muted-foreground/50 lg:inline">
                  · Enter to queue{onStop ? " · Esc to stop" : ""}
                </span>
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {busy && onStop && hasContent && (
              <button
                type="button"
                onClick={stop}
                className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
                aria-label="Stop"
                title="Stop (Esc)"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            )}
            {showStop ? (
              <button
                type="button"
                onClick={stop}
                className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition hover:opacity-80"
                aria-label="Stop"
                title="Stop (Esc)"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <div className="flex shrink-0 items-center gap-1">
                <DropdownMenu
                  onOpenChange={(open) => {
                    if (open) setNow(Date.now());
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        // Keep the textarea focused/selection intact.
                        if (e.button === 0) e.currentTarget.focus({ preventScroll: true });
                      }}
                      disabled={disabled || !hasContent || sending}
                      className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-0"
                      aria-label="More send options"
                      title="Send options: interrupt, schedule"
                    >
                      <AlarmClock className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="end" className="w-64">
                    <DropdownMenuItem onSelect={() => void submit()}>
                      {busy ? <Clock /> : <Send />}
                      {busy ? "Queue after this turn" : "Send now"}
                      <DropdownMenuShortcut>Enter</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    {busy && onStop && (
                      <DropdownMenuItem onSelect={interruptCurrent}>
                        <Zap />
                        Interrupt &amp; send
                        <DropdownMenuShortcut>{mod}+Enter</DropdownMenuShortcut>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                      Schedule send
                    </DropdownMenuLabel>
                    {schedulePresets(now).map((p) => (
                      <DropdownMenuItem key={p.label} onSelect={() => scheduleCurrent(p.dueAt)}>
                        <AlarmClock />
                        {p.label}
                        <DropdownMenuShortcut>
                          {new Date(p.dueAt).toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </DropdownMenuShortcut>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem
                      onSelect={() => {
                        setCustomTime(toLocalInputValue(Date.now() + 60 * 60_000));
                        setPickingTime(true);
                      }}
                    >
                      <Clock />
                      Pick a time…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => void submit()}
                  disabled={disabled || !hasContent || sending}
                  className="flex size-8 items-center justify-center rounded-full bg-foreground text-background transition enabled:hover:opacity-80 disabled:bg-muted disabled:text-muted-foreground/60"
                  aria-label={busy ? "Queue message" : "Send"}
                  title={busy ? "Queue — sends when the agent is done" : "Send (Enter)"}
                >
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : busy ? (
                    <Clock className="size-4" />
                  ) : (
                    <ArrowUp className="size-4" strokeWidth={2.5} />
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
