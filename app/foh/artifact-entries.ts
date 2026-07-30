/**
 * Placing published artifacts (issue #290) in the transcript. Pure, client+server safe, and
 * deliberately OUTSIDE `projectEventsToEntries`: an artifact is not an eve event, so nothing about
 * event projection changes — the artifact rows are merged into the projected entries afterwards.
 *
 * Position comes from the cache-space `stream_index` the session had reached when the agent
 * published (see `playground_events.stream_index`). That index identifies the TURN that was in
 * flight, and the card is then placed after that turn's last entry, so an image published in the
 * middle of a long conversation stays where it was made instead of piling up at the bottom. A
 * turn id alone would not do: turn ids repeat across eve sessions, which a cross-redeploy reseed
 * concatenates into one cached stream (#261).
 */
import type { ChatArtifact, ChatEntry } from "~/chat/types";
import { artifactUrl } from "~/foh/artifact-media";

/** The artifact-row fields the transcript needs — a subset of the `artifacts` table. */
export interface ArtifactRow {
  id: string;
  projectId: string;
  name: string;
  title: string | null;
  kind: string;
  contentType: string;
  byteSize: number;
  streamIndex: number;
}

/** Which turn owned the stream at a given cache-space index. */
export interface TurnAnchor {
  streamIndex: number;
  /** The projection's turn key — `<epoch>:<turnId>` — which prefixes that turn's entry ids. */
  turnKey: string;
}

/**
 * Turn keys by stream position, derived from the same cached rows the projection reads. Mirrors
 * exactly two of `projectEventsToEntries`' rules — the epoch bumps on `session.started`, and a
 * turn is identified by `data.turnId` — because the entry ids it emits are built from both.
 */
export function turnAnchorsFromEvents(
  events: Array<{
    streamIndex: number;
    type: string;
    data: Record<string, unknown>;
  }>,
): TurnAnchor[] {
  const anchors: TurnAnchor[] = [];
  let epoch = 0;
  for (const event of events) {
    if (event.type === "session.started") epoch += 1;
    const turnId =
      typeof event.data.turnId === "string" ? event.data.turnId : null;
    if (!turnId) continue;
    anchors.push({ streamIndex: event.streamIndex, turnKey: `${epoch}:${turnId}` });
  }
  return anchors;
}

/**
 * The transcript entry one artifact row renders as. A page bundle (#291) carries NO url: its bytes
 * are only reachable through a preview token the app mints per panel-open, and the image route
 * refuses bundle rows, so there is no path that would work here even if one were baked in.
 */
export function artifactEntry(row: ArtifactRow): ChatEntry {
  const html = row.kind === "html";
  const artifact: ChatArtifact = {
    id: row.id,
    name: row.name,
    title: row.title,
    kind: html ? "html" : "image",
    contentType: row.contentType,
    byteSize: row.byteSize,
    url: html ? null : artifactUrl(row.projectId, row.id),
  };
  return { id: `artifact:${row.id}`, role: "artifact", text: "", artifact };
}

/**
 * The newest entry that is part of the CONVERSATION. An artifact card trails the turn that
 * produced it, so "the last entry" — which decides who may answer a pending question, whether a
 * running indicator shows, and what the loader-side needs-you repair reads — has to skip cards.
 */
export function newestTurnEntry<T extends { role: string }>(
  entries: T[],
): T | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role !== "artifact") return entries[i];
  }
  return null;
}

/** Index of the last entry belonging to `turnKey`, or -1 — the insertion point for its cards. */
function lastEntryOfTurn(entries: ChatEntry[], turnKey: string): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].id.startsWith(`${turnKey}:`)) return i;
  }
  return -1;
}

/** The turn that owned the stream at `streamIndex` — the last anchor at or before it. */
function anchorFor(anchors: TurnAnchor[], streamIndex: number): string | null {
  let key: string | null = null;
  for (const anchor of anchors) {
    if (anchor.streamIndex > streamIndex) break;
    key = anchor.turnKey;
  }
  return key;
}

/**
 * Fold artifact rows into projected entries. An artifact whose turn is not in the transcript —
 * published before the first turn, or against a turn the cache does not cover — goes at the end
 * rather than being dropped: the user must see what the agent made either way.
 */
export function mergeArtifactEntries(
  entries: ChatEntry[],
  rows: ArtifactRow[],
  anchors: TurnAnchor[],
): ChatEntry[] {
  if (rows.length === 0) return entries;
  const ordered = [...rows].sort(
    (a, b) => a.streamIndex - b.streamIndex || (a.id < b.id ? -1 : 1),
  );
  const after = new Map<number, ChatEntry[]>();
  const trailing: ChatEntry[] = [];
  for (const row of ordered) {
    const turnKey = anchorFor(anchors, row.streamIndex);
    const index = turnKey ? lastEntryOfTurn(entries, turnKey) : -1;
    if (index < 0) {
      trailing.push(artifactEntry(row));
      continue;
    }
    const bucket = after.get(index);
    if (bucket) bucket.push(artifactEntry(row));
    else after.set(index, [artifactEntry(row)]);
  }
  const merged: ChatEntry[] = [];
  entries.forEach((entry, index) => {
    merged.push(entry);
    const extra = after.get(index);
    if (extra) merged.push(...extra);
  });
  merged.push(...trailing);
  return merged;
}
