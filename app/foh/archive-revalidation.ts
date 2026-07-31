import type { ShouldRevalidateFunctionArgs } from "react-router";

type ArchiveActionResult = {
  ok?: unknown;
  intent?: unknown;
  sessionId?: unknown;
};

/**
 * A successful archive makes the archived session's loader unresolvable. When that session is
 * still the open child route, let the parent consume the fetcher result and navigate back to its
 * index before React Router tries to revalidate the now-invalid child.
 */
export function archivedOpenSessionShouldRevalidate({
  actionResult,
  currentParams,
  defaultShouldRevalidate,
  formAction,
}: ShouldRevalidateFunctionArgs): boolean {
  const result =
    actionResult && typeof actionResult === "object"
      ? (actionResult as ArchiveActionResult)
      : null;
  const projectId = currentParams.projectId;
  const sessionId = currentParams.sessionId;

  if (
    projectId &&
    sessionId &&
    formAction === `/api/foh/${projectId}/archive` &&
    result?.ok === true &&
    result.intent === "archive" &&
    result.sessionId === sessionId
  ) {
    return false;
  }

  return defaultShouldRevalidate;
}
