import { redirect } from "react-router";
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { userWorkspaceMemory } from "~/db/schema";
import { newId } from "~/lib/id";
import { auth } from "~/lib/auth.server";
import { isWorkspaceAdmin, isWorkspaceOwner } from "./roles";
import { returnToFromRequest } from "./return-to";
import type { SessionAuth } from "./session.server";

export type WorkspaceInfo = {
  id: string;
  name: string;
  slug: string;
};

export type ActiveWorkspace = {
  org: WorkspaceInfo;
  member: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  };
};

export { isWorkspaceAdmin, isWorkspaceOwner };

/**
 * Enforce a workspace-admin-only surface: a plain `member` is redirected home from page GET
 * loaders (`"page"` — friendly for humans) and receives a hard 403 JSON Response from
 * API/resource routes AND mutations (`"api"` — a denied POST must never silently navigate).
 */
export function requireWorkspaceAdmin(
  active: ActiveWorkspace,
  mode: "page" | "api",
): void {
  if (isWorkspaceAdmin(active.member.role)) return;
  if (mode === "page") throw redirect("/");
  throw Response.json(
    { error: "This action is restricted to workspace admins." },
    { status: 403 },
  );
}

export function chooseWorkspaceEntry(input: {
  membershipOrgIds: string[];
  lastOrgId?: string | null;
}): { kind: "create" } | { kind: "enter"; orgId: string } | { kind: "choose" } {
  if (input.membershipOrgIds.length === 0) return { kind: "create" };
  if (input.membershipOrgIds.length === 1) {
    return { kind: "enter", orgId: input.membershipOrgIds[0] };
  }
  // A remembered workspace only counts while the user is still a member of it.
  if (input.lastOrgId && input.membershipOrgIds.includes(input.lastOrgId)) {
    return { kind: "enter", orgId: input.lastOrgId };
  }
  return { kind: "choose" };
}

export async function listUserWorkspaces(
  session: SessionAuth,
): Promise<WorkspaceInfo[]> {
  const organizations = await auth.api.listOrganizations({
    headers: session.requestHeaders,
  });
  return organizations.map(({ id, name, slug }) => ({ id, name, slug }));
}

export async function resolveActiveWorkspace(
  session: SessionAuth,
): Promise<ActiveWorkspace | null> {
  if (!session.organizationId) return null;
  try {
    const [member, workspaces] = await Promise.all([
      auth.api.getActiveMember({ headers: session.requestHeaders }),
      listUserWorkspaces(session),
    ]);
    const org = workspaces.find(
      (workspace) => workspace.id === session.organizationId,
    );
    if (!member || member.organizationId !== session.organizationId || !org)
      return null;
    return { org, member };
  } catch {
    return null;
  }
}

export async function setActiveWorkspace(
  session: SessionAuth,
  organizationId: string | null,
) {
  const result = await auth.api.setActiveOrganization({
    body: { organizationId },
    headers: session.requestHeaders,
  });
  // Remember the choice across sessions: Better Auth scopes activeOrganizationId to the session,
  // so without this a multi-workspace user lands on the chooser after every fresh sign-in.
  if (organizationId) {
    await db
      .insert(userWorkspaceMemory)
      .values({ userId: session.user.id, lastOrgId: organizationId })
      .onConflictDoUpdate({
        target: userWorkspaceMemory.userId,
        set: { lastOrgId: organizationId, updatedAt: new Date() },
      });
  }
  return result;
}

async function lastWorkspaceId(userId: string): Promise<string | null> {
  const rows = await db
    .select({ lastOrgId: userWorkspaceMemory.lastOrgId })
    .from(userWorkspaceMemory)
    .where(eq(userWorkspaceMemory.userId, userId))
    .limit(1);
  return rows[0]?.lastOrgId ?? null;
}

function personalWorkspaceName(session: SessionAuth): string {
  const firstName = session.user.name.trim().split(/\s+/)[0];
  const fallback = session.user.email.split("@")[0];
  return `${firstName || fallback || "My"}'s workspace`;
}

function personalWorkspaceSlug(session: SessionAuth): string {
  return workspaceSlug(session.user.name);
}

function workspaceSlug(name: string): string {
  const stem = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${stem || "workspace"}-${newId().toLowerCase()}`;
}

async function createPersonalWorkspace(session: SessionAuth): Promise<string> {
  const organization = await auth.api.createOrganization({
    body: {
      name: personalWorkspaceName(session),
      slug: personalWorkspaceSlug(session),
    },
    headers: session.requestHeaders,
  });
  if (!organization)
    throw new Error("Better Auth did not create an organization.");
  return organization.id;
}

/**
 * Create an additional workspace owned by the caller and make it the active one. Better Auth
 * seeds the creator as `owner`; no repo grants are needed because owners hold every repo.
 */
export async function createWorkspace(
  session: SessionAuth,
  name: string,
): Promise<string> {
  const organization = await auth.api.createOrganization({
    body: { name, slug: workspaceSlug(name) },
    headers: session.requestHeaders,
  });
  if (!organization)
    throw new Error("Better Auth did not create an organization.");
  await setActiveWorkspace(session, organization.id);
  return organization.id;
}

export async function ensureWorkspace(
  request: Request,
  session: SessionAuth,
): Promise<void> {
  if (await resolveActiveWorkspace(session)) return;

  if (session.organizationId) {
    await setActiveWorkspace(session, null);
  }

  const replayTo = returnToFromRequest(request);
  const workspaces = await listUserWorkspaces(session);
  const decision = chooseWorkspaceEntry({
    membershipOrgIds: workspaces.map((workspace) => workspace.id),
    lastOrgId: await lastWorkspaceId(session.user.id),
  });

  if (decision.kind === "choose") {
    throw redirect(`/workspaces?returnTo=${encodeURIComponent(replayTo)}`);
  }

  if (decision.kind === "create") {
    await createPersonalWorkspace(session);
  } else {
    await setActiveWorkspace(session, decision.orgId);
  }
  throw redirect(replayTo);
}
