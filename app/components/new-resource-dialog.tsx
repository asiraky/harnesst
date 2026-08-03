/**
 * "New tool / skill / …" — the create flow from the Overview cards. Asks for just a name,
 * derives the file path (agent/<category>/<slug>.<ext>), and opens the editor, which starts
 * from that category's starter template. Nothing is staged until the user saves.
 *
 * SUBAGENTS are the exception (issue #344): a subagent is a directory that is its own agent
 * root, not a single file, so there is nothing sensible to open in the file editor. That name
 * is posted to the category route's `create-subagent` intent, which saves the whole scaffold
 * and lands on the new subagent's own configuration surface.
 */
import { useState } from "react";
import { useNavigate, useSubmit } from "react-router";

import { categoryMeta } from "~/components/resource-category";
import { accentChip } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  resourcePath,
  slugifyResourceName,
  type ResourceKind,
} from "~/eve/templates";
import { cn } from "~/lib/utils";

export function NewResourceDialog({
  kind,
  base,
  root = "agent",
}: {
  kind: ResourceKind;
  /** Repository base path, e.g. /repos/:id */
  base: string;
  /** Active agent root ("agent" or "agents/<member>/agent") the file is created under. */
  root?: string;
}) {
  const navigate = useNavigate();
  const submit = useSubmit();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const slug = slugifyResourceName(name);
  const meta = categoryMeta(kind.key);
  const Icon = meta.icon;
  // What the dialog promises to create — a directory for a subagent, a file for everything else.
  const creates =
    kind.key === "subagents"
      ? `${root}/subagents/${slug}/`
      : resourcePath(kind, slug, root);

  const create = () => {
    if (!slug) return;
    setOpen(false);
    setName("");
    if (kind.key === "subagents") {
      submit(
        { intent: "create-subagent", name: slug },
        { method: "post", action: `${base}/resources/subagents` },
      );
      return;
    }
    navigate(`${base}/edit?path=${encodeURIComponent(resourcePath(kind, slug, root))}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          New
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-lg",
                accentChip[meta.accent],
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            New {kind.label}
          </DialogTitle>
          <DialogDescription>{kind.hint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`new-${kind.key}-name`}>Name</Label>
          <Input
            id={`new-${kind.key}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder={`My ${kind.label}`}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {slug ? (
              <>
                Creates <span className="font-mono">{creates}</span>
              </>
            ) : kind.key === "subagents" ? (
              "Names become kebab-case directory names."
            ) : (
              "Names become kebab-case file names."
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!slug}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
