/**
 * FOH right-pane empty state — an agent is selected but no session is open (§6 legibility:
 * "no sessions with an agent" empty state).
 */
import { MessageSquarePlus } from "lucide-react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Button } from "~/components/ui/button";
import type { loader as agentLoader, action as agentAction } from "./foh.agent";

// The parent's new-session action, re-exported so this index route can take the
// POST itself — a relative `action="."` from an index route still targets the index.
export { action } from "./foh.agent";

export default function FohAgentIndex() {
  const parent = useRouteLoaderData<typeof agentLoader>("routes/foh.agent");
  const newSessionFetcher = useFetcher<typeof agentAction>();
  const agentName = parent?.agentName ?? "this agent";
  const hasSessions = (parent?.sessions.length ?? 0) > 0;

  return (
    // Hidden below md: with no session open the session list is the whole page.
    <section className="hidden min-w-0 flex-1 items-center justify-center md:flex">
      <div className="max-w-sm px-6 text-center">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MessageSquarePlus className="size-6" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">
          {hasSessions
            ? "Pick a session"
            : `No sessions with ${agentName} yet`}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasSessions
            ? "Open a conversation from the list, or start a fresh one."
            : `Start a conversation — give ${agentName} a piece of work, and come back whenever you're needed.`}
        </p>
        <newSessionFetcher.Form method="post">
          <input type="hidden" name="intent" value="new-session" />
          <Button
            type="submit"
            className="mt-4"
            disabled={newSessionFetcher.state !== "idle"}
          >
            New session
          </Button>
        </newSessionFetcher.Form>
      </div>
    </section>
  );
}
