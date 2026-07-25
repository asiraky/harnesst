/**
 * Editor banner for a file's save state (shared by all editors).
 *
 * Editors always show the user's LATEST intended value — a saved draft when one exists, else
 * the repository content. This banner says WHICH of those the form is showing, so "why does
 * this show X?" is always answerable on the page itself. The link opens the publish panel
 * (the header Publish control reads `?publish=1`).
 */
import { PencilLine, Trash2 } from "lucide-react";
import { Link } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import type { FileView } from "~/drafts/drafts.server";

export function FileStateBanner({
  saved,
  source,
  stagedDeletion = false,
}: {
  /** The just-submitted save succeeded (actionData.ok) — show the saved state. */
  saved: boolean;
  source: FileView["source"];
  /** A deletion is saved for this file (the form shows the repo content). */
  stagedDeletion?: boolean;
}) {
  if (stagedDeletion && !saved) {
    return (
      <Alert className="mb-6 border-amber-500/40">
        <AlertTitle className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <Trash2 className="size-4" aria-hidden />
          Will be deleted when you publish
        </AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            This file is saved for deletion; the form shows the repository
            content. Saving here replaces the deletion with an edit.
          </span>
          <Link
            to="?publish=1"
            className="font-medium underline underline-offset-4"
          >
            Review &amp; publish →
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  if (saved || source === "draft") {
    return (
      <Alert className="mb-6 border-amber-500/40">
        <AlertTitle className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
          <PencilLine className="size-4" aria-hidden />
          Saved — not published yet
        </AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>This file has an unpublished save; the form shows it.</span>
          <Link
            to="?publish=1"
            className="font-medium underline underline-offset-4"
          >
            Review &amp; publish →
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
