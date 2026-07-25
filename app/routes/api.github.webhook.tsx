/**
 * GitHub App webhook receiver — keeps Eden's Release history in sync when a developer's PR is
 * merged on github.com. This is the ONLY PR-shaped path that survives issue #225's cutover,
 * and only because it serves developers pushing to the repo directly, never the Eden UI (Eden's
 * own publishes commit straight to the default branch and cut their releases pipeline-side).
 *
 * On a PR merged into the default branch, find-or-create the Release at the merge commit. It
 * does NOT auto-deploy: deploying a version is a separate, explicit act (the human picks the
 * environment — the multi-version primitive, §7.7). The release create is idempotent via
 * `ensureReleaseForCommit`, keyed on (agent, commit).
 * Resource route (action only); signature-verified.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { listAgents, syncProjectAgents } from "~/db/queries.server";
import {
  ensureReleasesForCommit,
  findProjectByRepo,
} from "~/deploy/controller.server";
import { refreshTeammatesForRosterChange } from "~/deploy/teammate-refresh.server";
import {
  ASSISTANT_CONFIG_ROOT,
  detectAgentRoots,
  hasTeamLayout,
} from "~/eve/parse";
import { enqueue } from "~/jobs/queue.server";
import { invalidateRepoSource, warmAgentSource } from "~/github/cached.server";
import { fetchAgentSource, listCommitFiles } from "~/github/repo.server";
import { verifyGitHubSignature } from "~/github/webhook.server";

export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  if (!verifyGitHubSignature(raw, request.headers.get("x-hub-signature-256"))) {
    throw data("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(raw) as {
    action?: string;
    pull_request?: {
      merged?: boolean;
      merge_commit_sha?: string;
      title?: string;
      number?: number;
      base?: { ref?: string };
    };
    repository?: {
      name?: string;
      owner?: { login?: string };
      default_branch?: string;
    };
  };

  const projectForRepo =
    event === "pull_request" &&
    payload.repository?.owner?.login &&
    payload.repository.name
      ? await findProjectByRepo(
          payload.repository.owner.login,
          payload.repository.name,
        )
      : null;

  // Only act on PRs merged into the default branch — a merge into a feature branch changes
  // nothing Eden serves.
  if (
    event !== "pull_request" ||
    payload.action !== "closed" ||
    !payload.pull_request?.merged ||
    !payload.pull_request.merge_commit_sha ||
    !payload.repository?.name ||
    !payload.repository.owner?.login ||
    payload.pull_request.base?.ref !== payload.repository.default_branch
  ) {
    return data({ ok: true, skipped: true });
  }

  const project = projectForRepo;
  if (!project) return data({ ok: true, skipped: "no project" });

  // Reconcile the roster before cutting releases — the merge may have added or removed a
  // team member (PRD §7.9). Best-effort: a failed read must not drop the release record.
  if (project.repoInstallationId) {
    try {
      const owner = payload.repository.owner.login;
      const repo = payload.repository.name;
      const source = await fetchAgentSource(project.repoInstallationId, {
        owner,
        repo,
        ref: payload.pull_request.merge_commit_sha,
      });
      const before = await listAgents(project.id);
      const detected = detectAgentRoots(source.paths);
      const after = await syncProjectAgents(
        project.id,
        detected,
        undefined,
        undefined,
        {
          allowEmpty:
            project.layout === "team" &&
            hasTeamLayout(source.paths) &&
            detected.length === 0,
        },
      );
      // D7: a merge that added/removed a member must refresh the OTHER members' running
      // instances so their EDEN_TEAMMATES reflects the new roster (image reuse, no rebuild).
      await refreshTeammatesForRosterChange({
        projectId: project.id,
        previousNames: before.map((a) => a.name),
        currentNames: after.map((a) => a.name),
      });
      // The merge moved the default branch to this commit — drop every ref's source entry,
      // then warm the default-branch key with what we just read (next load is instant). The
      // read was pinned to the merge SHA, so restore the branch NAME in the cached `ref` —
      // consumers of the default-branch key must never see a SHA there.
      invalidateRepoSource(project.repoInstallationId, { owner, repo });
      warmAgentSource(
        project.repoInstallationId,
        { owner, repo },
        {
          ...source,
          ref: payload.repository.default_branch ?? source.ref,
        },
      );

      // A merge that touched the assistant's published config restarts its instance so the
      // entrypoint re-fetches the bundle + rebuilds. Trigger discipline:
      // ONLY from this merge path, never from loader self-heal. Queued so the webhook stays fast.
      const changed = await listCommitFiles(
        project.repoInstallationId,
        { owner, repo },
        payload.pull_request.merge_commit_sha,
      );
      if (changed.some((p) => p.startsWith(`${ASSISTANT_CONFIG_ROOT}/`))) {
        await enqueue("assistant_restart", { projectId: project.id });
      }
    } catch {
      // roster stays as-is; releases below still cut for the known members
    }
  }

  // One Release per roster member at this merge commit (team merges are atomic, §7.9).
  const results = await ensureReleasesForCommit({
    projectId: project.id,
    gitSha: payload.pull_request.merge_commit_sha,
    changelog: payload.pull_request.title
      ? `#${payload.pull_request.number} ${payload.pull_request.title}`
      : null,
  });

  return data({
    ok: true,
    releases: results.map((r) => r.release.version),
    created: results.some((r) => r.created),
  });
}
