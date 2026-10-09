/**
 * What the open artifact panel does when fresh loader data arrives for the artifact it is showing
 * (#292 follow-up). The panel's state is local — loader data must not drive it, or every poll would
 * tear the page down — so the route hands the hook the latest transcript copy and this decides.
 *
 *   - "follow": a newer version was published and the user is not deliberately parked on an older
 *     one, so the panel moves to the newest (re-minting for a page). This is what makes an agent's
 *     refine loop show up without the user clicking the card again.
 *   - "refresh": something the header shows changed (share link revoked or rotated, title, a new
 *     version the user is parked away from) — update the snapshot, keep the version on screen.
 *   - "ignore": nothing the panel shows changed; no state write, so a 2-second poll re-renders
 *     nothing.
 */
import type { ChatArtifact } from "~/chat/types";

export type ArtifactFollow = "follow" | "refresh" | "ignore";

export function artifactFollowDecision(input: {
  /** The panel's snapshot of the artifact (what it was opened with, or last followed to). */
  open: ChatArtifact;
  /** The same artifact in the newest loader data, or undefined when it is not in it. */
  fresh: ChatArtifact | undefined;
  /**
   * The version the USER picked from the version menu, or null when the panel is on "newest".
   * Picking the then-newest version explicitly is not parking on an old one.
   */
  pickedVersionId: string | null;
}): ArtifactFollow {
  const { open, fresh, pickedVersionId } = input;
  if (!fresh || fresh.id !== open.id) return "ignore";
  const newer =
    fresh.version > open.version &&
    fresh.latestVersionId !== null &&
    fresh.latestVersionId !== open.latestVersionId;
  if (newer) {
    const parkedOnOlder =
      pickedVersionId !== null && pickedVersionId !== open.latestVersionId;
    return parkedOnOlder ? "refresh" : "follow";
  }
  // An OLDER copy (a stale revalidation racing a follow) never moves the panel backwards.
  if (fresh.version < open.version) return "ignore";
  const changed =
    fresh.shareUrl !== open.shareUrl ||
    fresh.title !== open.title ||
    fresh.name !== open.name ||
    fresh.byteSize !== open.byteSize ||
    fresh.contentType !== open.contentType ||
    fresh.viewer !== open.viewer ||
    fresh.url !== open.url ||
    fresh.latestVersionId !== open.latestVersionId;
  return changed ? "refresh" : "ignore";
}

/** The newest copy of one artifact in a list (a transcript carries each artifact once, but be safe). */
export function findArtifact(
  artifacts: readonly ChatArtifact[] | undefined,
  id: string,
): ChatArtifact | undefined {
  if (!artifacts) return undefined;
  let found: ChatArtifact | undefined;
  for (const artifact of artifacts) {
    if (artifact.id === id && (!found || artifact.version >= found.version)) {
      found = artifact;
    }
  }
  return found;
}
