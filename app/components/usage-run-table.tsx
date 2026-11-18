/** The runs table shared by the usage overview, repository and agent pages (issue #418). */
import { Link } from "react-router";

import { LocalizedDateTime } from "~/components/localized-values";
import { CtxBar, NotAvailable, Pct, RunStatus, Tokens, usageHref } from "~/components/usage";
import { ratio, runLabel, type WindowDays } from "~/usage/format";

export interface RunTableRow {
  id: string;
  projectId: string;
  externalRunId: string | null;
  status: string;
  settledBy: string | null;
  startedAt: string;
  agentName?: string | null;
  projectName?: string;
  calls: number;
  input: number | null;
  cached: number | null;
  peakContext: number | null;
  window: number | null;
  compactions: number | null;
  compactionsRequested: number;
  toolErrors: number;
}

export function RunTable({
  runs,
  days,
  showRepo,
}: {
  runs: RunTableRow[];
  days: WindowDays;
  showRepo?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="py-2 pr-3 font-medium">Run</th>
            {showRepo && <th className="py-2 pr-3 font-medium">Repository · agent</th>}
            <th className="py-2 pr-3 font-medium">Started</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 text-right font-medium">Calls</th>
            <th className="py-2 pr-3 text-right font-medium">Input</th>
            <th className="py-2 pr-3 text-right font-medium">Cache hit</th>
            <th className="py-2 pr-3 font-medium">Peak context</th>
            <th className="py-2 pr-3 text-right font-medium">Compactions</th>
            <th className="py-2 text-right font-medium">Tool errors</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              <td className="py-2 pr-3">
                <Link to={usageHref(`/usage/repos/${r.projectId}/runs/${r.id}`, days)} className="font-mono text-xs hover:underline">
                  {runLabel(r)}
                </Link>
              </td>
              {showRepo && (
                <td className="py-2 pr-3 text-xs">
                  {r.projectName}
                  {r.agentName && <span className="text-muted-foreground"> · {r.agentName}</span>}
                </td>
              )}
              <td className="py-2 pr-3 text-xs text-muted-foreground">
                <LocalizedDateTime value={r.startedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "numeric" }} />
              </td>
              <td className="py-2 pr-3"><RunStatus status={r.status} settledBy={r.settledBy} /></td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.calls}</td>
              <td className="py-2 pr-3 text-right tabular-nums"><Tokens value={r.input} short /></td>
              <td className="py-2 pr-3 text-right tabular-nums"><Pct value={ratio(r.cached, r.cached == null ? null : r.input)} short /></td>
              <td className="py-2 pr-3">{r.peakContext == null ? <NotAvailable short /> : <CtxBar value={r.peakContext} window={r.window} />}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {r.compactions ?? (r.compactionsRequested ? r.compactionsRequested : <NotAvailable short />)}
                {r.compactions != null && r.compactionsRequested > r.compactions && (
                  <span className="text-xs text-muted-foreground"> /{r.compactionsRequested}</span>
                )}
              </td>
              <td className={`py-2 text-right tabular-nums ${r.toolErrors ? "text-red-600" : ""}`}>{r.toolErrors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
