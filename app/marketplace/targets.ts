/**
 * Install targets, shared by the install wizard and the in-place "Add from marketplace" dialog on
 * the agent and team pages. The wizard's `?member=` param is the one wire format for a target:
 * a roster member's name, or `<member>:<subagent/path>` for one of its declared subagents. The
 * dialog builds wizard links in that format so the user lands with the target already chosen.
 */
import { subagentDirNames, subagentRootFor } from "~/eve/parse";
import {
  installedKeys,
  type CatalogProviderEvidence,
  type HarnesstLock,
} from "~/marketplace/lock";
import type { TemplateType } from "~/marketplace/manifest";

/**
 * Separator between a member name and its `/`-joined subagent path in a picker option's value and
 * in the `?member=` param. Both halves are eve directory names (kebab-case), so `:` can occur in
 * neither — the value round-trips unambiguously in both directions.
 */
export const SUBAGENT_SEPARATOR = ":";

/** Encode a member (and optional declared-subagent path) as a `?member=` value. */
export function encodeMemberSelection(
  memberName: string,
  subagentPath = "",
): string {
  return subagentPath
    ? `${memberName}${SUBAGENT_SEPARATOR}${subagentPath}`
    : memberName;
}

/** Split a picker value / `?member=` param into a member name and `/`-joined subagent path. */
export function decodeMemberSelection(value: string): {
  memberName: string;
  subagentPath: string;
} {
  const at = value.indexOf(SUBAGENT_SEPARATOR);
  if (at < 0) return { memberName: value, subagentPath: "" };
  return {
    memberName: value.slice(0, at),
    subagentPath: value.slice(at + SUBAGENT_SEPARATOR.length),
  };
}

/**
 * Every declared subagent below `memberRoot` as a `/`-joined path, parents before children.
 * `subagentDirNames` reads ONE level of `<root>/subagents/`, so recurse it with each child's own
 * root: a declared subagent is itself a full agent root and may declare subagents of its own.
 */
export function declaredSubagentPaths(
  repoPaths: string[],
  memberRoot: string,
  prefix = "",
): string[] {
  const base = subagentRootFor(memberRoot, prefix.split("/").filter(Boolean));
  return subagentDirNames(repoPaths, base).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    return [path, ...declaredSubagentPaths(repoPaths, memberRoot, path)];
  });
}

/**
 * The `type/id` keys installed at ONE target — a member, or one of its declared subagents. The
 * lock records a single-agent repo's root agent as `member: null`, so pass `null` there. Includes
 * a bundle materialized at the same target, exactly as the marketplace's "Installed" facet does.
 */
export function installedKeysAtTarget(
  lock: HarnesstLock,
  member: string | null,
  subagentPath: string,
  catalogProviders: readonly CatalogProviderEvidence[] = [],
): string[] {
  const installs = lock.installs.filter(
    (entry) =>
      entry.member === member && (entry.subagent ?? "") === subagentPath,
  );
  return [...new Set(installedKeys({ ...lock, installs }, catalogProviders))];
}

/**
 * The install wizard URL with its target preselected. `member` is a `?member=` value (see
 * `encodeMemberSelection`); omit it for an agent template, which names its new member in the
 * wizard. `returnTo` is where the wizard's back link goes.
 */
export function installWizardHref(input: {
  type: TemplateType;
  id: string;
  projectId: string;
  member?: string | null;
  returnTo?: string | null;
}): string {
  const params = new URLSearchParams({ project: input.projectId });
  if (input.member) params.set("member", input.member);
  if (input.returnTo) params.set("returnTo", input.returnTo);
  return `/marketplace/${input.type}/${encodeURIComponent(input.id)}/install?${params.toString()}`;
}

/** One catalog row as the dialog filters it. */
export interface PickableTemplate {
  id: string;
  type: TemplateType;
  name: string;
  description: string;
}

/**
 * The dialog's list: templates of the allowed types whose name, id or description contains every
 * whitespace-separated word of the query (case-insensitive). `type` narrows to one kind; "all"
 * keeps every allowed one.
 */
export function filterTemplates<T extends PickableTemplate>(
  templates: readonly T[],
  opts: {
    query: string;
    type: TemplateType | "all";
    allowedTypes: readonly TemplateType[];
  },
): T[] {
  const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  return templates.filter((t) => {
    if (!opts.allowedTypes.includes(t.type)) return false;
    if (opts.type !== "all" && t.type !== opts.type) return false;
    const haystack = `${t.name} ${t.id} ${t.description}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
