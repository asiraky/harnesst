import { Building2, MailPlus, Users } from "lucide-react";
import { Form, redirect } from "react-router";

import { requireSession, sessionLoader } from "~/auth/session.server";
import {
  ensureWorkspace,
  requireBackOfHouse,
  resolveActiveWorkspace,
} from "~/auth/workspace.server";
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
      const invitations = canManage
        ? await betterAuth.api.listInvitations({
            query: { organizationId: active.org.id },
            headers: auth.requestHeaders,
          })
        : [];

      return {
        org: active.org,
        members: memberList.map((membership) => ({
          id: membership.id,
          userId: membership.userId,
          email: membership.user.email,
          name: membership.user.name,
          role: membership.role,
        })),
        pendingInvites: invitations.flatMap((invitation) =>
          invitation.status === "pending"
            ? [
                {
                  id: invitation.id,
                  email: invitation.email,
                  role: invitation.role || "member",
                  expiresAt: invitation.expiresAt,
                },
              ]
            : [],
        ),
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
    try {
      await betterAuth.api.createInvitation({
        body: { email, role: "member", organizationId: active.org.id },
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
      // No client-chosen role: when a pending invitation exists Better Auth re-sends it with its
      // STORED role; when it lapsed, this mints a fresh invite that must follow the same "new
      // invitees join with the member role" policy as the invite intent above.
      await betterAuth.api.createInvitation({
        body: {
          email,
          role: "member",
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

export default function Members({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, org, members, pendingInvites, currentUserId, canManage } =
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
        description="Owners and admins manage the workspace; members have read-only access to organization settings."
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

        {canManage && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MailPlus
                  className={`size-4 ${accentText.emerald}`}
                  aria-hidden
                />
                Invite a teammate
              </CardTitle>
              <CardDescription>
                harnesst emails a secure invitation link. New invitees join with
                the member role.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post" className="flex max-w-xl items-end gap-2">
                <input type="hidden" name="intent" value="invite" />
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    placeholder="teammate@company.com"
                    required
                  />
                </div>
                <Button type="submit">Send invite</Button>
              </Form>
            </CardContent>
          </Card>
        )}

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
                    <span>
                      <span className="font-medium">{invitation.email}</span>
                      <span className="ml-2 text-muted-foreground">
                        expires <LocalizedDate value={invitation.expiresAt} />
                      </span>
                    </span>
                    {canManage && (
                      <span className="flex items-center gap-2">
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
