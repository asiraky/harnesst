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

const entry = (id: string): ChatEntry => ({
  id,
  role: "assistant",
  text: "hi",
});

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
    expect(merged.find((e) => e.role === "artifact")?.artifact?.version).toBe(
      2,
    );
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

  it("resolves option media from this session and removes its duplicate artifact card", () => {
    const entries: ChatEntry[] = [
      entry("1:t1:user"),
      {
        ...entry("1:t1:assistant"),
        inputRequests: [
          {
            requestId: "req_1",
            prompt: "Choose a direction",
            options: [
              {
                id: "assigned",
                label: "Editorial",
                media: {
                  artifactName: "sketch-assigned.webp",
                  artifactVersionId: "ver_1",
                },
              },
            ],
          },
        ],
      },
    ];

    const merged = mergeArtifactEntries(
      entries,
      [
        row({
          name: "sketch-assigned.webp",
          versionNumber: 2,
          latestVersionId: "ver_2",
        }),
      ],
      ANCHORS,
    );

    expect(merged).toHaveLength(2);
    expect(merged.some((item) => item.role === "artifact")).toBe(false);
    expect(
      merged[1].inputRequests?.[0].options?.[0].media?.artifact,
    ).toMatchObject({
      id: "art_1",
      name: "sketch-assigned.webp",
      version: 2,
      url: "/api/foh/proj_1/artifact/art_1/ver_1",
    });
  });

  it("keeps two re-rolls pinned to the artifact versions each round offered", () => {
    const round = (id: string, artifactVersionId: string): ChatEntry => ({
      ...entry(id),
      inputRequests: [
        {
          requestId: `req_${id}`,
          prompt: "Choose",
          surface: "web",
          options: [
            {
              id: "assigned",
              label: "Assigned",
              media: {
                artifactId: "art_1",
                artifactVersionId,
              },
            },
          ],
        },
      ],
    });

    const merged = mergeArtifactEntries(
      [round("1:t1:assistant", "ver_1"), round("1:t2:assistant", "ver_2")],
      [row({ versionNumber: 2, latestVersionId: "ver_2" })],
      ANCHORS,
    );

    expect(
      merged[0].inputRequests?.[0].options?.[0].media?.artifact?.url,
    ).toBe("/api/foh/proj_1/artifact/art_1/ver_1");
    expect(
      merged[1].inputRequests?.[0].options?.[0].media?.artifact?.url,
    ).toBe("/api/foh/proj_1/artifact/art_1/ver_2");
  });

  it("keeps an unresolved or non-image reference out of the option", () => {
    const asked: ChatEntry = {
      ...entry("1:t1:assistant"),
      inputRequests: [
        {
          requestId: "req_1",
          prompt: "Choose",
          options: [
            {
              id: "assigned",
              label: "Editorial",
              media: { artifactId: "page_1", artifactVersionId: "ver_1" },
            },
          ],
        },
      ],
    };

    const merged = mergeArtifactEntries(
      [asked],
      [row({ id: "page_1", kind: "html" })],
      ANCHORS,
    );

    expect(
      merged[0].inputRequests?.[0].options?.[0].media?.artifact,
    ).toBeNull();
    expect(merged.some((item) => item.role === "artifact")).toBe(true);
  });
});
