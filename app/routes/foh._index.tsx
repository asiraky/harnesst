/**
 * FOH home index — the right side of the shell before any agent is picked. Empty states
 * (§6 legibility): no teams at all, or a pick-an-agent hint.
 */
import { MessageSquare, Users } from "lucide-react";
import { useRouteLoaderData } from "react-router";

import type { loader as fohLoader } from "./foh";

export default function FohIndex() {
  const data = useRouteLoaderData<typeof fohLoader>("routes/foh");
  // The layout's loader also has a marketing-landing branch (host split, D11); in that mode
  // the layout never renders its Outlet, so this narrowing only satisfies the type union.
  const shell = data && "teams" in data ? data : null;
  const hasTeams = (shell?.teams.length ?? 0) > 0;

  return (
    // Hidden below md: at `/` the sidebar is the whole page there.
    <section className="hidden min-w-0 flex-1 items-center justify-center md:flex">
      <div className="max-w-sm px-6 text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          {hasTeams ? (
            <MessageSquare className="size-6" aria-hidden />
          ) : (
            <Users className="size-6" aria-hidden />
          )}
        </div>
        {hasTeams ? (
          <>
            <h1 className="text-lg font-semibold">Talk to your team</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a team member in the sidebar to see your conversations with
              them, or start a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">No teams yet</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {shell?.backOfHouse
                ? "Connect a repository in back of house — its agents show up here, ready to work with."
                : "You're not on any team yet. Ask a workspace admin to invite you to a repository."}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
