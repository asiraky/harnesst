/**
 * Who made a gateway call, as the agent's generated model module labels it (issue #416).
 *
 * The generated `harnesst/model.ts` sends these headers on every Codex step. They are labels for
 * the call log only, never authority: the org comes from the gateway token, and a project id is
 * kept only once it is confirmed to belong to that org (`call-log.server.ts`). Values travel
 * URI-encoded so any agent name or path survives as a header value.
 */

export const CALL_IDENTITY_HEADERS = {
  agentName: "x-harnesst-agent",
  subagentPath: "x-harnesst-subagent",
  sessionId: "x-harnesst-session",
  turnId: "x-harnesst-turn",
  stepIndex: "x-harnesst-step",
  projectId: "x-harnesst-project",
} as const;

export interface CallIdentity {
  agentName: string | null;
  subagentPath: string | null;
  sessionId: string | null;
  turnId: string | null;
  stepIndex: number | null;
  /** Claimed by the caller; unverified until checked against the token's org. */
  projectId: string | null;
}

export const EMPTY_CALL_IDENTITY: CallIdentity = {
  agentName: null,
  subagentPath: null,
  sessionId: null,
  turnId: null,
  stepIndex: null,
  projectId: null,
};

const MAX_LABEL_LENGTH = 200;

function label(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  // Control characters have no business in a label and would garble any view that prints it.
  value = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) return null;
  return value.slice(0, MAX_LABEL_LENGTH);
}

export function parseCallIdentity(headers: Headers): CallIdentity {
  const step = label(headers, CALL_IDENTITY_HEADERS.stepIndex);
  const stepIndex = step !== null && /^\d{1,9}$/.test(step) ? Number(step) : null;
  const projectId = label(headers, CALL_IDENTITY_HEADERS.projectId);
  return {
    agentName: label(headers, CALL_IDENTITY_HEADERS.agentName),
    subagentPath: label(headers, CALL_IDENTITY_HEADERS.subagentPath),
    sessionId: label(headers, CALL_IDENTITY_HEADERS.sessionId),
    turnId: label(headers, CALL_IDENTITY_HEADERS.turnId),
    stepIndex,
    // Project ids are 12-letter nanoids; anything else cannot name a project and is dropped here.
    projectId: projectId && /^[A-Za-z0-9_-]{1,64}$/.test(projectId) ? projectId : null,
  };
}

/**
 * Keep the claimed project only when it belongs to the token's org. `lookup` answers whether
 * `projectId` exists in `orgId`; a failed lookup drops the project rather than trusting it.
 */
export async function verifiedProjectId(
  orgId: string,
  projectId: string | null,
  lookup: (orgId: string, projectId: string) => Promise<boolean>,
): Promise<string | null> {
  if (!projectId) return null;
  try {
    return (await lookup(orgId, projectId)) ? projectId : null;
  } catch {
    return null;
  }
}
