import type { Project } from "~/data/ports";
import { cleanInferredTitle, titleFromMessage } from "~/foh/session-title";
import { getInstallationOctokit } from "~/github/client.server";

export { titleFromMessage } from "~/foh/session-title";

export interface GitHubIssueReference {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

const GITHUB_ISSUE_URL =
  /https?:\/\/(?:www\.)?github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/([1-9][0-9]*)(?:[^\s<]*)?/i;

export function githubIssueFromMessage(
  message: string,
): GitHubIssueReference | null {
  const match = GITHUB_ISSUE_URL.exec(message);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return {
    owner: match[1],
    repo: match[2],
    number,
    url: match[0],
  };
}

type IssueTitleReader = (input: {
  installationId: string;
  owner: string;
  repo: string;
  number: number;
}) => Promise<string | null>;

async function readIssueTitle(input: {
  installationId: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<string | null> {
  const octokit = await getInstallationOctokit(input.installationId);
  const issue = await octokit.rest.issues.get({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.number,
    request: { signal: AbortSignal.timeout(2_000) },
  });
  return issue.data.title ?? null;
}

function unresolvedIssueTitle(
  message: string,
  issue: GitHubIssueReference,
): string {
  const context = cleanInferredTitle(message.replace(issue.url, " "));
  const isOnlyRequestBoilerplate =
    /^(?:(?:can|could|would|will) you(?: please)?|please)?\s*(?:(?:work on|handle|implement|fix|address|look at|take a look at)\s*)?(?:(?:this|the)\s*)?(?:github\s+)?(?:issue|ticket)?\s*[:;,.-]*$/i.test(
      context,
    );
  return context && !isOnlyRequestBoilerplate
    ? titleFromMessage(context)
    : `${issue.owner}/${issue.repo} #${issue.number}`;
}

/**
 * Infer a FOH list title. GitHub lookup is restricted to the repository this project represents:
 * an installation grant can cover several private repositories, and a member who can access one
 * harnesst project must not use its title endpoint to probe the others.
 */
export async function inferFohSessionTitle(
  input: {
    message: string;
    project: Pick<Project, "repoOwner" | "repoName" | "repoInstallationId">;
  },
  deps: { readIssueTitle: IssueTitleReader } = { readIssueTitle },
): Promise<string> {
  const issue = githubIssueFromMessage(input.message);
  if (!issue) return titleFromMessage(input.message);

  const sameRepository =
    input.project.repoOwner?.toLowerCase() === issue.owner.toLowerCase() &&
    input.project.repoName?.toLowerCase() === issue.repo.toLowerCase();
  if (!sameRepository || !input.project.repoInstallationId) {
    return unresolvedIssueTitle(input.message, issue);
  }

  try {
    const title = await deps.readIssueTitle({
      installationId: input.project.repoInstallationId,
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
    });
    const cleaned = title ? cleanInferredTitle(title) : "";
    return cleaned || unresolvedIssueTitle(input.message, issue);
  } catch {
    // Title inference must never prevent the actual turn from starting. A revoked installation,
    // deleted issue, or transient GitHub outage falls back to a compact local label.
    return unresolvedIssueTitle(input.message, issue);
  }
}
