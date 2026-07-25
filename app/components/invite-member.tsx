/**
 * Invite a teammate to THIS repo (FOH invites & roles — the ShareAgent replacement). A button
 * in the repo nav opens a dialog: invite an email, see this repo's pending invitations. The
 * recipient accepts the emailed link and lands in front of house as a workspace `member`
 * scoped to the repo's team.
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { UserRoundPlus } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { LocalizedDate } from "~/components/localized-values";

interface InviteData {
  invites: { id: string; email: string; expiresAt: string }[];
}

type MutationResult = { ok: true } | { error: string } | undefined;

export function InviteMember({ base }: { base: string }) {
  const match = base.match(/^\/repos\/([^/]+)/);
  const projectId = match?.[1] ?? null;
  if (!projectId) return null;
  return <InviteMemberControl projectId={projectId} />;
}

function InviteMemberControl({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const endpoint = `/api/repos/${projectId}/invite`;
  const list = useFetcher<InviteData>();
  const mutate = useFetcher<MutationResult>();
  const { load } = list;

  // Load the pending-invite list when the dialog opens.
  useEffect(() => {
    if (open) load(endpoint);
  }, [open, load, endpoint]);

  // After a successful invite, refresh the list and reset the form.
  const mutateData = mutate.data;
  useEffect(() => {
    if (mutate.state === "idle" && mutateData && "ok" in mutateData) {
      load(endpoint);
      if (emailRef.current) emailRef.current.value = "";
    }
  }, [mutate.state, mutateData, load, endpoint]);

  const error = mutateData && "error" in mutateData ? mutateData.error : null;
  const sent = mutateData && "ok" in mutateData ? sentTo : null;
  const invites = list.data?.invites ?? [];
  const busy = mutate.state !== "idle";

  function submitInvite(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    if (!email) return;
    setSentTo(email);
    mutate.submit(
      { intent: "invite", email },
      { method: "post", action: endpoint },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <UserRoundPlus className="size-4" />
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite to this repository</DialogTitle>
          <DialogDescription>
            harnesst emails a secure invitation link. Invitees join the
            workspace as members and work with this repository&rsquo;s agents in
            front of house.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submitInvite} className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="invite-member-email">Email</Label>
            <Input
              id="invite-member-email"
              ref={emailRef}
              name="email"
              type="email"
              placeholder="teammate@company.com"
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send invite"}
          </Button>
        </form>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {sent && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Invitation sent to {sent}.
          </p>
        )}

        {invites.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Pending invitations</p>
            <ul className="divide-y rounded-lg border text-sm">
              {invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <span className="min-w-0 truncate">{invite.email}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    expires <LocalizedDate value={invite.expiresAt} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
