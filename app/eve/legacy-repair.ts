/**
 * The "Repair generated files" planner (issue #235) — pure, so the whole decision is testable
 * against literals and the route stays a "gather → plan → stage" shell, exactly like the
 * marketplace install planner it sits beside.
 *
 * What it fixes: a managed agent repo scaffolded before the #213 rename still contains harnesst-
 * GENERATED code reading `EDEN_*` env names, while its instance container now only provides
 * `HARNESST_*`. Both halves of that contract have to agree, and only one half moved. The symptom is
 * silent — `process.env.EDEN_SANDBOX_ENV` is `undefined`, so the sandbox forwards no secrets at all
 * and the agent's bash sees an empty environment — and redeploying cannot fix it, because a
 * redeploy builds the image FROM these very files.
 *
 * The output is an ordinary change-set (writes + deletions) staged through the same review rails as
 * every other harnesst edit, so a human sees the diff before it reaches their repository.
 *
 * Scope discipline: only files harnesst itself generated are rewritten (see
 * `isMigratableGeneratedPath`), and the rewrite is the precise token table in `./legacy-names` —
 * never a brand word-sweep over someone else's code.
 */
import {
  findLegacyNames,
  isMigratableGeneratedPath,
  migrateLegacySource,
  renameLegacyPath,
} from "./legacy-names";

/** One file the repair would touch, as the confirmation dialog lists it. */
export interface LegacyRepairFile {
  path: string;
  /** Where the file moves to, when its NAME is legacy too (`eden-lock.json`); null = in place. */
  renamedTo: string | null;
  /** The distinct legacy tokens found in its content — empty for a pure rename. */
  tokens: string[];
}

export interface LegacyRepairPlan {
  /** Files to create/overwrite, at their POST-rename paths. */
  writes: Array<{ path: string; content: string }>;
  /** Legacy paths left behind by a rename, staged as deletions. */
  deletions: string[];
  /** Per-file detail for the UI; same order as `writes`. */
  files: LegacyRepairFile[];
}

/**
 * Which of `paths` the repair needs the CONTENT of. The caller fetches exactly these (a repo tree
 * read is cheap, a blob read per file is not), then hands them back to `planLegacyRepair`.
 *
 * A legacy-named file always qualifies — it has to be re-created under its new name, which needs
 * its bytes. Otherwise it is generated TypeScript under an agent root.
 */
export function legacyRepairCandidates(paths: string[]): string[] {
  return paths.filter(isMigratableGeneratedPath);
}

/**
 * Plan the repair from candidate file contents.
 *
 * `files` maps repo-relative path → current content (drafts already overlaid by the caller, so a
 * staged edit is what gets migrated — never the branch copy it supersedes). Paths whose content is
 * absent are skipped rather than guessed at.
 *
 * Content migration is applied to `.ts` only. A legacy-named JSON file (`eden-lock.json`,
 * `eden.json`) moves byte-for-byte: its `registry` locators can legitimately contain the string
 * "eden" (a catalog repo of that name), and nothing in it is part of the runtime env contract.
 */
export function planLegacyRepair(files: Record<string, string>): LegacyRepairPlan {
  const writes: LegacyRepairPlan["writes"] = [];
  const deletions: string[] = [];
  const detail: LegacyRepairFile[] = [];

  for (const path of Object.keys(files).sort()) {
    const content = files[path];
    if (typeof content !== "string") continue;
    const renamedTo = renameLegacyPath(path);
    const migrated = path.endsWith(".ts")
      ? migrateLegacySource(content)
      : content;
    const contentChanged = migrated !== content;
    if (!renamedTo && !contentChanged) continue;
    writes.push({ path: renamedTo ?? path, content: migrated });
    if (renamedTo) deletions.push(path);
    detail.push({
      path,
      renamedTo,
      tokens: contentChanged ? findLegacyNames(content) : [],
    });
  }

  return { writes, deletions, files: detail };
}

/**
 * Cheap loader-side drift check — is this repo carrying pre-rename generated code?
 *
 * Deliberately reads only what a page load already has: the repo's path listing plus the contents
 * `fetchAgentSource` fetches eagerly (every agent root's `agent.ts`). That is enough in practice,
 * because the two things a stale repo cannot avoid are exactly what this sees:
 *
 *  - a legacy-NAMED generated file (`eden-lock.json`, `eden.json`, `<root>/eden-model.ts`,
 *    `.eden/assistant/…`), visible in the path listing alone; and
 *  - a stale `agent.ts` — either `edenAgentModel(…)` imported from `./eden-model`, or the inline
 *    `EDEN_MODEL_DIRECTIVE_SECRET` helper block.
 *
 * A full scan (sandbox modules, installed tools, channels) costs one blob read per file and runs
 * only when the human asks for the repair. This is the trigger, not the inventory.
 */
export function detectsLegacyDrift(source: {
  paths: string[];
  files: Record<string, string>;
}): boolean {
  if (source.paths.some((path) => renameLegacyPath(path) !== null)) return true;
  return Object.entries(source.files).some(
    ([path, content]) =>
      path.endsWith(".ts") && migrateLegacySource(content) !== content,
  );
}
