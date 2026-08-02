/**
 * FOH inbox resource route (D5/D12) — the 🔔 badge + flyout's data source, copied from the
 * workspace-tasks pattern: the indicator self-fetches this with a keyed fetcher and polls
 * (3s with pending items / 10s idle, hidden-tab pause). Scope is the viewer's FOH project
 * set (admins: all org repos; members: their teams' repos).
 *
 * GET → pending items (enriched for display) + count.
 * POST intent=resolve → dismiss one `finished` item the viewer can see (tenant + D5
 * ownership guard: the item must be in scope AND theirs or team-wide — resolving another
 * user's personal item is refused by construction, since the visibility query never returns
 * it). Question/approval items are NOT dismissible through this generic action: they resolve
 * through the explicit session-read acknowledgement or at event-drain chokepoints
 * (answer/approve → continuation, terminal failure, supersession). A bare item-id resolve would
 * otherwise clear a shared needs-you signal without proving the conversation is on screen.
 */
import { getSessionAuth, sessionLoader } from "~/auth/session.server";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  isBackOfHouse,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { listInboxForViewer } from "~/foh/inbox.server";
import { listViewerProjectIds } from "~/foh/sidebar.server";
import { getRuntime } from "~/seams/index.server";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const active = await resolveActiveWorkspace(auth);
      if (!active) return { items: [], count: 0 };
      const projectIds = await listViewerProjectIds({
        userId: auth.user.id,
        orgId: active.org.id,
        backOfHouse: isBackOfHouse(active.member.role),
      });
      const items = await listInboxForViewer({
        userId: auth.user.id,
        projectIds,
      });
      return { items, count: items.length };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const active = await resolveActiveWorkspace(auth);
  if (!active) return { ok: false as const };
  const form = await args.request.formData();
  if (String(form.get("intent")) !== "resolve") return { error: "Unknown action." };
  const itemId = String(form.get("itemId") ?? "");
  if (!itemId) return { ok: false as const };

  const projectIds = await listViewerProjectIds({
    userId: auth.user.id,
    orgId: active.org.id,
    backOfHouse: isBackOfHouse(active.member.role),
  });
  // Scope + ownership in one query: the D5 visibility rule only ever returns the viewer's
  // own items and team-wide (NULL-recipient) ones, within their scoped projects.
  const store = getRuntime().data;
  const visible = await store.inboxItems.listPendingForProjects(
    projectIds,
    auth.user.id,
  );
  const item = visible.find((candidate) => candidate.id === itemId);
  if (!item) return { ok: false as const };
  // Only the dismissible kind: question/approval acknowledgement belongs to the scoped read
  // route (or the drain chokepoints), not an arbitrary item-id mutation.
  if (item.kind !== "finished") return { ok: false as const };
  await store.inboxItems.resolve(item.id);
  return { ok: true as const };
}
