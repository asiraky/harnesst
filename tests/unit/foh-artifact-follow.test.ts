import { describe, expect, it } from "vitest";

import type { ChatArtifact } from "~/chat/types";
import { artifactFollowDecision, findArtifact } from "~/foh/artifact-follow";

function artifact(overrides: Partial<ChatArtifact> = {}): ChatArtifact {
  return {
    id: "art_1",
    name: "report.html",
    title: "Report",
    kind: "html",
    contentType: "text/html",
    byteSize: 100,
    url: null,
    version: 1,
    latestVersionId: "ver_1",
    shareUrl: "/a/tok",
    viewer: "html",
    ...overrides,
  };
}

const v2 = artifact({ version: 2, latestVersionId: "ver_2", byteSize: 120 });

describe("artifactFollowDecision", () => {
  it("follows a newer version when the panel is on newest", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: v2,
        pickedVersionId: null,
      }),
    ).toBe("follow");
  });

  it("follows when the user explicitly picked the then-newest version", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: v2,
        pickedVersionId: "ver_1",
      }),
    ).toBe("follow");
  });

  it("stays on an older version the user is parked on, but refreshes the snapshot", () => {
    expect(
      artifactFollowDecision({
        open: v2,
        fresh: artifact({ version: 3, latestVersionId: "ver_3" }),
        pickedVersionId: "ver_1",
      }),
    ).toBe("refresh");
  });

  it("refreshes when only header data changed", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: artifact({ shareUrl: null }),
        pickedVersionId: null,
      }),
    ).toBe("refresh");
  });

  it("ignores identical data, so polls cause no state writes", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: artifact(),
        pickedVersionId: null,
      }),
    ).toBe("ignore");
  });

  it("never moves backwards on a stale copy", () => {
    expect(
      artifactFollowDecision({
        open: v2,
        fresh: artifact(),
        pickedVersionId: null,
      }),
    ).toBe("ignore");
  });

  it("ignores a missing or different artifact", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: undefined,
        pickedVersionId: null,
      }),
    ).toBe("ignore");
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: artifact({ id: "art_2", version: 5, latestVersionId: "x" }),
        pickedVersionId: null,
      }),
    ).toBe("ignore");
  });

  it("does not follow a higher version number without a new version id", () => {
    expect(
      artifactFollowDecision({
        open: artifact(),
        fresh: artifact({ version: 2, latestVersionId: null }),
        pickedVersionId: null,
      }),
    ).toBe("refresh");
  });
});

describe("findArtifact", () => {
  it("returns the newest copy of the id", () => {
    expect(
      findArtifact(
        [artifact(), v2, artifact({ id: "art_2", version: 9 })],
        "art_1",
      ),
    ).toBe(v2);
  });

  it("returns undefined without a list or a match", () => {
    expect(findArtifact(undefined, "art_1")).toBeUndefined();
    expect(findArtifact([artifact()], "nope")).toBeUndefined();
  });
});
