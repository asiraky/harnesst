/**
 * Loads usage warnings (issue #419) for one scope: the runs of some repositories (optionally one
 * agent or one run), plus connection warnings for workspace admins. Callers pass repository ids
 * they have already authorised and decide whether the viewer is an admin.
 */
import { planWindowLabel } from "./format";
import {
  agentNames,
  connectionTotals,
  latestHeadroom,
  listConnections,
  stepEvidence,
  warningSignals,
} from "./queries.server";
import {
  connectionOccurrences,
  describeWarning,
  groupWarnings,
  runOccurrences,
  warningLink,
  type ConnectionSignal,
  type Occurrence,
  type Warning,
  type WarningText,
} from "./warnings";

export interface ShownWarning extends Warning, WarningText {
  link: string | null;
  agentName: string | null;
  projectName: string | null;
  connectionLabel: string | null;
}

export async function loadWarnings(input: {
  orgId: string;
  projects: { id: string; name: string }[];
  since: Date;
  agentId?: string;
  runId?: string;
  /** Connection warnings: admins only; `true` for all, or one connection id. */
  connections?: true | string | false;
  /** Replaces the ingest-time repeats, e.g. with ones the run trace computed for old runs. */
  overrideOccurrences?: (occ: Occurrence[]) => Occurrence[];
}): Promise<ShownWarning[]> {
  const ids = input.projects.map((p) => p.id);
  const wantConnections = input.connections !== false && input.connections != null;
  const [signals, names, conns, headroom, totals] = await Promise.all([
    warningSignals({ projectIds: ids, since: input.since, agentId: input.agentId, runId: input.runId }),
    agentNames(ids),
    wantConnections ? listConnections(input.orgId) : Promise.resolve([]),
    wantConnections ? latestHeadroom(input.orgId) : Promise.resolve(new Map()),
    wantConnections ? connectionTotals(input.orgId, input.since) : Promise.resolve([]),
  ]);

  const connSignals: ConnectionSignal[] = conns
    .filter((c) => input.connections === true || c.id === input.connections)
    .filter((c) => c.provider === "codex")
    .map((c) => {
      const t = totals.find((x) => x.connectionId === c.id);
      const h = headroom.get(c.id);
      return {
        connectionId: c.id,
        calls: t?.calls ?? 0,
        input: t?.input ?? null,
        cached: t?.cached ?? null,
        rateLimited: t?.rateLimited ?? 0,
        lastAt: t?.lastAt ?? null,
        lastRateLimitedAt: t?.lastRateLimitedAt ?? null,
        windows: h
          ? [
              { label: planWindowLabel(h.primaryWindowMinutes ?? 300), pct: h.primaryUsedPercent, resetsAt: h.primaryResetsAt, observedAt: h.observedAt },
              { label: planWindowLabel(h.secondaryWindowMinutes ?? 10080), pct: h.secondaryUsedPercent, resetsAt: h.secondaryResetsAt, observedAt: h.observedAt },
            ]
          : [],
      };
    });

  let occurrences = [...runOccurrences(signals.runs, signals.steps), ...connectionOccurrences(connSignals)];
  if (input.overrideOccurrences) occurrences = input.overrideOccurrences(occurrences);
  const warnings = groupWarnings(occurrences);

  // Evidence (input and error excerpts, the call that made the step) for each worst case only.
  const evidence = await stepEvidence(
    warnings
      .filter((w) => w.worst.runId && w.worst.stepSeq != null)
      .map((w) => ({ runId: w.worst.runId!, seq: w.worst.stepSeq! })),
  );
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const connLabel = new Map(conns.map((c) => [c.id, c.label]));

  return warnings.map((w) => {
    const ev = w.worst.runId && w.worst.stepSeq != null ? evidence.get(`${w.worst.runId}:${w.worst.stepSeq}`) : undefined;
    const worst: Occurrence = ev
      ? {
          ...w.worst,
          callSeq: w.worst.callSeq ?? ev.callSeq,
          evidence: {
            ...w.worst.evidence,
            inputPreview: w.worst.evidence.inputPreview ?? ev.inputPreview,
            message: w.rule === "tool_error" ? ev.message : w.worst.evidence.message,
          },
        }
      : w.worst;
    const full: Warning = { ...w, worst };
    const n = {
      agentName: w.agentId ? (names.get(w.agentId)?.name ?? null) : null,
      projectName: w.projectId ? (projectName.get(w.projectId) ?? null) : null,
      connectionLabel: w.connectionId ? (connLabel.get(w.connectionId) ?? null) : null,
    };
    return { ...full, ...describeWarning(full, n), ...n, link: warningLink(full) };
  });
}
