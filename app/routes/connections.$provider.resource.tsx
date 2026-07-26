/**
 * Post-consent resource picker route (issue #166) — `/connections/:provider/resource`. Rendered
 * after a capability provider's consent when the connected account spans several provider-side
 * resources (e.g. a Xero login with access to multiple organisations): the grant is stored
 * unbound and stays unusable (deploys fail readable, capability calls refuse) until one is
 * picked here. Same page skeleton as the connect flow's pages.
 */
import { Plug } from "lucide-react";
import { Form, Link, useActionData } from "react-router";

import {
  resourcePickerAction,
  resourcePickerLoader,
  type ResourcePickerData,
} from "~/capabilities/resource-flow.server";
import { ConnectionFlowErrorPage } from "~/connections/flow-page";
import { AppShell, PageHeader } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { noindexMeta } from "~/lib/seo";
import type { Route } from "./+types/connections.$provider.resource";

export const loader = (args: Route.LoaderArgs) =>
  resourcePickerLoader(args, args.params.provider ?? "");

export const action = (args: Route.ActionArgs) =>
  resourcePickerAction(args, args.params.provider ?? "");

export function meta() {
  return [{ title: "Connect · harnesst" }, ...noindexMeta];
}

export default function ConnectionResourcePicker({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<ResourcePickerData & { user: unknown }>();
  const data = actionData ?? loaderData;
  const { error, backUrl, providerLabel, resourceLabel, options, current } = data;
  const userEmail = loaderData.user.email;

  if (error) {
    return (
      <ConnectionFlowErrorPage
        title={`Connect ${providerLabel}`}
        description={`Something went wrong while binding the ${providerLabel} connection.`}
        alertTitle={`Can’t pick the ${resourceLabel}`}
        error={error}
        backUrl={backUrl}
        userEmail={userEmail}
      />
    );
  }

  return (
    <AppShell userEmail={userEmail}>
      <PageHeader
        icon={Plug}
        accent="brand"
        title={`Connect ${providerLabel}`}
        description={`Pick which ${resourceLabel} this agent works in.`}
        actions={
          <Button variant="ghost" asChild>
            <Link to={backUrl}>← Back</Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Choose a {resourceLabel}
          </CardTitle>
          <CardDescription>
            The connected {providerLabel} account can reach more than one{" "}
            {resourceLabel}. Every operation this agent runs targets the one
            you pick — you can change it later by reconnecting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* The picker's identity (project/agent/returnTo) rides in the URL's query string,
              which React Router's Form preserves on POST — nothing else to round-trip. */}
          <Form method="post" className="grid gap-3">
            {options.map((option) => (
              <Label
                key={option.id}
                className="flex items-center gap-2 text-sm font-normal"
              >
                <input
                  type="radio"
                  name="resourceId"
                  value={option.id}
                  defaultChecked={
                    current ? option.id === current : options[0].id === option.id
                  }
                  className="size-4 accent-primary"
                />
                <span className="font-medium">{option.name}</span>
              </Label>
            ))}
            <div>
              <Button type="submit" size="sm">
                Use this {resourceLabel}
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </AppShell>
  );
}
