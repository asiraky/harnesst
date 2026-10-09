/**
 * Who may read an artifact through the COOKIE-authenticated doors — the raw route
 * (`api.foh.artifact.ts`) and the source route (`api.foh.artifact-source.ts`). One function so the
 * two cannot drift: a source endpoint that checked less than the raw one would be a side door to
 * the same bytes.
 *
 * Everything unauthorized is a 404, never a 403: `requireFohProject` already makes an out-of-scope
 * repo indistinguishable from a nonexistent one, and the same must hold for an artifact id — a
 * signed-out visitor or a member outside the repo's team must not be able to learn that an id
 * exists. Visibility is the session's, not the project's: the row is only served when the viewer
 * can see the conversation it was published into.
 */
import { data, type LoaderFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import {
  findArtifactVersion,
  findProjectArtifact,
  latestArtifactVersion,
  type Artifact,
  type ArtifactVersion,
} from "~/foh/artifact-store.server";
import { requireFohProject } from "~/foh/guard.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

export interface ArtifactAccess {
  artifact: Artifact;
  version: ArtifactVersion;
  /** Whether the URL named the version — only then is the response immutable. */
  versionPinned: boolean;
}

const notFound = () => data("Not found", { status: 404 });

export async function requireArtifactAccess(
  args: LoaderFunctionArgs,
): Promise<ArtifactAccess> {
  const auth = await getSessionAuth(args);
  // 404, not the /login redirect the other FOH resource routes use: these URLs are loaded by an
  // `<img>`, `<video>` or `fetch`, so a redirect would resolve to the sign-in HTML and render as a
  // broken element while also confirming the id exists.
  if (!auth.user) throw notFound();
  const access = await requireFohProject(auth, args.params.projectId);

  const artifactId = args.params.artifactId ?? "";
  const artifact = artifactId
    ? await findProjectArtifact({
        id: artifactId,
        projectId: access.project.id,
      })
    : null;
  if (!artifact) throw notFound();

  // A session-less artifact (#370, background publish) sits in no conversation, so there is no
  // per-creator confidentiality to enforce beyond the repo access already checked above — it is
  // agent output, not somebody's private chat. Back of house sees every conversation, archived
  // ones included: it owns the archived shelf, and its Artifacts page previews their artifacts.
  if (artifact.sessionId) {
    const session = await getFohSessionForViewer({
      id: artifact.sessionId,
      projectId: access.project.id,
      viewerId: auth.user.id,
      includeAll: access.backOfHouse,
      includeArchived: access.backOfHouse,
    });
    if (!session) throw notFound();
  }

  // The requested version, or the newest. Looked up CONSTRAINED to the artifact, so a version id
  // belonging to another artifact is not found rather than served — the artifact is what the
  // authorization above was about.
  const requested = args.params.versionId ?? "";
  const version = requested
    ? await findArtifactVersion({
        artifactId: artifact.id,
        versionId: requested,
      })
    : await latestArtifactVersion(artifact.id);
  if (!version) throw notFound();
  return { artifact, version, versionPinned: Boolean(requested) };
}
