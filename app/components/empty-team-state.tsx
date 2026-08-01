import type { ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

export function EmptyTeamState({
  agentsHref,
  action,
}: {
  agentsHref: string;
  action?: ReactNode;
}) {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <CardTitle>No agents yet</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3 text-center">
        <p className="max-w-md text-sm text-muted-foreground">
          Add the first agent to start configuring, running, and deploying this team.
        </p>
        {action ?? (
          <Button asChild>
            <Link to={agentsHref}>Add your first agent on the Agents tab</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
