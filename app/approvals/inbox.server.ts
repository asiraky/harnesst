/**
 * Open approvals as inbox rows. Only viewers who can decide (write on the team's project) are
 * asked: a read-only member can open the card but nothing is waiting on them.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ProjectGrant } from "~/auth/project-access.server";
import { db } from "~/db/client.server";
import { approvals, projects } from "~/db/schema";
import type { InboxViewItem } from "~/foh/inbox.server";
import { approvalPath } from "./approvals.server";

export async function listApprovalInboxItems(
  grants: ProjectGrant[],
): Promise<InboxViewItem[]> {
  const projectIds = grants.filter((g) => g.role === "write").map((g) => g.projectId);
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({
      id: approvals.id,
      title: approvals.title,
      projectId: approvals.projectId,
      projectName: projects.name,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(projects, eq(projects.id, approvals.projectId))
    .where(and(inArray(approvals.projectId, projectIds), eq(approvals.status, "pending")))
    .orderBy(asc(approvals.createdAt));
  return rows.map((row) => ({
    id: `approval:${row.id}`,
    kind: "approval",
    prompt: row.title,
    createdAt: row.createdAt.toISOString(),
    projectId: row.projectId,
    agentId: null,
    agentName: row.projectName,
    // Not a conversation: never matches the open session, so it always shows.
    sessionId: "",
    sessionTitle: "Approval",
    href: approvalPath(row.id),
  }));
}
