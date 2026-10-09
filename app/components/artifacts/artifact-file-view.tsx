import type { ChatArtifact } from "~/chat/types";
import type { ArtifactViewMode } from "~/foh/artifact-viewer";

export interface ArtifactFileViewProps {
  artifact: ChatArtifact;
  projectId: string;
  /** The version on screen; null means the newest. */
  versionId: string | null;
  mode: ArtifactViewMode;
}

/**
 * The panel body for everything except a page's live preview: every non-HTML viewer in either mode,
 * and an HTML page's source. Placeholder until the viewers land.
 */
export function ArtifactFileView(_props: ArtifactFileViewProps) {
  return null;
}
