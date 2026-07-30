/**
 * How a republished artifact (#292) lands in a transcript. The card is a session-attached ROW folded
 * into the projected entries, not an event, and that is what makes an update in place possible at
 * all — so the two facts worth pinning are that a new version re-renders the SAME entry (no second
 * card, no transcript noise) and that the entry it re-renders points at the newest bytes.
 */
import { describe, expect, it } from "vitest";

import {
  artifactEntry,
  mergeArtifactEntries,
  type ArtifactRow,
} from "~/foh/artifact-entries";
import type { ChatEntry } from "~/chat/types";

const row = (over: Partial<ArtifactRow> = {}): ArtifactRow => ({
  id: "art_1",
  projectId: "proj_1",
  name: "chart.png",
  title: "Chart",
  kind: "image",
  contentType: "image/png",
  byteSize: 10,
  streamIndex: 4,
  versionNumber: 1,
  latestVersionId: "ver_1",
  ...over,
});

const entry = (id: string): ChatEntry => ({ id, role: "assistant", text: "hi" });

const ANCHORS = [
  { streamIndex: 2, turnKey: "1:t1" },
  { streamIndex: 9, turnKey: "1:t2" },
];
const ENTRIES = [
  entry("1:t1:user"),
  entry("1:t1:assistant"),
  entry("1:t2:user"),
  entry("1:t2:assistant"),
];

describe("artifactEntry versions", () => {
  it("keeps its identity across versions and serves the newest bytes", () => {
    const first = artifactEntry(row());
    const second = artifactEntry(
      row({
        versionNumber: 2,
        latestVersionId: "ver_2",
        byteSize: 40,
        title: "Redrawn",
      }),
    );

    // Same entry id, because it is derived from the ARTIFACT: React reconciles the two renders as
    // one card, which is the whole point of publishing a name rather than a file.
    expect(second.id).toBe(first.id);
    expect(second.artifact).toMatchObject({
      id: "art_1",
      version: 2,
      byteSize: 40,
      title: "Redrawn",
      // Version-scoped, so the newest publish cannot be hidden behind a cached response of the
      // previous one — the URL itself changes.
      url: "/api/foh/proj_1/artifact/art_1/ver_2",
    });
    expect(first.artifact?.url).toBe("/api/foh/proj_1/artifact/art_1/ver_1");
  });

  it("gives a page no url however many versions it has", () => {
    // A bundle is reachable only through a preview capability minted per open, so a link baked into
    // transcript data would be a link to bytes no route will serve.
    const page = artifactEntry(
      row({ kind: "html", versionNumber: 3, latestVersionId: "ver_3" }),
    );
    expect(page.artifact?.url).toBeNull();
  });
});

describe("mergeArtifactEntries with versions", () => {
  it("re-renders one card at the position the first publish gave it", () => {
    // The row's stream index is frozen at first publish even though v2 landed two turns later:
    // merged by the newest version's position instead, the card would slide away from the exchange
    // the user is discussing it in, and read as a new thing the agent just made.
    const merged = mergeArtifactEntries(
      ENTRIES,
      [row({ versionNumber: 2, latestVersionId: "ver_2" })],
      ANCHORS,
    );

    expect(merged.map((e) => e.id)).toEqual([
      "1:t1:user",
      "1:t1:assistant",
      "artifact:art_1",
      "1:t2:user",
      "1:t2:assistant",
    ]);
    expect(merged.filter((e) => e.role === "artifact")).toHaveLength(1);
    expect(
      merged.find((e) => e.role === "artifact")?.artifact?.version,
    ).toBe(2);
  });

  it("still places a second name separately", () => {
    // Only the same NAME collapses. Two files published in the same turn are two cards, in a stable
    // order, or a transcript would reorder itself between polls.
    const merged = mergeArtifactEntries(
      ENTRIES,
      [
        row({ id: "art_2", name: "other.png", streamIndex: 10 }),
        row({ streamIndex: 4 }),
      ],
      ANCHORS,
    );

    expect(merged.map((e) => e.id)).toEqual([
      "1:t1:user",
      "1:t1:assistant",
      "artifact:art_1",
      "1:t2:user",
      "1:t2:assistant",
      "artifact:art_2",
    ]);
  });
});
