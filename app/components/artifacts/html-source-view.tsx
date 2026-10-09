import { useState } from "react";

import { formatBytes } from "~/components/chat/composer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { artifactSourceUrl } from "~/foh/artifact-media";
import { artifactMemberIsText } from "./artifact-type";
import { CodeView } from "./code-view";
import { Failure, Loading } from "./states";
import { useArtifactListing, useArtifactText } from "./use-artifact-text";

/**
 * A page bundle's source: its file list as a picker (opening on the entry document), and the chosen
 * member's text. A bundle can carry its CSS, JS and images beside `index.html`; the text ones are
 * readable here, the binary ones say so instead of showing their bytes as text.
 */
export function HtmlSourceView({
  projectId,
  artifactId,
  versionId,
}: {
  projectId: string;
  artifactId: string;
  /** Pinned version, or null for the newest (not cached — it can change under us). */
  versionId: string | null;
}) {
  const listing = useArtifactListing(
    artifactSourceUrl(projectId, artifactId, versionId),
    versionId !== null,
  );
  // The pick belongs to one listing: a version switch starts again from that version's entry.
  const [picked, setPicked] = useState<{ versionId: string; path: string } | null>(
    null,
  );

  const files = listing.status === "ready" ? listing.value.files : [];
  const listedVersion =
    listing.status === "ready" ? listing.value.versionId : null;
  const path =
    picked && picked.versionId === listedVersion && files.some((f) => f.path === picked.path)
      ? picked.path
      : listing.status === "ready"
        ? listing.value.entry || files[0]?.path || null
        : null;
  const file = files.find((f) => f.path === path) ?? null;
  const readable = file ? artifactMemberIsText(file.path, file.contentType) : false;
  // The listing names the version it resolved, so member reads are pinned (and cacheable) even when
  // the panel asked for "newest".
  const text = useArtifactText(
    listedVersion && file && readable
      ? artifactSourceUrl(projectId, artifactId, listedVersion, file.path)
      : null,
    true,
  );

  if (listing.status === "error") {
    return <Failure message={listing.error} onRetry={listing.retry} />;
  }
  if (listing.status !== "ready") return <Loading label="Loading files…" />;
  if (!file) return <Failure message="This page has no files to show." />;

  const picker =
    files.length > 1 ? (
      <Select
        value={file.path}
        onValueChange={(next) =>
          listedVersion && setPicked({ versionId: listedVersion, path: next })
        }
      >
        <SelectTrigger
          size="sm"
          aria-label="File"
          className="max-w-[60%] min-w-0 font-mono text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {files.map((f) => (
            <SelectItem key={f.path} value={f.path} className="font-mono text-xs">
              {f.path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  if (readable && text.status === "ready") {
    return (
      // Keyed by file so the wrap choice and highlighting start fresh per member.
      <CodeView
        key={file.path}
        text={text.value.text}
        name={file.path}
        contentType={file.contentType}
        truncated={text.value.truncated}
        leading={picker}
        label={picker ? undefined : file.path}
      />
    );
  }
  return (
    <div className="flex min-h-full flex-col">
      {picker && (
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-1">
          {picker}
        </div>
      )}
      {!readable ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          {file.path} isn't text ({file.contentType}, {formatBytes(file.byteSize)}), so
          there's no source to show.
        </p>
      ) : text.status === "error" ? (
        <Failure message={text.error} onRetry={text.retry} />
      ) : (
        <Loading />
      )}
    </div>
  );
}
