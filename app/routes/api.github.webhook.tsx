/**
 * GitHub App webhook receiver — keeps harnesst's Release history in sync when a change is merged
 * on github.com instead of in-app (PRD §7.3: "merge in harnesst or on GitHub").
 *
 * On a PR merged into the default branch, find-or-create the Release at the merge commit. It
 * does NOT auto-deploy: deploying a version is a separate, explicit act on the Deployments tab
 * (the human picks environment + traffic weight — the multi-version primitive, §7.7). The
 * release create is idempotent with the in-app Merge button via `ensureReleaseForCommit`, so a
 * change merged in harnesst and echoed back by this webhook yields exactly one Release.
 * Resource route (action only); signature-verified.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { listAgents, syncProjectAgents } from "~/db/queries.server";
import { getRuntime } from "~/seams/index.server";
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
import {
  invalidateRepoChanges,
  invalidateRepoSource,
  warmAgentSource,
} from "~/github/cached.server";
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
      head?: { ref?: string };
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

  // Cache keys use harnesst's opaque grant id. The webhook's raw installation id is deliberately
  // ignored at this browser/server boundary; resolve the repository to its project grant instead.
  if (
    event === "pull_request" &&
    projectForRepo?.repoInstallationId &&
    payload.repository?.owner?.login &&
    payload.repository.name
  ) {
    invalidateRepoChanges(projectForRepo.repoInstallationId, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
    });
  }

  // A rename PR closed WITHOUT merging must drop the member's pending mark. Otherwise the row
  // stays "rename in flight" forever — planPendingRenames only clears once the new `agents/<new>/`
  // directory is detected, which never happens for an unmerged PR — and settings.tsx blocks any
  // further rename ("merge or close it first") with no PR left to merge or close. Match the branch
  // back to its row by reconstructing the branch name, so ambiguous old-vs-new name parsing (names
  // may contain hyphens) is never needed.
  if (
    event === "pull_request" &&
    payload.action === "closed" &&
    !payload.pull_request?.merged &&
    payload.pull_request?.head?.ref?.startsWith("harnesst/rename-member-") &&
    payload.repository?.owner?.login &&
    payload.repository.name
  ) {
    const headRef = payload.pull_request.head.ref;
    const project = projectForRepo;
    if (project) {
      const agents = await listAgents(project.id);
      const match = agents.find(
        (a) =>
          a.pendingName &&
          `harnesst/rename-member-${a.name}-${a.pendingName}` === headRef,
      );
      if (match) await getRuntime().data.agents.setPendingName(match.id, null);
    }
  }

  // Only act on PRs merged into the default branch — a merge into a feature branch is not
  // a ship signal (PRD §7.3: merge-to-mainline = deploy).
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
      // instances so their HARNESST_TEAMMATES reflects the new roster (image reuse, no rebuild).
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
