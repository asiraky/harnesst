/**
 * Mints a preview capability for one page-bundle artifact (#291). Resource route, action only.
 *
 * A POST rather than a loader for the reason `api.foh.read.ts` states: `prefetch="intent"` runs
 * loaders on hover, and minting a bearer capability is a side effect that must happen when the user
 * actually opens the card. This is the ONE place the full cookie-authenticated authorization runs —
 * org/team scope (`requireFohProject`) and then the per-conversation visibility check — and the
 * token it returns is a 10-minute, artifact-and-viewer-bound restatement of that decision.
 *
 * Everything unauthorized is a 404, matching the image route: an out-of-scope repo, a nonexistent
 * artifact id, someone else's conversation and an image (which has no preview) are indistinguishable.
 *
 * It is also where the panel LEARNS about versions (#292): the response carries the list, because
 * the panel's state is deliberately local — the session page revalidates every two seconds and a
 * preview driven by loader data would be torn down on each poll.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import {
  artifactPreviewUrl,
  mintArtifactPreviewToken,
} from "~/foh/artifact-preview.server";
import {
  findProjectArtifact,
  listArtifactVersions,
} from "~/foh/artifact-store.server";
import { requireFohProject } from "~/foh/guard.server";
import { getFohSessionForViewer } from "~/playground/sessions.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw data({ ok: false, error: "Not found" }, { status: 404 });
  const access = await requireFohProject(auth, args.params.projectId);

  const form = await args.request.formData();
  const artifactId = String(form.get("artifactId") ?? "");
  const artifact = artifactId
    ? await findProjectArtifact({ id: artifactId, projectId: access.project.id })
    : null;
  if (!artifact || artifact.kind !== "html") {
    throw data({ ok: false, error: "Not found" }, { status: 404 });
  }

  // Visibility is the CONVERSATION's, not the repo's: FOH sessions are per-creator confidential,
  // so repo scope alone would let one member preview another's page.
  const session = await getFohSessionForViewer({
    id: artifact.sessionId,
    projectId: access.project.id,
    viewerId: auth.user.id,
    includeAll: access.backOfHouse,
  });
  if (!session) throw data({ ok: false, error: "Not found" }, { status: 404 });

  // The requested version, defaulting to the newest. Selected from the artifact's OWN versions
  // rather than looked up by id alone, so the field cannot become a cross-artifact selector on a
  // request that only authorized this artifact.
  const versions = await listArtifactVersions(artifact.id);
  const requested = String(form.get("versionId") ?? "");
  const selected = requested
    ? versions.find((version) => version.id === requested)
    : versions[0];
  // Every version of an html artifact has an entry, because `recordArtifact` refuses to append a
  // version of the other kind (the check `publishArtifact` makes before the copy cannot hold that
  // on its own). The guard stays as this door's own: a card no version answers is a 404, never a
  // token over something the preview cannot serve.
  if (!selected || !selected.entryPath) {
    throw data({ ok: false, error: "Not found" }, { status: 404 });
  }

  const minted = mintArtifactPreviewToken({
    artifactId: artifact.id,
    versionId: selected.id,
    projectId: artifact.projectId,
    userId: auth.user.id,
    backOfHouse: access.backOfHouse,
  });
  return data({
    ok: true as const,
    // Absolute on the sandbox origin when PREVIEW_ORIGIN is set, root-relative otherwise (#296).
    // The panel stores this verbatim as the iframe's src, so this is where the origin split
    // actually happens; the token in the path authenticates identically either way.
    url: artifactPreviewUrl(minted.token, artifact.id, selected.entryPath),
    expiresAt: minted.expiresAt,
    // Echoed so the panel's re-mint pins the version the user is LOOKING at: re-resolving "newest"
    // every ten minutes would swap a user parked on v1 to v3 with no interaction at all.
    versionId: selected.id,
    versions: versions.map((version) => ({
      id: version.id,
      version: version.versionNumber,
      byteSize: version.byteSize,
      createdAt: version.createdAt.toISOString(),
    })),
  });
}
