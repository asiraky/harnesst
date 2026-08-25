import { useState } from "react";
import { Building2, MailPlus, Users } from "lucide-react";
import { Form, redirect } from "react-router";

import { grantsNoAccess } from "~/auth/invitation-grant.server";
import {
  listInvitationGrants,
  listOrgProjectAccess,
  parseProjectRole,
  revokeAllProjectAccess,
  setInvitationGrants,
  setProjectAccess,
  type ProjectGrant,
  type ProjectRole,
} from "~/auth/project-access.server";
import { requireSession, sessionLoader } from "~/auth/session.server";
import {
  ensureWorkspace,
  isWorkspaceOwner,
  requireWorkspaceAdmin,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
import { listProjects } from "~/db/queries.server";
import { AppShell, PageHeader, accentText } from "~/components/shell";
import { LocalizedDate } from "~/components/localized-values";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { noindexMeta } from "~/lib/seo";
import { auth as betterAuth } from "~/lib/auth.server";
import { publicAuthErrorMessage } from "~/lib/auth-error.server";
import { recordAudit } from "~/managed/audit.server";
import type { Route } from "./+types/org.members";

type MemberRow = Awaited<
  ReturnType<typeof betterAuth.api.listMembers>
>["members"][number];

/**
 * The permissions model (two layers):
 *
 * - Workspace role. `owner` holds every repo implicitly and is the only role that can hand out
 *   ownership. `admin` manages people, settings and the GitHub install and can create repos —
 *   but has NO implicit access to repos it was not granted. `member` has nothing beyond its
 *   repo grants.
 * - Repo access, per member and per repo: `read` (front of house — chat, inbox) or `write`
 *   (build and deploy). A repo a user holds no grant on is invisible to them.
 *
 * Only workspace owners/admins reach this page, and only they grant repo access (Option A).
 */
const INVITE_ROLES = ["admin", "member"] as const;
type InviteRole = (typeof INVITE_ROLES)[number];
const MEMBER_ROLES = ["owner", "admin", "member"] as const;
type WorkspaceRole = (typeof MEMBER_ROLES)[number];

function parseInviteRole(value: unknown): InviteRole | null {
  return INVITE_ROLES.includes(value as InviteRole)
    ? (value as InviteRole)
    : null;
}
function parseWorkspaceRole(value: unknown): WorkspaceRole | null {
  return MEMBER_ROLES.includes(value as WorkspaceRole)
    ? (value as WorkspaceRole)
    : null;
}
/** `none` | `read` | `write` from a form select; anything else is a bad request. */
function parseAccessChoice(value: unknown): ProjectRole | null | undefined {
  if (value === "none" || value === "" || value == null) return null;
  return parseProjectRole(value) ?? undefined;
}

/** Page through Better Auth's member list so workspaces beyond one page don't truncate. */
async function listAllMembers(
  organizationId: string,
  headers: Headers,
): Promise<MemberRow[]> {
  const pageSize = 100;
  const members: MemberRow[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await betterAuth.api.listMembers({
      query: { organizationId, limit: pageSize, offset },
      headers,
    });
    members.push(...page.members);
    if (members.length >= page.total || page.members.length === 0) break;
  }
  return members;
}

/**
 * Read the per-repo access choices out of the invite form (`access:<projectId>`), resolved
 * against THIS workspace's projects so a form-supplied id for another workspace is rejected
 * rather than silently ignored.
 */
async function readGrantsFromForm(
  form: FormData,
  orgId: string,
): Promise<{ grants: ProjectGrant[] } | { error: string }> {
  const projectIds = new Set(
    (await listProjects(orgId)).map((project) => project.id),
  );
  const grants: ProjectGrant[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith("access:")) continue;
    const projectId = key.slice("access:".length);
    if (!projectIds.has(projectId)) {
      return { error: "That repository is not part of this workspace." };
    }
    const role = parseAccessChoice(value);
    if (role === undefined) return { error: "Choose read, write or none." };
    if (role) grants.push({ projectId, role });
  }
  return { grants };
}

export const loader = (args: Route.LoaderArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      if (active) requireWorkspaceAdmin(active, "page");
      if (!active) {
        return {
          org: null,
          members: [],
          pendingInvites: [],
          repos: [],
          currentUserId: auth.user.id,
          isOwner: false,
        };
      }

      const [memberList, invitations, projectList, accessRows] =
        await Promise.all([
          listAllMembers(active.org.id, auth.requestHeaders),
          betterAuth.api.listInvitations({
            query: { organizationId: active.org.id },
            headers: auth.requestHeaders,
          }),
          listProjects(active.org.id),
          listOrgProjectAccess(active.org.id),
        ]);
      const pending = invitations.filter(
        (invitation) => invitation.status === "pending",
      );
      const grantsByInvitation = await listInvitationGrants(
        pending.map((invitation) => invitation.id),
      );
      const accessByUser = new Map<string, Record<string, ProjectRole>>();
      for (const row of accessRows) {
        const current = accessByUser.get(row.userId) ?? {};
        current[row.projectId] = row.role;
        accessByUser.set(row.userId, current);
      }

      return {
        org: active.org,
        members: memberList.map((membership) => ({
          id: membership.id,
          userId: membership.userId,
          email: membership.user.email,
          name: membership.user.name,
          role: membership.role,
          access: accessByUser.get(membership.userId) ?? {},
        })),
        pendingInvites: pending.map((invitation) => {
          const role = invitation.role || "member";
          const grants = grantsByInvitation.get(invitation.id) ?? [];
          return {
            id: invitation.id,
            email: invitation.email,
            role,
            repos: grants.map(
              (grant) => `${grant.projectName} (${grant.role})`,
            ),
            // Grants are joined against live projects, so an empty list on a member
            // invitation is exactly the decayed grant the accept boundary refuses.
            grantsAccess: role !== "member" || grants.length > 0,
            expiresAt: invitation.expiresAt,
          };
        }),
        repos: projectList.map((project) => ({
          id: project.id,
          name: project.name,
        })),
        currentUserId: auth.user.id,
        isOwner: isWorkspaceOwner(active.member.role),
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: Route.ActionArgs) {
  const session = await requireSession(args);
  const active = await resolveActiveWorkspace(session);
  if (!active) return { error: "No active workspace." };
  requireWorkspaceAdmin(active, "api");

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  /** Resolve a member id inside the ACTIVE workspace; never trust a form-supplied id alone. */
  async function findMember(memberId: string): Promise<MemberRow | null> {
    if (!memberId) return null;
    const members = await listAllMembers(active!.org.id, session.requestHeaders);
    return members.find((member) => member.id === memberId) ?? null;
  }

  if (intent === "invite") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@"))
      return { error: "Enter a valid email address." };

    const role = parseInviteRole(form.get("role"));
    if (!role) return { error: "Choose what access this invitation grants." };

    const read = await readGrantsFromForm(form, active.org.id);
    if ("error" in read) return read;
    // A `member` invitation must name at least one repo, or accepting it leaves them in
    // no-access limbo. Admins can always create repos, so theirs may be empty.
    if (role === "member" && read.grants.length === 0) {
      return {
        error: "Choose at least one repository this member can work with.",
      };
    }

    let invitationId: string;
    try {
      const invitation = await betterAuth.api.createInvitation({
        body: { email, role, organizationId: active.org.id },
        headers: session.requestHeaders,
      });
      invitationId = invitation.id;
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not send the invitation."),
      };
    }
    await setInvitationGrants({
      orgId: active.org.id,
      invitationId,
      grants: read.grants,
    });
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "member_invited",
      target: email,
      meta: { role, grants: read.grants },
    });
    throw redirect("/org/members");
  }

  if (intent === "set-access") {
    const member = await findMember(String(form.get("memberId") ?? ""));
    if (!member) return { error: "That member is not part of this workspace." };
    const projectId = String(form.get("projectId") ?? "");
    const role = parseAccessChoice(form.get("role"));
    if (role === undefined) return { error: "Choose read, write or none." };
    // Owners hold every repo implicitly; a per-repo row would be meaningless.
    if (isWorkspaceOwner(member.role)) {
      return { error: "Owners already have access to every repository." };
    }
    const result = await setProjectAccess({
      orgId: active.org.id,
      projectId,
      userId: member.userId,
      role,
      grantedBy: session.user.id,
    });
    if (!result.ok) return { error: result.error };
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "project_access_changed",
      target: member.user.email,
      meta: { projectId, role },
    });
    throw redirect("/org/members");
  }

  if (intent === "set-role") {
    const member = await findMember(String(form.get("memberId") ?? ""));
    if (!member) return { error: "That member is not part of this workspace." };
    if (member.userId === session.user.id) {
      return { error: "You cannot change your own role." };
    }
    const role = parseWorkspaceRole(form.get("role"));
    if (!role) return { error: "Choose a role." };
    try {
      // Better Auth enforces the rest: only an owner may grant or revoke `owner`, and an admin
      // cannot demote an owner.
      await betterAuth.api.updateMemberRole({
        body: { memberId: member.id, role, organizationId: active.org.id },
        headers: session.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not change that role."),
      };
    }
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "member_role_changed",
      target: member.user.email,
      meta: { from: member.role, to: role },
    });
    throw redirect("/org/members");
  }

  if (intent === "remove-member") {
    const member = await findMember(String(form.get("memberId") ?? ""));
    if (!member) return { error: "That member is not part of this workspace." };
    if (member.userId === session.user.id) {
      return { error: "You cannot remove yourself. Leave from the workspace menu instead." };
    }
    try {
      // Better Auth refuses to remove an owner unless the caller is one, and never the last.
      await betterAuth.api.removeMember({
        body: { memberIdOrEmail: member.id, organizationId: active.org.id },
        headers: session.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not remove that member."),
      };
    }
    await revokeAllProjectAccess(active.org.id, member.userId);
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "member_removed",
      target: member.user.email,
    });
    throw redirect("/org/members");
  }

  if (intent === "cancel-invite") {
    const invitationId = String(form.get("invitationId") ?? "");
    // Better Auth authorizes cancellation against the INVITATION's organization, so an id from
    // another workspace the caller administers would succeed while this action audits against
    // the active one. Resolve the id inside the active workspace first, and audit the
    // server-side email — never form-supplied values.
    let cancelled: { email: string };
    try {
      const invitations = await betterAuth.api.listInvitations({
        query: { organizationId: active.org.id },
        headers: session.requestHeaders,
      });
      const invitation = invitations.find(
        (candidate) => candidate.id === invitationId,
      );
      if (!invitation) {
        return { error: "That invitation is not part of this workspace." };
      }
      await betterAuth.api.cancelInvitation({
        body: { invitationId },
        headers: session.requestHeaders,
      });
      cancelled = { email: invitation.email };
    } catch (error) {
      return {
        error: publicAuthErrorMessage(
          error,
          "Could not cancel the invitation.",
        ),
      };
    }
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "invite_revoked",
      target: cancelled.email,
    });
    throw redirect("/org/members");
  }

  if (intent === "resend-invite") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@"))
      return { error: "Enter a valid email address." };
    try {
      // No client-chosen access: resend replays the STORED grant.
      const invitations = await betterAuth.api.listInvitations({
        query: { organizationId: active.org.id },
        headers: session.requestHeaders,
      });
      const pending = invitations.find(
        (candidate) =>
          candidate.status === "pending" &&
          candidate.email.toLowerCase() === email,
      );
      if (!pending) {
        return {
          error:
            "That invitation is no longer pending. Send a new invitation instead.",
        };
      }
      // Resending a decayed grant just extends the window in which someone can accept their
      // way into an empty workspace. Refuse, and point at the fix an admin can actually make.
      if (await grantsNoAccess(pending)) {
        return {
          error:
            "That invitation no longer gives access to any repository. Cancel it and send a new one.",
        };
      }
      await betterAuth.api.createInvitation({
        body: {
          // With `resend: true` Better Auth (1.6.23) re-sends the STORED invitation and updates
          // only its expiry — the role here is never written. That is precisely why the stored
          // grant has to be validated above rather than corrected in this body.
          email,
          role: (pending.role || "member") as InviteRole,
          organizationId: active.org.id,
          resend: true,
        },
        headers: session.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(
          error,
          "Could not resend the invitation.",
        ),
      };
    }
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "invite_resent",
      target: email,
    });
    throw redirect("/org/members");
  }

  if (intent === "rename-workspace") {
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { error: "Enter a workspace name." };
    try {
      await betterAuth.api.updateOrganization({
        body: { organizationId: active.org.id, data: { name } },
        headers: session.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not rename the workspace."),
      };
    }
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "workspace_renamed",
      meta: { name },
    });
    throw redirect("/org/members");
  }

  return { error: "Unknown action." };
}

export function meta() {
  return [{ title: "Members · harnesst" }, ...noindexMeta];
}

const ACCESS_OPTIONS: { value: "none" | ProjectRole; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

const selectClass =
  "h-8 rounded-md border bg-background px-2 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/** One repo's access picker for one member: a self-submitting form. */
function AccessSelect({
  memberId,
  projectId,
  value,
  disabled,
}: {
  memberId: string;
  projectId: string;
  value: ProjectRole | undefined;
  disabled?: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="set-access" />
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="projectId" value={projectId} />
      <select
        name="role"
        defaultValue={value ?? "none"}
        disabled={disabled}
        className={selectClass}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {ACCESS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Form>
  );
}

/** Per-repo access choices shared by the invite form. */
function RepoAccessPicker({
  repos,
}: {
  repos: { id: string; name: string }[];
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {repos.map((repo) => (
        <li
          key={repo.id}
          className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
        >
          <span className="min-w-0 truncate">{repo.name}</span>
          <select
            name={`access:${repo.id}`}
            defaultValue="none"
            className={selectClass}
          >
            {ACCESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </li>
      ))}
    </ul>
  );
}

/**
 * The invite form. The workspace role and the per-repo access are chosen together, and a
 * plain member cannot be sent without at least one repo.
 */
function InviteTeammate({ repos }: { repos: { id: string; name: string }[] }) {
  const noRepos = repos.length === 0;
  // Never start on the option that is about to be disabled: a disabled radio still paints as
  // selected but is omitted from the submission.
  const [role, setRole] = useState<InviteRole>(noRepos ? "admin" : "member");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailPlus className={`size-4 ${accentText.emerald}`} aria-hidden />
          Invite a teammate
        </CardTitle>
        <CardDescription>
          harnesst emails a secure invitation link. Choose what it grants before
          you send it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form method="post" className="max-w-xl space-y-5">
          <input type="hidden" name="intent" value="invite" />
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="teammate@company.com"
              required
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Workspace role</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
              <input
                type="radio"
                name="role"
                value="admin"
                checked={role === "admin"}
                onChange={() => setRole("admin")}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium">Administrator</span>
                <span className="block text-xs text-muted-foreground">
                  Manages members, settings and the GitHub connection, and can
                  create repositories. Sees only the repositories granted below.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4 has-[:checked]:border-primary has-[:checked]:bg-muted/40">
              <input
                type="radio"
                name="role"
                value="member"
                checked={role === "member"}
                onChange={() => setRole("member")}
                className="mt-1 accent-primary"
                disabled={noRepos}
              />
              <span>
                <span className="block text-sm font-medium">Member</span>
                <span className="block text-xs text-muted-foreground">
                  {noRepos
                    ? "Unavailable until this workspace has a connected repository."
                    : "Only the repositories granted below. Read = chat with agents; write = build and deploy."}
                </span>
              </span>
            </label>
          </fieldset>

          {!noRepos && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Repository access</legend>
              <p className="text-xs text-muted-foreground">
                Repositories not listed here stay invisible to them.
              </p>
              <RepoAccessPicker repos={repos} />
            </fieldset>
          )}

          <Button type="submit">Send invite</Button>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function Members({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, org, members, pendingInvites, repos, currentUserId, isOwner } =
    loaderData;
  const error = actionData?.error;

  if (!org) {
    return (
      <AppShell userEmail={user.email}>
        <PageHeader
          title="Members"
          description="You're not scoped to a workspace."
        />
      </AppShell>
    );
  }

  return (
    <AppShell userEmail={user.email}>
      <PageHeader
        title="Members"
        description="Owners hold every repository. Admins manage the workspace but only see the repositories they're granted. Members see only what they're granted."
      />

      <div className="space-y-6">
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2
                className={`size-4 ${accentText.indigo}`}
                aria-hidden
              />
              Workspace
            </CardTitle>
            <CardDescription>
              The workspace name is visible to every member.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="flex max-w-xl items-end gap-2">
              <input type="hidden" name="intent" value="rename-workspace" />
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="name">Workspace name</Label>
                <Input
                  id="name"
                  name="name"
                  defaultValue={org.name}
                  autoComplete="off"
                />
              </div>
              <Button type="submit">Save</Button>
            </Form>
          </CardContent>
        </Card>

        <InviteTeammate repos={repos} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className={`size-4 ${accentText.brand}`} aria-hidden />
              Members &amp; access
            </CardTitle>
            <CardDescription>
              Changes to repository access apply immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border text-sm">
              {members.map((membership) => {
                const self = membership.userId === currentUserId;
                const owner = isWorkspaceOwner(membership.role);
                const roleValue =
                  parseWorkspaceRole(membership.role) ?? "member";
                return (
                  <li key={membership.id} className="space-y-3 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{membership.name}</span>{" "}
                        <span className="text-muted-foreground">
                          {membership.email}
                        </span>
                        {self && (
                          <Badge variant="secondary" className="ml-2">
                            you
                          </Badge>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        {self ? (
                          <Badge variant="outline">{roleValue}</Badge>
                        ) : (
                          <Form method="post" className="flex items-center gap-2">
                            <input type="hidden" name="intent" value="set-role" />
                            <input
                              type="hidden"
                              name="memberId"
                              value={membership.id}
                            />
                            <select
                              name="role"
                              defaultValue={roleValue}
                              className={selectClass}
                              aria-label={`Workspace role for ${membership.email}`}
                              // Only an owner may grant or revoke ownership.
                              disabled={!isOwner && owner}
                              onChange={(event) =>
                                event.currentTarget.form?.requestSubmit()
                              }
                            >
                              {MEMBER_ROLES.filter(
                                (role) => isOwner || role !== "owner",
                              ).map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
                          </Form>
                        )}
                        {!self && (isOwner || !owner) && (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="remove-member"
                            />
                            <input
                              type="hidden"
                              name="memberId"
                              value={membership.id}
                            />
                            <Button type="submit" variant="ghost" size="sm">
                              Remove
                            </Button>
                          </Form>
                        )}
                      </span>
                    </div>
                    {owner ? (
                      <p className="text-xs text-muted-foreground">
                        Owners have write access to every repository.
                      </p>
                    ) : repos.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No repositories in this workspace yet.
                      </p>
                    ) : (
                      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {repos.map((repo) => (
                          <li
                            key={repo.id}
                            className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5"
                          >
                            <span className="min-w-0 truncate text-xs">
                              {repo.name}
                            </span>
                            <AccessSelect
                              memberId={membership.id}
                              projectId={repo.id}
                              value={membership.access[repo.id]}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MailPlus className={`size-4 ${accentText.amber}`} aria-hidden />
              Pending invitations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {pendingInvites.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No pending invitations.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {pendingInvites.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{invitation.email}</span>
                      <span className="ml-2 text-muted-foreground">
                        expires <LocalizedDate value={invitation.expiresAt} />
                      </span>
                      <span
                        className={`mt-0.5 block text-xs ${invitation.grantsAccess ? "text-muted-foreground" : "text-destructive"}`}
                      >
                        {invitation.grantsAccess
                          ? `${invitation.role.charAt(0).toUpperCase()}${invitation.role.slice(1)}${
                              invitation.repos.length > 0
                                ? ` · ${invitation.repos.join(", ")}`
                                : " · no repositories yet"
                            }`
                          : "Member · no repositories — this invitation grants no access. Cancel it and send a new one."}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {invitation.grantsAccess && (
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="resend-invite"
                          />
                          <input
                            type="hidden"
                            name="email"
                            value={invitation.email}
                          />
                          <Button type="submit" variant="outline" size="sm">
                            Resend
                          </Button>
                        </Form>
                      )}
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="cancel-invite"
                        />
                        <input
                          type="hidden"
                          name="invitationId"
                          value={invitation.id}
                        />
                        <Button type="submit" variant="ghost" size="sm">
                          Cancel
                        </Button>
                      </Form>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
