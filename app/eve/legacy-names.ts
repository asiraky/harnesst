/**
 * The `eden` → `harnesst` migration for GENERATED code living in managed agent repos (issue #235).
 *
 * The #213 rename (PR #230) moved the control plane's half of the runtime contract —
 * `EDEN_SANDBOX_ENV` → `HARNESST_SANDBOX_ENV`, `EDEN_TEAM_TOKEN` → `HARNESST_TEAM_TOKEN`, and the
 * rest — but the other half lives in files harnesst WROTE INTO the customer's repo at scaffold /
 * install time and never regenerates. Every agent repo created before 2026-07-26 therefore still
 * reads the old names while its instance container only provides the new ones, which fails
 * silently: `process.env.EDEN_SANDBOX_ENV` is simply `undefined`, so the sandbox forwards nothing
 * and the agent's shell loses every exposed secret.
 *
 * Redeploying cannot fix that — a redeploy rebuilds the image FROM the repo, and the repo is the
 * stale half. The fix has to rewrite those files, which is what this module makes possible.
 *
 * Two deliberate design choices:
 *
 *  - **A precise token table, not a word sweep.** These rules run over source files inside someone
 *    else's repository, so a blanket `eden` → `harnesst` replace is not acceptable: a customer's
 *    own string (a repo name, a URL, an identifier) must survive untouched. Every rule below
 *    targets a shape harnesst itself emitted. Adding the next rename means adding a row here.
 *  - **`.ts` only, plus three known generated filenames.** Prose in markdown (instructions,
 *    skills) is the customer's writing; rewriting words in it would be vandalism, and no runtime
 *    contract lives there.
 *
 * The rewrite is idempotent and byte-exact: migrating a pre-#230 generated block reproduces the
 * post-#230 block that `~/eve/agentModule` emits today, comments included. That matters — the
 * self-healing rewriters in `agentModule` anchor on those comment markers, so a half-migrated file
 * would be invisible to them.
 *
 * Pure module (client+server safe): no I/O, no imports.
 */

/** One rewrite rule. `matches` is the human-readable token used in drift reports. */
interface LegacyRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * The generated-token table. Ordered, but the rules are disjoint by construction — each anchors
 * on a different case convention or a different following character.
 *
 * The negative lookbehind `(?<![A-Za-z0-9_$])` is what keeps the rules from firing mid-identifier
 * (it is the same guard PR #230's own sweep used): `CREDENTIALS` must not become `CRHARNESSTTIALS`.
 */
const LEGACY_RULES: LegacyRule[] = [
  // Env vars and generated SCREAMING_SNAKE constants: EDEN_SANDBOX_ENV, EDEN_TEAM_TOKEN,
  // EDEN_MODEL_GATEWAY_URL, EDEN_MODEL_DIRECTIVE, and the runtime-assembled 'EDEN_PROVIDER_' prefix.
  { pattern: /(?<![A-Za-z0-9_$])EDEN_(?=[A-Z0-9_])/g, replacement: "HARNESST_" },
  // Generated type names: EdenModelConfig, EdenReasoningEffort (harnesst-model.ts).
  { pattern: /(?<![A-Za-z0-9_$])Eden(?=[A-Z])/g, replacement: "Harnesst" },
  // Generated function/const identifiers: edenModel, edenAgentModel, edenGateway,
  // edenSelectedModel, edenReasoningModel, edenConfiguredModel, edenModelConfigCache.
  { pattern: /(?<![A-Za-z0-9_$])eden(?=[A-Z])/g, replacement: "harnesst" },
  // The playground's per-conversation model directive markers, which appear both as a literal in
  // the message and as a regex source in the generated parser: `<!-- eden:model … -->`, `eden:sig`.
  { pattern: /(?<![A-Za-z0-9_$])eden(?=:(?:model|sig)\b)/g, replacement: "harnesst" },
  // Generated filenames / module specifiers: './eden-model', 'eden-lock.json', and the
  // build-time placeholder credential 'eden-missing-credential'.
  {
    pattern: /(?<![A-Za-z0-9_$])eden(?=-(?:model|lock|missing-credential)\b)/g,
    replacement: "harnesst",
  },
  // The unconfigured-model sentinel in the generated `harnesst-model.ts` fallback slot.
  { pattern: /(?<![A-Za-z0-9_$])eden(?=\/unconfigured\b)/g, replacement: "harnesst" },
  // The gateway provider's name literal: `createOpenAICompatible({ name: 'eden', … })`.
  { pattern: /(['"`])eden\1/g, replacement: "$1harnesst$1" },
  // Brand prose inside the generated comment blocks ("// Eden playground model override:",
  // "Eden's translating gateway"). Cosmetic on its own, but load-bearing: agentModule's
  // helper-region regexes anchor on those exact comment markers.
  { pattern: /(?<![A-Za-z0-9_$])Eden(?![A-Za-z0-9_$])/g, replacement: "harnesst" },
];

/**
 * Generated FILES whose name carries the old brand. The control plane reads the new names only —
 * a repo still holding `eden-lock.json` has an invisible install ledger, so its marketplace
 * installs vanish from Settings and deploy-time OAuth scope coverage silently skips.
 *
 * Keys are matched against the file's basename; `harnesst-model.ts` can sit under any agent root,
 * the other two are repo-root files.
 */
const LEGACY_FILENAMES: Record<string, string> = {
  "eden-lock.json": "harnesst-lock.json",
  "eden.json": "harnesst.json",
  "eden-model.ts": "harnesst-model.ts",
};

/**
 * Generated DIRECTORIES whose name carries the old brand. The built-in assistant's user-config
 * surface moved with the rename, so a pre-#230 repo keeps its assistant instructions and skills in
 * a directory harnesst no longer reads — they render as gone.
 */
const LEGACY_DIRECTORIES: Array<[string, string]> = [
  [".eden/assistant/", ".harnesst/assistant/"],
];

/**
 * The post-migration path for `path`, or null when the path needs no change. Basenames are
 * rewritten in place (a rename must not move a file between directories); the directory rules move
 * a whole subtree, preserving everything below the renamed prefix.
 */
export function renameLegacyPath(path: string): string | null {
  for (const [from, to] of LEGACY_DIRECTORIES) {
    if (path.startsWith(from)) return `${to}${path.slice(from.length)}`;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const renamed = LEGACY_FILENAMES[base];
  return renamed ? `${dir}${renamed}` : null;
}

/**
 * Repo-relative paths a source read must include for the drift scan to SEE the legacy files —
 * `fetchAgentSource` filters the git tree down to harnesst-owned prefixes, and every one of those
 * prefixes was itself renamed. Without this the repair could never find what it must fix.
 */
export const LEGACY_SOURCE_PREFIXES: string[] = LEGACY_DIRECTORIES.map(
  ([from]) => from,
);

/** Repo-root files whose legacy names a source read must include, for the same reason. */
export const LEGACY_ROOT_FILES: string[] = Object.keys(LEGACY_FILENAMES).filter(
  (name) => !name.endsWith(".ts"),
);

/** Rewrite every legacy generated token in `source`. Idempotent; returns `source` when clean. */
export function migrateLegacySource(source: string): string {
  let next = source;
  for (const rule of LEGACY_RULES) {
    next = next.replace(rule.pattern, rule.replacement);
  }
  return next;
}

/** True when `source` still carries a legacy generated token. */
export function hasLegacyNames(source: string | null | undefined): boolean {
  return typeof source === "string" && migrateLegacySource(source) !== source;
}

/**
 * The distinct legacy tokens `source` still carries, sorted — what the drift report shows the
 * human ("this file still reads EDEN_SANDBOX_ENV"). Tokens are captured with their surrounding
 * identifier characters so `EDEN_SANDBOX_ENV` reads as a name, not as a bare `EDEN_` fragment.
 */
export function findLegacyNames(source: string): string[] {
  const found = new Set<string>();
  for (const rule of LEGACY_RULES) {
    // A fresh regex per scan: the table's patterns are global, so `lastIndex` is shared state.
    const scanner = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of source.matchAll(scanner)) {
      const at = match.index ?? 0;
      // Widen to the full surrounding token so the report names something greppable. A preceding
      // `.` is property access (`process.env.EDEN_SANDBOX_ENV`), not part of the name; a trailing
      // one is a file extension (`eden-lock.json`) and is kept.
      const before = source.slice(0, at).match(/[A-Za-z0-9_$-]*$/)?.[0] ?? "";
      const after = source.slice(at).match(/^[A-Za-z0-9_$.:-]*/)?.[0] ?? "";
      // The quoted-literal rule matches ON the quote, so widening yields nothing — fall back
      // to the raw match rather than reporting an empty token.
      found.add(`${before}${after}` || match[0]);
    }
  }
  return [...found].sort();
}

/**
 * Whether a repo-relative path holds GENERATED code this migration is allowed to rewrite.
 *
 * Deliberately narrow (see the module comment): TypeScript under an agent root — which is
 * everything harnesst scaffolds or installs — plus the three legacy-named generated files. Markdown
 * (instructions, skills, subagent prompts) is the customer's prose and is never touched.
 */
export function isMigratableGeneratedPath(path: string): boolean {
  if (renameLegacyPath(path)) return true;
  if (!path.endsWith(".ts")) return false;
  return path.startsWith("agent/") || path.startsWith("agents/");
}
