import type { PlaygroundSession } from "~/playground/sessions.server";

/**
 * Stable filesystem identity for one FOH conversation.
 *
 * Human-opened conversations use the harnesst row id. A channel-homed conversation already owns a
 * sandbox before harnesst adopts it, so its predecessor Eve id is the only identity that can
 * reattach that existing tree when the conversation succeeds onto harnesst's private HTTP channel.
 * `predecessorExternalSessionId` preserves that anchor after the row is rebound.
 */
export function fohWorkspaceId(
  session: Pick<
    PlaygroundSession,
    "id" | "externalSessionId" | "predecessorExternalSessionId" | "resumeVia"
  >,
): string {
  return (
    session.predecessorExternalSessionId ??
    (session.resumeVia ? session.externalSessionId : null) ??
    session.id
  );
}

/**
 * The Eve session label on the sandbox that physically holds this conversation's files. A
 * harnesst-channel successor reuses the predecessor's sandbox container, whose original label does
 * not change; ordinary conversations use the current Eve session label.
 */
export function fohArtifactSandboxSessionId(
  session: Pick<
    PlaygroundSession,
    "externalSessionId" | "predecessorExternalSessionId"
  >,
): string | null {
  return (
    session.predecessorExternalSessionId ?? session.externalSessionId ?? null
  );
}
