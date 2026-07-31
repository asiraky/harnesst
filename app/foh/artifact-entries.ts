/**
 * Placing published artifacts (issue #290) in the transcript. Pure, client+server safe, and
 * deliberately OUTSIDE `projectEventsToEntries`: an artifact is not an eve event, so nothing about
 * event projection changes — the artifact rows are merged into the projected entries afterwards.
 *
 * Position comes from the cache-space `stream_index` the session had reached when the agent FIRST
 * published the name (see `playground_events.stream_index`). That index identifies the TURN that
 * was in flight, and the card is then placed after that turn's last entry, so an image published in
 * the middle of a long conversation stays where it was made instead of piling up at the bottom. A
 * turn id alone would not do: turn ids repeat across eve sessions, which a cross-redeploy reseed
 * concatenates into one cached stream (#261).
 *
 * Republishing (#292) does not move it. The entry id is `artifact:<artifact id>` and the row's
 * `stream_index` is frozen at first publish, so a new version re-renders THE SAME card in place —
 * which is the whole reason the card was built as a session-attached row rather than a transcript
 * event. Moving it to the newest version's position would slide it down past every turn since,
 * away from the conversation the user is having about it.
 */
import type { ChatArtifact, ChatEntry } from "~/chat/types";
import { artifactUrl } from "~/foh/artifact-media";

/**
 * The artifact-row fields the transcript needs — a subset of the `artifacts` table. The content
 * fields are the LATEST version's, denormalized onto the row, so the card reflects the newest
 * publish with no join on a read that runs on every transcript load.
 */
export interface ArtifactRow {
  id: string;
  projectId: string;
  name: string;
  title: string | null;
  kind: string;
  contentType: string;
  byteSize: number;
  streamIndex: number;
  /** Latest version's ordinal (#292) — 1 until the name is republished. */
  versionNumber: number;
  /** Latest version id, which the image URL is scoped to. */
  latestVersionId: string | null;
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
    url: html ? null : artifactUrl(row.projectId, row.id, row.latestVersionId),
    version: row.versionNumber,
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
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byName = new Map(rows.map((row) => [row.name, row]));
  const referenced = new Set<string>();
  const resolvedEntries = entries.map((entry) => {
    if (!entry.inputRequests) return entry;
    return {
      ...entry,
      inputRequests: entry.inputRequests.map((request) => ({
        ...request,
        options: request.options?.map((option) => {
          const media = option.media;
          if (!media) return option;
          const row =
            (typeof media.artifactId === "string"
              ? byId.get(media.artifactId)
              : undefined) ??
            (typeof media.artifactName === "string"
              ? byName.get(media.artifactName)
              : undefined);
          if (!row || row.kind !== "image") {
            return { ...option, media: { ...media, artifact: null } };
          }
          const artifact = {
            ...artifactEntry(row).artifact!,
            url: artifactUrl(
              row.projectId,
              row.id,
              typeof media.artifactVersionId === "string"
                ? media.artifactVersionId
                : row.latestVersionId,
            ),
          };
          referenced.add(row.id);
          return { ...option, media: { ...media, artifact } };
        }),
      })),
    };
  });
  const ordered = rows
    .filter((row) => !referenced.has(row.id))
    .sort((a, b) => a.streamIndex - b.streamIndex || (a.id < b.id ? -1 : 1));
  if (ordered.length === 0) return resolvedEntries;
  const after = new Map<number, ChatEntry[]>();
  const trailing: ChatEntry[] = [];
  for (const row of ordered) {
    const turnKey = anchorFor(anchors, row.streamIndex);
    const index = turnKey ? lastEntryOfTurn(resolvedEntries, turnKey) : -1;
    if (index < 0) {
      trailing.push(artifactEntry(row));
      continue;
    }
    const bucket = after.get(index);
    if (bucket) bucket.push(artifactEntry(row));
    else after.set(index, [artifactEntry(row)]);
  }
  const merged: ChatEntry[] = [];
  resolvedEntries.forEach((entry, index) => {
    merged.push(entry);
    const extra = after.get(index);
    if (extra) merged.push(...extra);
  });
  merged.push(...trailing);
  return merged;
}
