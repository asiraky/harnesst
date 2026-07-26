import { useState } from "react";
import { Building2, MailPlus, Users } from "lucide-react";
import { Form, redirect } from "react-router";

import {
  grantsNoAccess,
  splitInvitationTeamIds,
} from "~/auth/invitation-grant.server";
import { requireSession, sessionLoader } from "~/auth/session.server";
import { ensureProjectTeam } from "~/auth/teams.server";
import {
  ensureWorkspace,
  requireBackOfHouse,
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
 * The access a workspace invitation grants (issue #220 §4, Option B). `admin` is back of house —
 * build, deploy, settings. `member` is front of house only, and is meaningful ONLY when the
 * invitation also carries the teams of the repos they may use: a member with no team lands in a
 * workspace where every surface turns them away, so this route refuses to mint one.
 */
const INVITE_ROLES = ["admin", "member"] as const;
type InviteRole = (typeof INVITE_ROLES)[number];

function parseInviteRole(value: unknown): InviteRole | null {
  return INVITE_ROLES.includes(value as InviteRole)
    ? (value as InviteRole)
    : null;
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

export const loader = (args: Route.LoaderArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      await ensureWorkspace(args.request, auth);
      const active = await resolveActiveWorkspace(auth);
      // Back of house is admin/owner-only (D10); front-of-house members live at `/`.
      if (active) requireBackOfHouse(active, "page");
      if (!active) {
        return {
          org: null,
          members: [],
          pendingInvites: [],
          repos: [],
          currentUserId: auth.user.id,
          canManage: false,
        };
      }

      const [memberList, permission] = await Promise.all([
        listAllMembers(active.org.id, auth.requestHeaders),
        betterAuth.api.hasPermission({
          body: {
            organizationId: active.org.id,
            permissions: {
              organization: ["update"],
              invitation: ["create", "cancel"],
            },
          },
          headers: auth.requestHeaders,
        }),
      ]);
      const canManage = permission.success;
      const [invitations, projectList] = await Promise.all([
        canManage
          ? betterAuth.api.listInvitations({
              query: { organizationId: active.org.id },
              headers: auth.requestHeaders,
            })
          : [],
        listProjects(active.org.id),
      ]);
      // A pending invitation names its repos by team id; resolve them so the admin reviewing the
      // list sees the access they actually granted rather than an opaque role.
      const repoNameByTeamId = new Map(
        projectList.flatMap((project) =>
          project.teamId ? [[project.teamId, project.name] as const] : [],
        ),
      );

      return {
        org: active.org,
        members: memberList.map((membership) => ({
          id: membership.id,
          userId: membership.userId,
          email: membership.user.email,
          name: membership.user.name,
          role: membership.role,
        })),
        pendingInvites: invitations.flatMap((invitation) => {
          if (invitation.status !== "pending") return [];
          const role = invitation.role || "member";
          const repos = splitInvitationTeamIds(invitation.teamId).flatMap(
            (teamId) => {
              const name = repoNameByTeamId.get(teamId);
              return name ? [name] : [];
            },
          );
          return [
            {
              id: invitation.id,
              email: invitation.email,
              role,
              repos,
              // The repo names ARE the live teams — each one came from a project in this
              // workspace — so an empty list on a member invitation is exactly the decayed
              // grant the accept boundary refuses. Surface it here so an admin can see why.
              grantsAccess: role !== "member" || repos.length > 0,
              expiresAt: invitation.expiresAt,
            },
          ];
        }),
        repos: projectList.map((project) => ({
          id: project.id,
          name: project.name,
        })),
        currentUserId: auth.user.id,
        canManage,
      };
    },
    { ensureSignedIn: true },
  );

export async function action(args: Route.ActionArgs) {
  const session = await requireSession(args);
  const active = await resolveActiveWorkspace(session);
  if (!active) return { error: "No active workspace." };
  requireBackOfHouse(active, "api");

  const form = await args.request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "invite") {
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email || !email.includes("@"))
      return { error: "Enter a valid email address." };

    const role = parseInviteRole(form.get("role"));
    if (!role) return { error: "Choose what access this invitation grants." };

    // A `member` invitation must carry the teams of the repos they may use, or accepting it
    // leaves them in no-access limbo: not an admin (no back of house) and on no team (no front
    // of house either). Admins need no repo selection — they see every repo.
    let teamIds: string[] = [];
    let projectIds: string[] = [];
    if (role === "member") {
      const requested = new Set(
        form.getAll("repoIds").map((value) => String(value)),
      );
      // Resolve the ids against THIS workspace's projects: never trust a form-supplied id, and
      // never mint a team for a repo the caller's workspace doesn't own.
      const selected = (await listProjects(active.org.id)).filter((project) =>
        requested.has(project.id),
      );
      if (selected.length === 0) {
        return {
          error: "Choose at least one repository this member can work with.",
        };
      }
      if (selected.length !== requested.size) {
        return { error: "That repository is not part of this workspace." };
      }
      try {
        teamIds = await Promise.all(
          selected.map((project) => ensureProjectTeam(active.org.id, project)),
        );
      } catch {
        return { error: "Could not prepare the selected repositories." };
      }
      projectIds = selected.map((project) => project.id);
    }

    try {
      await betterAuth.api.createInvitation({
        body: {
          email,
          role,
          organizationId: active.org.id,
          ...(teamIds.length > 0 ? { teamId: teamIds } : {}),
        },
        headers: session.requestHeaders,
      });
    } catch (error) {
      return {
        error: publicAuthErrorMessage(error, "Could not send the invitation."),
      };
    }
    await recordAudit({
      orgId: active.org.id,
      actorUserId: session.user.id,
      action: "member_invited",
      target: email,
      meta: { role, projectIds, teamIds },
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
      // No client-chosen access: resend replays the STORED grant. Re-minting a bare `member`
      // here (the old behaviour) would silently drop a pending invitation's repo teams and
      // recreate exactly the no-access limbo the invite intent now refuses to produce.
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
          // only its expiry — the role and teams here are never written. That is precisely why
          // the stored grant has to be validated above rather than corrected in this body.
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

/**
 * The invite form (issue #220 §4, Option B). One entry point, but the access it grants is
 * explicit: an administrator gets everything, a member gets front-of-house chat for the repos
 * picked here — and nothing can be sent without that choice being made.
 */
function InviteTeammate({ repos }: { repos: { id: string; name: string }[] }) {
  const noRepos = repos.length === 0;
  // Never start on the option that is about to be disabled: a disabled radio still paints as
  // selected but is omitted from the submission, so the form would look ready and then come
  // back with "choose what access this grants".
  const [role, setRole] = useState<"admin" | "member">(
    noRepos ? "admin" : "member",
  );

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
            <legend className="text-sm font-medium">Access</legend>
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
                  Full access to this workspace — build, deploy, and manage
                  every repository, plus these settings.
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
                    : "Works with agents in the repositories you choose. No access to the build surface."}
                </span>
              </span>
            </label>
          </fieldset>

          {role === "member" && !noRepos && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Which repositories?
              </legend>
              <p className="text-xs text-muted-foreground">
                A member can only reach the repositories you select here.
              </p>
              <ul className="divide-y rounded-lg border">
                {repos.map((repo) => (
                  <li key={repo.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        name="repoIds"
                        value={repo.id}
                        className="accent-primary"
                      />
                      <span className="min-w-0 truncate">{repo.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
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
  const {
    user,
    org,
    members,
    pendingInvites,
    repos,
    currentUserId,
    canManage,
  } = loaderData;
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
        description="Owners and admins build and manage the workspace; members chat with the agents in the repositories they've been given."
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
            {canManage ? (
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
            ) : (
              <p className="text-sm font-medium">{org.name}</p>
            )}
          </CardContent>
        </Card>

        {canManage && <InviteTeammate repos={repos} />}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className={`size-4 ${accentText.brand}`} aria-hidden />
              Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y rounded-lg border text-sm">
              {members.map((membership) => (
                <li
                  key={membership.id}
                  className="flex items-center justify-between gap-3 px-4 py-2"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{membership.name}</span>{" "}
                    <span className="text-muted-foreground">
                      {membership.email}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{membership.role}</Badge>
                    {membership.userId === currentUserId && (
                      <Badge variant="secondary">you</Badge>
                    )}
                  </span>
                </li>
              ))}
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
                        {invitation.role === "member"
                          ? invitation.grantsAccess
                            ? `Member · ${invitation.repos.join(", ")}`
                            : "Member · no repositories — this invitation grants no access. Cancel it and send a new one."
                          : `${invitation.role.charAt(0).toUpperCase()}${invitation.role.slice(1)} · full workspace access`}
                      </span>
                    </span>
                    {canManage && (
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
                    )}
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
