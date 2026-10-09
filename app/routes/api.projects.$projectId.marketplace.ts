/**
 * Data behind the in-place "Add from marketplace" dialog on the agent and team pages: the catalog
 * listing plus every install target in this repo and what is already installed at each. The dialog
 * fetches it when it opens, so the pages themselves never wait on the catalog.
 *
 * Targets match the install wizard exactly — roster members and their declared subagents, read
 * from the branch — because each row links into the wizard with `?member=` preselected and the
 * wizard re-resolves that value against the same set.
 */
import { sessionLoader } from "~/auth/session.server";
import type { LoaderFunctionArgs } from "react-router";

import { requireWorkspaceAdmin } from "~/auth/workspace.server";
import { listDrafts } from "~/drafts/drafts.server";
import { getAgentSource } from "~/github/cached.server";
import { catalogProviderEvidence } from "~/marketplace/install.server";
import { overlayLock } from "~/marketplace/lock";
import type { TemplateType } from "~/marketplace/manifest";
import {
  declaredSubagentPaths,
  encodeMemberSelection,
  installedKeysAtTarget,
} from "~/marketplace/targets";
import { resolveSyncedAgentContext } from "~/project/agent-context.server";
import { requireProjectAccess, requireRepo } from "~/project/guard.server";
import { getRuntime } from "~/seams/index.server";

export interface MarketplaceTarget {
  /** The wizard's `?member=` value. */
  value: string;
  member: string;
  /** `/`-joined declared-subagent chain; empty for the member itself. */
  subagentPath: string;
  /** `type/id` keys already installed here. */
  installed: string[];
}

export interface MarketplacePickerData {
  templates: Array<{
    id: string;
    type: TemplateType;
    name: string;
    version: string;
    description: string;
  }>;
  catalogError: string | null;
  /** Agent templates install as a new member, which only a team repo can take. */
  isTeam: boolean;
  targets: MarketplaceTarget[];
}

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }): Promise<MarketplacePickerData> => {
      const access = await requireProjectAccess(
        auth,
        args.params.projectId,
        "write",
      );
      // Same gate as the marketplace pages the dialog links into.
      requireWorkspaceAdmin(access.active, "api");
      const project = requireRepo(access.project);
      const runtime = getRuntime();

      const [source, drafts, index] = await Promise.all([
        getAgentSource(project.repoInstallationId, {
          owner: project.repoOwner,
          repo: project.repoName,
        }),
        listDrafts(project.id),
        runtime.catalog.index().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      const ctx = await resolveSyncedAgentContext(
        project.id,
        null,
        source.paths,
      );
      const lock = overlayLock(
        source.files["harnesst-lock.json"] ?? null,
        drafts.map((d) => ({ path: d.path, content: d.content })),
      );
      const providers = await catalogProviderEvidence(runtime.catalog, lock);

      const targets = ctx.roster.flatMap((agent) => {
        // A single-agent repo's root agent is `member: null` in the lock; its name is cosmetic.
        const lockMember = ctx.isTeam ? agent.name : null;
        return ["", ...declaredSubagentPaths(source.paths, agent.root)].map(
          (subagentPath) => ({
            value: encodeMemberSelection(agent.name, subagentPath),
            member: agent.name,
            subagentPath,
            installed: installedKeysAtTarget(
              lock,
              lockMember,
              subagentPath,
              providers,
            ),
          }),
        );
      });

      if (!index.ok) {
        // Unreachable catalog is an expected state, as on the marketplace page — the error stays
        // server-side (fixture failures name filesystem paths).
        console.warn("[marketplace picker] catalog index failed:", index.error);
      }
      return {
        templates: index.ok
          ? index.value.templates.map(
              ({ id, type, name, version, description }) => ({
                id,
                type,
                name,
                version,
                description,
              }),
            )
          : [],
        catalogError: index.ok ? null : "The template catalog is unreachable.",
        isTeam: ctx.isTeam,
        targets,
      };
    },
    { ensureSignedIn: true },
  );
