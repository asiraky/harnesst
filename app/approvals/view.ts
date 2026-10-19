/**
 * What the approval card shows, shaped from a stored approval. Pure: the API returns this and
 * the card renders it, so the browser never sees raw ledger JSON it doesn't need.
 */
export interface ApprovalCardData {
  id: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "expired" | "superseded";
  approverRole: string | null;
  expiresAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  feedback: string | null;
  project: { name: string; repo: string | null } | null;
  /** The ledger stage the request was raised at, and where each decision sends the work. */
  stage: string | null;
  approveTo: string | null;
  rejectTo: string | null;
  headSha: string | null;
  problem: string | null;
  acceptanceCriteria: string[];
  links: Array<{ label: string; url: string }>;
  evidence: Array<{ type: string; summary: string | null; url: string | null }>;
  /** harnesst's merge of an approved merge gate; null when there's nothing to merge. */
  merge: {
    status: "pending" | "merged" | "failed";
    sha: string | null;
    error: string | null;
  } | null;
  canDecide: boolean;
}

type Row = {
  id: string;
  title: string;
  status: string;
  approverRole: string | null;
  expiresAt: Date | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  feedback: string | null;
  details: Record<string, unknown>;
  mergeStatus?: string | null;
  mergeSha?: string | null;
  mergeError?: string | null;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const httpUrl = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

const LINK_LABELS: Record<string, string> = {
  pr: "Pull request",
  preview_url: "Preview",
  deployment: "Deployment",
};

export function approvalCardData(row: Row, canDecide: boolean): ApprovalCardData {
  const input = obj(obj(row.details).input);
  const spec = obj(input.spec);
  const project = obj(row.details.project);
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts.map(obj) : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence.map(obj) : [];
  const status = (
    ["pending", "approved", "rejected", "expired", "superseded"].includes(row.status)
      ? row.status
      : "superseded"
  ) as ApprovalCardData["status"];
  return {
    id: row.id,
    title: row.title,
    status,
    approverRole: row.approverRole,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    feedback: row.feedback,
    project: str(project.name)
      ? { name: String(project.name), repo: str(project.repo) }
      : null,
    stage: str(input.stage),
    approveTo: str(input.approve_to),
    rejectTo: str(input.reject_to),
    headSha: str(input.head_sha),
    problem: str(spec.problem),
    acceptanceCriteria: Array.isArray(spec.acceptance_criteria)
      ? spec.acceptance_criteria.filter((c): c is string => typeof c === "string")
      : [],
    links: artifacts.flatMap((a) => {
      const url = httpUrl(a.value);
      const type = String(a.type ?? "");
      // Only links for the commit under approval: older previews describe other code.
      if (!url || !LINK_LABELS[type]) return [];
      if (type !== "pr" && str(a.head_sha) !== str(input.head_sha)) return [];
      return [{ label: LINK_LABELS[type], url }];
    }),
    evidence: evidence.map((e) => ({
      type: String(e.type ?? "evidence"),
      summary: str(e.summary) ?? str(e.notes) ?? str(e.detail),
      url: httpUrl(e.url),
    })),
    merge:
      row.mergeStatus === "pending" || row.mergeStatus === "merged" || row.mergeStatus === "failed"
        ? {
            status: row.mergeStatus,
            sha: row.mergeSha ?? null,
            error: row.mergeStatus === "merged" ? null : (row.mergeError ?? null),
          }
        : null,
    // Only an open request is decidable, whatever the viewer's access.
    canDecide: canDecide && status === "pending",
  };
}

/** `/approvals/<id>` on any origin: the ledger stores links on the public origin at the time. */
export function approvalIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, "http://local.invalid");
    const match = /^\/approvals\/([A-Za-z]{12})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
