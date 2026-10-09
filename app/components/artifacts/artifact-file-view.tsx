import { useMemo, type ReactNode } from "react";

import type { ChatArtifact } from "~/chat/types";
import { MarkdownText } from "~/components/chat";
import { artifactRawUrl, artifactSourceUrl } from "~/foh/artifact-media";
import {
  artifactReadsText,
  type ArtifactViewMode,
} from "~/foh/artifact-viewer";
import { delimiterFor } from "~/lib/csv";
import { artifactBadge } from "./artifact-type";
import { CodeView } from "./code-view";
import { CsvView } from "./csv-view";
import { FallbackView } from "./file-card";
import { HtmlSourceView } from "./html-source-view";
import { ImageView, MediaView, PdfView } from "./media-views";
import { CUT_NOTICE, Failure, Loading, Notice } from "./states";
import { useArtifactText, type ArtifactText } from "./use-artifact-text";

export interface ArtifactFileViewProps {
  artifact: ChatArtifact;
  projectId: string;
  /** The version on screen; null means the newest. */
  versionId: string | null;
  mode: ArtifactViewMode;
}

/**
 * The panel body for everything except a page's live preview: every non-HTML viewer in either mode,
 * and an HTML page's source.
 *
 * It does NOT scroll itself: the parent supplies the one scroll box (bounded height, `overflow:
 * auto` both ways), and this fills its height. That keeps a single scroller for the panel's
 * preview/source scroll restore, and it is the box every viewer leans on — the code toolbar, the
 * table header and line-number gutter stick to it, the image zoom scrolls it, and the PDF frame
 * and video player take its full height.
 *
 * Every URL is pinned to a version when one is known — the panel's pick, else the card's latest —
 * so the browser's immutable caching and the text cache both hold, and a republish shows up as a
 * new URL rather than a stale one.
 */
export function ArtifactFileView({
  artifact,
  projectId,
  versionId,
  mode,
}: ArtifactFileViewProps) {
  const pinned = versionId ?? artifact.latestVersionId;
  const viewer = artifact.viewer;
  const readsText = artifactReadsText(viewer, mode);
  const bundleSource = viewer === "html";
  // A single file's one member is its own name (the source endpoint refuses any other path).
  const text = useArtifactText(
    readsText && !bundleSource
      ? artifactSourceUrl(projectId, artifact.id, pinned, artifact.name)
      : null,
    pinned !== null,
  );
  const rawUrl = artifactRawUrl(projectId, artifact.id, pinned);
  const downloadUrl = artifactRawUrl(projectId, artifact.id, pinned, {
    download: true,
  });
  const badge = useMemo(() => artifactBadge(artifact), [artifact]);
  const title = artifact.title?.trim() || artifact.name;

  let body: ReactNode;
  if (bundleSource) {
    body = (
      <HtmlSourceView
        projectId={projectId}
        artifactId={artifact.id}
        versionId={pinned}
      />
    );
  } else if (readsText) {
    body =
      text.status === "ready" ? (
        <TextViewer
          artifact={artifact}
          mode={mode}
          read={text.value}
        />
      ) : text.status === "error" ? (
        <Failure message={text.error} onRetry={text.retry} />
      ) : (
        <Loading />
      );
  } else if (viewer === "image" || viewer === "svg") {
    // Keyed by URL so zoom and the load state start over for another version.
    body = <ImageView key={rawUrl} src={rawUrl} name={title} />;
  } else if (viewer === "audio" || viewer === "video") {
    body = (
      <MediaView
        key={rawUrl}
        src={rawUrl}
        kind={viewer}
        name={artifact.name}
        downloadUrl={downloadUrl}
      />
    );
  } else if (viewer === "pdf") {
    body = (
      <PdfView
        src={rawUrl}
        downloadUrl={downloadUrl}
        name={artifact.name}
        title={title}
        byteSize={artifact.byteSize}
        contentType={artifact.contentType}
        badge={badge}
      />
    );
  } else {
    body = (
      <FallbackView
        badge={badge}
        name={artifact.name}
        contentType={artifact.contentType}
        byteSize={artifact.byteSize}
        rawUrl={rawUrl}
        downloadUrl={downloadUrl}
      />
    );
  }

  return <div className="h-full w-full min-w-0">{body}</div>;
}

/** The viewers that render text they read: markdown, tables, JSON, and plain code in source mode. */
function TextViewer({
  artifact,
  mode,
  read,
}: {
  artifact: ChatArtifact;
  mode: ArtifactViewMode;
  read: ArtifactText;
}) {
  const { viewer, name, contentType } = artifact;
  const { text, truncated } = read;
  if (mode === "preview" && viewer === "markdown") {
    return (
      <div>
        <div className="mx-auto max-w-3xl px-6 py-5 text-sm">
          <MarkdownText text={text} />
        </div>
        {truncated && <Notice>{CUT_NOTICE}</Notice>}
      </div>
    );
  }
  if (mode === "preview" && viewer === "csv") {
    return (
      <CsvView
        text={text}
        delimiter={delimiterFor(name, contentType)}
        truncated={truncated}
      />
    );
  }
  if (mode === "preview" && viewer === "json") {
    return <JsonPreview text={text} name={name} truncated={truncated} />;
  }
  return (
    <CodeView
      text={text}
      name={name}
      contentType={contentType}
      truncated={truncated}
    />
  );
}

/** Pretty-printed, or the text as written with the reason when it won't parse. */
function JsonPreview({
  text,
  name,
  truncated,
}: {
  text: string;
  name: string;
  truncated: boolean;
}) {
  const pretty = useMemo(() => prettyJson(text), [text]);
  if (pretty.ok) {
    return (
      <CodeView text={pretty.text} name={name} language="json" truncated={truncated} />
    );
  }
  return (
    <div>
      <p className="border-b border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        {truncated
          ? "The file was cut at 1 MB, so it can't be formatted. Shown as written."
          : `Not valid JSON (${pretty.error}). Shown as written.`}
      </p>
      <CodeView text={text} name={name} language="json" truncated={truncated} />
    </div>
  );
}

/** JSON re-indented two spaces, or why it is not JSON. */
export function prettyJson(
  text: string,
): { ok: true; text: string } | { ok: false; error: string } {
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
