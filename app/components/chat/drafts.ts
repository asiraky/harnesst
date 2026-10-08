/**
 * Per-conversation composer drafts, so typing into one session, hopping to another and coming back
 * never loses the text.
 *
 * - Text persists to localStorage (survives reloads and tab closes), namespaced per surface +
 *   conversation id, with a bounded LRU index so abandoned drafts don't accumulate forever.
 * - Attachments (File objects) can't go to localStorage; they live in a module-level map for the
 *   life of the tab, which covers in-app navigation between sessions.
 * - Queued messages (typed while the agent was busy) live alongside the attachments, per key.
 */

const PREFIX = "harnesst:draft:";
const INDEX_KEY = "harnesst:draft-index";
/** Most-recently-touched drafts kept; older ones are pruned. */
export const MAX_STORED_DRAFTS = 50;

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Safari private mode / disabled storage throws on access.
    return null;
  }
}

function readIndex(storage: DraftStorage): string[] {
  try {
    const raw = storage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

/** Move `key` to the front of the LRU index (or drop it) and prune past the cap. */
export function touchIndex(
  index: readonly string[],
  key: string,
  present: boolean,
  cap = MAX_STORED_DRAFTS,
): { index: string[]; evicted: string[] } {
  const rest = index.filter((k) => k !== key);
  const next = present ? [key, ...rest] : rest;
  return { index: next.slice(0, cap), evicted: next.slice(cap) };
}

export function loadDraftText(
  key: string,
  storage: DraftStorage | null = defaultStorage(),
): string {
  if (!storage || !key) return "";
  try {
    return storage.getItem(PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function saveDraftText(
  key: string,
  text: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!storage || !key) return;
  try {
    const present = text.trim().length > 0;
    if (present) storage.setItem(PREFIX + key, text);
    else storage.removeItem(PREFIX + key);
    const { index, evicted } = touchIndex(readIndex(storage), key, present);
    for (const old of evicted) storage.removeItem(PREFIX + old);
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Quota exceeded — a lost draft beats a crashed composer.
  }
}

export interface DraftAttachment {
  id: string;
  file: File;
  name: string;
  mediaType: string;
  size: number;
  /** Object URL for image thumbnails; revoked when the attachment is dropped. */
  previewUrl: string | null;
}

const attachmentDrafts = new Map<string, DraftAttachment[]>();
const queuedDrafts = new Map<string, QueuedMessage[]>();

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: DraftAttachment[];
}

export function loadDraftAttachments(key: string): DraftAttachment[] {
  return attachmentDrafts.get(key) ?? [];
}

export function saveDraftAttachments(
  key: string,
  attachments: DraftAttachment[],
): void {
  if (!key) return;
  if (attachments.length === 0) attachmentDrafts.delete(key);
  else attachmentDrafts.set(key, attachments);
}

export function loadQueue(key: string): QueuedMessage[] {
  return queuedDrafts.get(key) ?? [];
}

export function saveQueue(key: string, queue: QueuedMessage[]): void {
  if (!key) return;
  if (queue.length === 0) queuedDrafts.delete(key);
  else queuedDrafts.set(key, queue);
}

/** Sent-message history for Up-arrow recall — per surface, newest last, capped. */
const HISTORY_PREFIX = "harnesst:composer-history:";
export const MAX_HISTORY = 50;

export function pushHistory(
  history: readonly string[],
  message: string,
  cap = MAX_HISTORY,
): string[] {
  const trimmed = message.trim();
  if (!trimmed) return [...history];
  const next = history.filter((m) => m !== trimmed);
  next.push(trimmed);
  return next.slice(-cap);
}

export function loadHistory(
  scope: string,
  storage: DraftStorage | null = defaultStorage(),
): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(HISTORY_PREFIX + scope) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((m): m is string => typeof m === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveHistory(
  scope: string,
  history: readonly string[],
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(HISTORY_PREFIX + scope, JSON.stringify(history));
  } catch {
    // ignore quota
  }
}

/**
 * Re-home a conversation's unsent state under a new key — used when a brand-new conversation gets
 * its real id after the first send, so text typed (or messages queued) during that first turn
 * follow the conversation instead of being stranded under the placeholder key. Anything already
 * under `to` wins for text; attachments and queued messages are appended.
 */
export function moveDraft(
  from: string,
  to: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!from || !to || from === to) return;
  const text = loadDraftText(from, storage);
  if (text.trim() && !loadDraftText(to, storage).trim()) saveDraftText(to, text, storage);
  saveDraftText(from, "", storage);
  const atts = loadDraftAttachments(from);
  if (atts.length) saveDraftAttachments(to, [...loadDraftAttachments(to), ...atts]);
  saveDraftAttachments(from, []);
  const queue = loadQueue(from);
  if (queue.length) saveQueue(to, [...loadQueue(to), ...queue]);
  saveQueue(from, []);
}
