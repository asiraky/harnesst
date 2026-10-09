/**
 * Legacy redirect: the retired Back-of-House Playground (`/repos/:id/playground` and the team
 * member's `/repos/:id/agents/:name/playground`) → that agent's conversations in Chat (front of
 * house), which replaced it. A team's repo-level URL lands on the team's activity feed. Read
 * access is enough: Chat is open to every repo member, so an old bookmark must not 403 a viewer.
 * `?session=` is dropped on purpose — Playground conversations are their own surface and Chat
 * does not list them.
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

import { sessionLoader } from "~/auth/session.server";
import { buildToChatHref } from "~/lib/surfaces";
import {
  agentFromParams,
  resolveAgentContext,
} from "~/project/agent-context.server";
import { requireProjectAccess } from "~/project/guard.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const { project } = await requireProjectAccess(
        auth,
        args.params.projectId,
        "read",
      );
      const agentName = agentFromParams(args.params);
      const { roster } = await resolveAgentContext(project.id, agentName);
      const repoPath = `/repos/${encodeURIComponent(project.slug)}`;
      const href = buildToChatHref(
        agentName
          ? `${repoPath}/agents/${encodeURIComponent(agentName)}`
          : repoPath,
        [
          {
            slug: project.slug,
            layout: project.layout === "team" ? "team" : "single",
            agents: roster.map((a) => ({ id: a.id, name: a.name })),
          },
        ],
      );
      throw redirect(href ?? "/", 301);
    },
    { ensureSignedIn: true },
  );
