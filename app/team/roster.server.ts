/**
 * Teammate roster env (Team delegation — D3). Builds the `HARNESST_TEAMMATES` payload the controller
 * injects for a team member: every OTHER roster member's name plus a short role blurb (the first
 * real paragraph of that member's `instructions.md`). Discovery only — permissions are enforced
 * live at the relay, so this list is never filtered by who-can-ask-whom.
 *
 * Source comes from the same cached GitHub read loaders use (`getAgentSource`, which eagerly
 * loads every member's instructions.md). A description read must NEVER fail a deploy: any error
 * degrades to names with empty roles.
 */
import type { Agent } from "~/data/ports";
import { getAgentSource } from "~/github/cached.server";

export interface Teammate {
  name: string;
  role: string;
}

/**
 * The first non-heading paragraph of a markdown doc, whitespace-collapsed and capped. Skips a
 * leading YAML frontmatter block and any leading headings/blank lines. Pure (unit-tested).
 */
export function firstParagraph(
  markdown: string | undefined | null,
  cap = 200,
): string {
  if (!markdown) return "";
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++; // step past the closing fence
  }
  const para: string[] = [];
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (para.length === 0) {
      if (!trimmed || trimmed.startsWith("#")) continue;
      para.push(trimmed);
    } else {
      if (!trimmed || trimmed.startsWith("#")) break;
      para.push(trimmed);
    }
  }
  const text = para.join(" ").replace(/\s+/g, " ").trim();
  return text.length > cap ? `${text.slice(0, cap - 1).trimEnd()}…` : text;
}

/**
 * The `HARNESST_TEAMMATES` roster for one member: every other member with its role blurb. Returns an
 * empty array for a team of one. Never throws — a failed source read yields empty roles.
 */
export async function teammateRoster(input: {
  project: {
    repoOwner: string;
    repoName: string;
    repoInstallationId: string;
  };
  roster: Agent[];
  selfAgentId: string;
}): Promise<Teammate[]> {
  // Teammates are real roster members only — never the built-in assistant (kind !== 'member').
  const others = input.roster.filter(
    (a) => a.id !== input.selfAgentId && a.kind === "member",
  );
  if (others.length === 0) return [];
  let files: Record<string, string> = {};
  try {
    const source = await getAgentSource(input.project.repoInstallationId, {
      owner: input.project.repoOwner,
      repo: input.project.repoName,
    });
    files = source.files;
  } catch (error) {
    console.warn("[team] roster description read failed:", error);
  }
  return others.map((a) => ({
    name: a.name,
    role: firstParagraph(files[`${a.root}/instructions.md`]),
  }));
}
