import { useMatch } from "react-router";

/** The FOH conversation on screen, from anywhere in the shell — null off a session route. */
export function useOpenSessionId(): string | null {
  return (
    useMatch("/t/:projectId/:agentId/s/:sessionId")?.params.sessionId ?? null
  );
}
