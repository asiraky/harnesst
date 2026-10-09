/**
 * How a FOH conversation tells the agent shell around it that the artifact panel is open, so the
 * shell can fold its session list away at xl and give the panel the room. Passed down as the
 * shell's `<Outlet context>`; a route rendered without it (a test, another layout) gets a no-op.
 */
import { useOutletContext } from "react-router";

export interface ArtifactPanelOutletContext {
  setArtifactPanelOpen: (open: boolean) => void;
}

const NO_SHELL: ArtifactPanelOutletContext = {
  setArtifactPanelOpen: () => {},
};

export function useArtifactPanelOutlet(): ArtifactPanelOutletContext {
  const context = useOutletContext<
    Partial<ArtifactPanelOutletContext> | undefined
  >();
  return context?.setArtifactPanelOpen
    ? (context as ArtifactPanelOutletContext)
    : NO_SHELL;
}
