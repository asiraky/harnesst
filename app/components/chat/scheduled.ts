/**
 * Scheduled sends: "send this at 9am" / "in 30 minutes".
 *
 * Browser-side only. The schedule persists to localStorage per conversation (text + due time;
 * attachment Files stay in memory for the life of the tab). A due message fires when its
 * conversation is open: at the due time if you're on it, otherwise as soon as you come back.
 * The composer moves a due message into its send queue, so it waits for a running turn to
 * finish like any other queued message.
 */
import type { DraftAttachment, DraftStorage } from "./drafts";

const PREFIX = "harnesst:scheduled:";
const MINUTE = 60_000;

export interface ScheduledMessage {
  id: string;
  text: string;
  dueAt: number;
  /** Names only, for display after a reload drops the Files. */
  attachmentNames: string[];
}

const scheduledFiles = new Map<string, DraftAttachment[]>();

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadScheduled(
  key: string,
  storage: DraftStorage | null = defaultStorage(),
): ScheduledMessage[] {
  if (!storage || !key) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(PREFIX + key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ScheduledMessage =>
        !!m &&
        typeof m.id === "string" &&
        typeof m.text === "string" &&
        typeof m.dueAt === "number" &&
        Array.isArray(m.attachmentNames),
    );
  } catch {
    return [];
  }
}

export function saveScheduled(
  key: string,
  list: readonly ScheduledMessage[],
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!storage || !key) return;
  try {
    if (list.length === 0) storage.removeItem(PREFIX + key);
    else storage.setItem(PREFIX + key, JSON.stringify(list));
  } catch {
    // quota
  }
}

/** Re-home scheduled messages when a conversation's key changes (see `moveDraft`). */
export function moveScheduled(
  from: string,
  to: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!from || !to || from === to) return;
  const moving = loadScheduled(from, storage);
  if (moving.length === 0) return;
  let merged = loadScheduled(to, storage);
  for (const m of moving) merged = insertScheduled(merged, m);
  saveScheduled(to, merged, storage);
  saveScheduled(from, [], storage);
}

export function scheduledAttachments(id: string): DraftAttachment[] {
  return scheduledFiles.get(id) ?? [];
}
export function setScheduledAttachments(id: string, atts: DraftAttachment[]) {
  if (atts.length === 0) scheduledFiles.delete(id);
  else scheduledFiles.set(id, atts);
}

/** Insert keeping due-time order. */
export function insertScheduled(
  list: readonly ScheduledMessage[],
  item: ScheduledMessage,
): ScheduledMessage[] {
  return [...list.filter((m) => m.id !== item.id), item].sort(
    (a, b) => a.dueAt - b.dueAt,
  );
}

/** Split into messages due now (oldest first) and those still waiting. */
export function partitionDue(
  list: readonly ScheduledMessage[],
  now: number,
): { due: ScheduledMessage[]; pending: ScheduledMessage[] } {
  const due: ScheduledMessage[] = [];
  const pending: ScheduledMessage[] = [];
  for (const m of list) (m.dueAt <= now ? due : pending).push(m);
  due.sort((a, b) => a.dueAt - b.dueAt);
  return { due, pending };
}

export interface SchedulePreset {
  label: string;
  dueAt: number;
}

/** Quick picks for the schedule menu, relative to `now` in the viewer's local time. */
export function schedulePresets(now: number): SchedulePreset[] {
  const at = (h: number, dayOffset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, 0, 0, 0);
    return d.getTime();
  };
  const presets: SchedulePreset[] = [
    { label: "In 5 minutes", dueAt: now + 5 * MINUTE },
    { label: "In 30 minutes", dueAt: now + 30 * MINUTE },
    { label: "In 1 hour", dueAt: now + 60 * MINUTE },
    { label: "In 3 hours", dueAt: now + 180 * MINUTE },
  ];
  const tonight = at(18, 0);
  if (tonight - now > 30 * MINUTE) presets.push({ label: "This evening (6 pm)", dueAt: tonight });
  presets.push({ label: "Tomorrow morning (9 am)", dueAt: at(9, 1) });
  return presets;
}

/** "in 5m", "in 2h 10m", "overdue". */
export function formatCountdown(dueAt: number, now: number): string {
  const ms = dueAt - now;
  if (ms <= 0) return "due now";
  const mins = Math.ceil(ms / MINUTE);
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

/** `<input type="datetime-local">` value for a timestamp in local time. */
export function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
