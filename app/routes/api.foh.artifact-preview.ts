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
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { artifactPreviewPath } from "~/foh/artifact-media";
import { mintArtifactPreviewToken } from "~/foh/artifact-preview.server";
import { findProjectArtifact } from "~/foh/artifact-store.server";
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
  if (!artifact || artifact.kind !== "html" || !artifact.entryPath) {
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

  const minted = mintArtifactPreviewToken({
    artifactId: artifact.id,
    projectId: artifact.projectId,
    userId: auth.user.id,
    backOfHouse: access.backOfHouse,
  });
  return data({
    ok: true as const,
    url: artifactPreviewPath(minted.token, artifact.id, artifact.entryPath),
    expiresAt: minted.expiresAt,
  });
}
