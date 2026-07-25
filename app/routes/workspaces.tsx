/**
 * Workspace chooser + switch endpoint (issue #56).
 *
 * A user who belongs to more than one workspace picks one here at sign-in; `ensureWorkspace`
 * redirects org-less multi-workspace sessions to `/workspaces?returnTo=…`. The same POST action
 * is the switch endpoint used by the in-app workspace menu. Better Auth validates membership,
 * stores the selected organization on the session, and the route redirects on.
 *
 * This route must NEVER call `ensureWorkspace`: it is the target of that redirect, so doing so
 * would loop. It reads the user's organizations from the Better Auth plugin directly.
 */
import { Check } from "lucide-react";
import {
  data,
  Form,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import { safeReturnTo } from "~/auth/return-to";
import { requireSession, sessionLoader } from "~/auth/session.server";
import {
  listUserWorkspaces,
  setActiveWorkspace,
} from "~/auth/workspace.server";
import { AppShell } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/workspaces";

export const loader = (args: LoaderFunctionArgs) =>
  sessionLoader(
    args,
    async ({ auth }) => {
      const workspaces = await listUserWorkspaces(auth);
      const url = new URL(args.request.url);
      const returnTo = safeReturnTo(url.searchParams.get("returnTo"));

      // No workspaces at all → let the dashboard provision one (ensureWorkspace).
      if (workspaces.length === 0) throw redirect("/dashboard");

      // A single-workspace user should never see a picker: if the session isn't scoped yet,
      // enter that one workspace and continue to where they were headed.
      if (workspaces.length === 1 && !auth.organizationId) {
        await setActiveWorkspace(auth, workspaces[0].id);
        throw redirect(returnTo);
      }

      return { workspaces, currentOrgId: auth.organizationId, returnTo };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const session = await requireSession(args);
  const form = await args.request.formData();
  const orgId = String(form.get("orgId") ?? "");
  const returnTo = safeReturnTo(String(form.get("returnTo") ?? ""));
  if (!orgId) throw redirect("/workspaces");

  const workspaces = await listUserWorkspaces(session);
  if (!workspaces.some((workspace) => workspace.id === orgId)) {
    return data(
      { error: "You are not a member of that workspace." },
      { status: 403 },
    );
  }

  try {
    await setActiveWorkspace(session, orgId);
  } catch {
    return data({ error: "You cannot enter that workspace." }, { status: 403 });
  }
  throw redirect(returnTo);
}

export function meta() {
  return [{ title: "Choose a workspace · harnesst" }, ...noindexMeta];
}

export default function Workspaces({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { user, workspaces, currentOrgId, returnTo } = loaderData;
  return (
    <AppShell userEmail={user?.email}>
      <div className="mx-auto max-w-md py-10">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Choose a workspace
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            You belong to more than one workspace. Pick the one to work in.
          </p>
        </div>
        {actionData?.error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actionData.error}
          </p>
        )}
        <div className="space-y-3">
          {workspaces.map((ws) => {
            const isCurrent = ws.id === currentOrgId;
            return (
              <Card
                key={ws.id}
                className="transition-colors hover:border-ring/60"
              >
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 truncate text-base">
                    {ws.name}
                    {isCurrent && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        <Check className="size-3" aria-hidden />
                        Current
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {ws.id}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Form method="post">
                    <input type="hidden" name="orgId" value={ws.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <Button
                      type="submit"
                      className="w-full"
                      variant={isCurrent ? "secondary" : "default"}
                    >
                      {isCurrent ? "Continue" : "Enter workspace"}
                    </Button>
                  </Form>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
