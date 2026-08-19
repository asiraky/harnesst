/**
 * FOH → BOH cross-links (issue #246): href builders for the subtle "manage this" affordances.
 * Pure so the single-agent collapse rule is testable without route loaders: BOH member pages
 * key on agent NAME, and a single-agent repo (the repo IS the agent, M5.8) has no member page
 * at all — its agent link must land on the repo-level page.
 */
import type { Project } from "~/data/ports";

/** The team's BOH landing — the Agents page / agent list. */
export function bohTeamHref(projectId: string): string {
  return `/repos/${projectId}`;
}

/** One member's BOH config surface; collapses to the repo level for single-agent repos. */
export function bohAgentHref(
  project: Pick<Project, "id" | "layout"> & Partial<Pick<Project, "slug">>,
  agentName: string,
): string {
  const projectPath = project.slug ?? project.id;
  if (project.layout !== "team") return bohTeamHref(projectPath);
  return `/repos/${projectPath}/agents/${encodeURIComponent(agentName)}`;
}
