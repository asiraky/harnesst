/**
 * `harnesst-lock.json` — the install provenance ledger (PRD §7.8 "Update-from-source"),
 * generalizing the skills-lock idea to every hierarchy level.
 *
 * One record per install: what was installed, at what version, from where, and — the load-
 * bearing part — the FINAL repo-relative paths of the files it owns. We record final paths
 * (not template-relative ones) deliberately: uninstall and update both need to know exactly
 * which bytes on disk are the template's, and that ground truth has to survive a roster rename
 * (a member `pm` → `product` moves `agents/pm/agent/tools/x.ts` to a new home; re-deriving the
 * path from `type + member` at that moment would target the wrong file). The `member` field is
 * how a team repo attributes an install; `null` is the single-agent repo's one root agent.
 *
 * Client-safe: pure Zod + pure helpers, no server imports — the install planner and the wizard
 * route component alike reference these types. Callers treat a MISSING file as an empty lock
 * (a repo that has never installed anything has no `harnesst-lock.json`); malformed bytes throw.
 */
import { z } from "zod";

import { TEMPLATE_TYPES, type TemplateType } from "./manifest";

/** The lock schema version — bumped only on a breaking shape change (migration lives here). */
export const LOCK_VERSION = 1;

/** The lock's fixed repo-root location. */
export const LOCK_PATH = "harnesst-lock.json";

const installEntrySchema = z.object({
  /** The template id (kebab slug) — the marketplace identity. */
  id: z.string().min(1),
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  /** The version installed (semver x.y.z); update detection compares against the catalog. */
  version: z.string().min(1),
  /** Content hash of the installed template — matches the index row it came from. */
  hash: z.string().min(1),
  /** Where it came from: "fixture" or "github:owner/repo@ref" (the CatalogSource locator). */
  registry: z.string().min(1),
  /** Owning roster member; null = the single-agent repo's root agent. */
  member: z.string().nullable(),
  /** FINAL repo-relative paths the install owns (excludes package.json / harnesst-lock.json). */
  files: z.array(z.string().min(1)),
  /**
   * Paths this install deliberately PRESERVED at register time (issue #177): files that already
   * existed outside the lock and were kept byte-for-byte and left UNMANAGED. They are NOT in
   * `files`, so uninstall never deletes them; recording them here lets the Settings drift check
   * treat them as present (not missing) and lets a later repair/update keep preserving them
   * instead of blocking on the very files the register step promised to leave alone.
   * LOCK_VERSION stays 1 — optional, old locks parse fine.
   */
  preservedFiles: z.array(z.string().min(1)).optional(),
  /** The npm dependencies the install ASKED for (name → range) — uninstall lists these. */
  dependencies: z.record(z.string(), z.string()).optional(),
  /**
   * Snapshot of the template's declared secrets at install time (§4.5). This is what makes
   * "required by this template" renderable forever — surviving template upgrades per-version.
   * Old locks without the field simply produce no required-rows.
   */
  secrets: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        sandbox: z.boolean().optional(),
        /** Set by a guided harnesst flow (e.g. the GitHub App manifest flow), not collected at install. */
        provisioned: z.boolean().optional(),
        /** Minted once by harnesst at first deploy (issue #163), never typed or collected. */
        generated: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Sandbox setup declared by the installed template, used to regenerate sandbox add-ons. */
  sandbox: z
    .object({
      bootstrap: z.array(z.string().min(1)).optional(),
      env: z.record(z.string().min(1), z.string()).optional(),
      revalidationKey: z.string().min(1).optional(),
    })
    .optional(),
  /**
   * Composition provenance (LOCK_VERSION stays 1 — optional field, old locks parse fine): the
   * catalog templates this install bundled by reference, each with its OWN version + hash at
   * install time. The included files themselves are already flattened into `files`; this is the
   * record of where they came from, so the surface can show "bundled from the catalog".
   */
  includes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(TEMPLATE_TYPES),
        name: z.string().min(1),
        version: z.string().min(1),
        hash: z.string().min(1),
      }),
    )
    .optional(),
  /**
   * Snapshot of the OAuth connection scopes this install REQUIRES at install time (issue #30;
   * LOCK_VERSION stays 1 — optional field, old locks parse fine). This is the request template a
   * Reconnect must use: a grant row's stored `scopes` records only what Google GRANTED last time,
   * so deriving the reconnect request from it perpetuates stale/narrow scopes forever. Snapshotting
   * requirements here — exactly like `secrets` — lets surfaces rebuild the correct scope set per
   * installed connector, surviving template upgrades per-version.
   *
   * Scope groups (issue #165): `scopes` is the always-required baseline (optional when the
   * template declares groups); `scopeGroups` snapshots the template's selectable permission
   * levels (the lock must be self-sufficient for the Reconnect/Permissions UI); `selectedGroups`
   * is the installer's CURRENT choice — written at install and mutable afterwards from the
   * Deployment tab (it's config, not history). The effective requirement is
   * baseline ∪ scopes of the selected groups.
   */
  auth: z
    .array(
      z.object({
        provider: z.string().min(1),
        kind: z.literal("oauth2"),
        /** Baseline scopes, always required. Optional when scopeGroups is present. */
        scopes: z.array(z.string().min(1)).min(1).optional(),
        /** The template's selectable permission levels, snapshotted at install (#165). */
        scopeGroups: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().min(1),
              description: z.string().min(1),
              scopes: z.array(z.string().min(1)).min(1),
              default: z.boolean().optional(),
            }),
          )
          .min(1)
          .optional(),
        /** The installer's current choice — subset of scopeGroups ids. Mutable config (#165). */
        selectedGroups: z.array(z.string().min(1)).optional(),
        /**
         * Operation-group ids this install OFFERS for the provider's capability (issue #166) —
         * the template's `capability.groups`, snapshotted at install. Ids only: the labels/
         * descriptions/risk live in harnesst's capability registry (they're code, not data), unlike
         * `scopeGroups` whose definitions are template-authored.
         */
        capabilityGroups: z.array(z.string().min(1)).min(1).optional(),
        /**
         * The installer's CURRENT capability-group choice (issue #166) — subset of
         * `capabilityGroups`, written at install and mutable from the Deployment tab. Enforcement
         * is PER CALL in harnesst (`/api/capabilities/...`), so edits apply at the agent's next call —
         * no reconnect, no redeploy. Absent (never written) reads as NOTHING enabled: fail closed.
         */
        selectedCapabilityGroups: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
});

export type InstallEntry = z.infer<typeof installEntrySchema>;

export const lockSchema = z.object({
  version: z.literal(LOCK_VERSION),
  installs: z.array(installEntrySchema),
});

export type HarnesstLock = z.infer<typeof lockSchema>;

/** A fresh, empty lock — what callers use when `harnesst-lock.json` is absent. */
export function emptyLock(): HarnesstLock {
  return { version: LOCK_VERSION, installs: [] };
}

/**
 * Parse+validate raw `harnesst-lock.json` bytes. Throws on malformed content (a corrupt lock is a
 * real problem the reviewer must see, not a silent reset). Callers handle the *missing*-file
 * case themselves with `emptyLock()`.
 */
export function parseLock(json: unknown): HarnesstLock {
  return lockSchema.parse(json);
}

/**
 * The effective lock for a repo: the staged `harnesst-lock.json` draft if there is one, else the
 * branch's file, else empty. A corrupt lock degrades to empty rather than crashing the surface
 * that reads it (the next install's change-set rewrites it cleanly). `repoContent` is the
 * branch's `harnesst-lock.json` bytes (or null when absent).
 */
export function overlayLock(
  repoContent: string | null,
  drafts: Array<{ path: string; content: string | null }>,
): HarnesstLock {
  const draft = drafts.find((d) => d.path === LOCK_PATH);
  const raw = draft !== undefined ? draft.content : repoContent;
  if (!raw) return emptyLock();
  try {
    return parseLock(JSON.parse(raw));
  } catch {
    return emptyLock();
  }
}

/** An install is identified by (id, member) — the same template can live under two members. */
export function findInstall(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): InstallEntry | undefined {
  return lock.installs.find((e) => e.id === id && e.member === member);
}

/**
 * Is the channel template `id` present for this member — installed directly, OR carried by a
 * bundle? A composite install records its parts under `includes` and DROPS their standalone lock
 * entries (`planInstall`: "the composite's `includes` provenance replaces it"), so a plain
 * `findInstall(lock, "github", …)` misses the case the marketplace steers people into — the
 * GitHub *bundle*, whose only lock entry is `{type: "bundle", id: "github-bundle"}`.
 *
 * Both branches insist on `type === "channel"`, so a tool or hook that merely shares the name
 * still gets nothing: this decides who receives a park URL and a delegation token.
 */
export function hasChannelInstalled(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): boolean {
  return lock.installs.some(
    (e) =>
      e.member === member &&
      ((e.id === id && e.type === "channel") ||
        (e.includes ?? []).some((i) => i.id === id && i.type === "channel")),
  );
}

/** Stable "type/id" identity for matching a lock install against a catalog row. */
export function installKey(type: TemplateType, id: string): string {
  return `${type}/${id}`;
}

/** All (type/id) keys installed in a lock — the marketplace "Installed" facet reads this. */
export function installedKeys(lock: HarnesstLock): string[] {
  return lock.installs.map((e) => installKey(e.type, e.id));
}

/** One install's auth snapshot (see `installEntrySchema.auth`). */
export type InstallAuth = NonNullable<InstallEntry["auth"]>[number];

/**
 * The scope-group ids currently SELECTED for one auth snapshot (issue #165): the stored
 * `selectedGroups` when the install has written one, else the template's `default`-flagged
 * groups (a snapshot that predates any explicit choice behaves like a fresh install). Always a
 * subset of the snapshot's group ids; empty for group-less snapshots.
 */
export function selectedGroupIds(auth: InstallAuth): string[] {
  const groups = auth.scopeGroups ?? [];
  if (groups.length === 0) return [];
  const valid = new Set(groups.map((g) => g.id));
  if (auth.selectedGroups) {
    return auth.selectedGroups.filter((id) => valid.has(id));
  }
  return groups.filter((g) => g.default).map((g) => g.id);
}

/**
 * One auth snapshot's EFFECTIVE required scopes (issue #165): the baseline `scopes` plus the
 * scopes of every selected group. Group-less snapshots reduce to their baseline exactly as
 * before scope groups existed.
 */
export function effectiveAuthScopes(auth: InstallAuth): string[] {
  const selected = new Set(selectedGroupIds(auth));
  const out = new Set<string>(auth.scopes ?? []);
  for (const group of auth.scopeGroups ?? []) {
    if (!selected.has(group.id)) continue;
    for (const scope of group.scopes) out.add(scope);
  }
  return [...out];
}

/**
 * The OAuth scopes REQUIRED per provider by all installs owned by `member` (issue #30): the union
 * of every install's EFFECTIVE `auth` snapshot (baseline ∪ selected scope groups — issue #165),
 * deduped and sorted, keyed by provider. A Reconnect must request THIS set, never a grant row's
 * stored scopes (which record only what was granted before). Empty for members whose installs
 * carry no `auth` snapshot (old locks, non-connector installs).
 * Client-safe: pure, no server imports.
 */
export function requiredScopesByProvider(
  lock: HarnesstLock,
  member: string | null,
): Map<string, string[]> {
  const byProvider = new Map<string, Set<string>>();
  for (const entry of lock.installs) {
    if (entry.member !== member) continue;
    for (const auth of entry.auth ?? []) {
      let set = byProvider.get(auth.provider);
      if (!set) {
        set = new Set<string>();
        byProvider.set(auth.provider, set);
      }
      for (const scope of effectiveAuthScopes(auth)) set.add(scope);
    }
  }
  const result = new Map<string, string[]>();
  for (const [provider, set] of byProvider) {
    result.set(provider, [...set].sort());
  }
  return result;
}

/** One selectable permission level as the Permissions UI renders it (issue #165). */
export interface ScopeGroupChoice {
  id: string;
  label: string;
  description: string;
  /** Whether the group is currently selected (stored choice, else the template default). */
  selected: boolean;
}

/**
 * The selectable permission levels per provider for `member`'s installs (issue #165): every
 * distinct scope group across the member's auth snapshots (deduped by id — first occurrence wins
 * the definition, mirroring compose), with its current selection state. Providers whose installs
 * declare no groups don't appear — their permission surface isn't editable.
 * Client-safe: pure, no server imports.
 */
export function scopeGroupsByProvider(
  lock: HarnesstLock,
  member: string | null,
): Map<string, ScopeGroupChoice[]> {
  const byProvider = new Map<string, ScopeGroupChoice[]>();
  for (const entry of lock.installs) {
    if (entry.member !== member) continue;
    for (const auth of entry.auth ?? []) {
      if (!auth.scopeGroups || auth.scopeGroups.length === 0) continue;
      const selected = new Set(selectedGroupIds(auth));
      let groups = byProvider.get(auth.provider);
      if (!groups) {
        groups = [];
        byProvider.set(auth.provider, groups);
      }
      for (const group of auth.scopeGroups) {
        const existing = groups.find((g) => g.id === group.id);
        if (existing) {
          // Two installs sharing a group id: selecting it ANYWHERE keeps it in the union.
          existing.selected = existing.selected || selected.has(group.id);
          continue;
        }
        groups.push({
          id: group.id,
          label: group.label,
          description: group.description,
          selected: selected.has(group.id),
        });
      }
    }
  }
  return byProvider;
}

/**
 * Rewrite the stored scope-group selection for every install owned by `member` that declares
 * groups for `provider` (issue #165 — the Deployment tab's Permissions edit). Each install keeps
 * only the ids its own snapshot knows; group-less snapshots and other providers/members pass
 * through untouched. Pure; returns a new lock and whether anything changed.
 */
export function setSelectedGroups(
  lock: HarnesstLock,
  member: string | null,
  provider: string,
  selected: string[],
): { lock: HarnesstLock; changed: boolean } {
  let changed = false;
  const installs = lock.installs.map((entry) => {
    if (entry.member !== member || !entry.auth) return entry;
    let entryChanged = false;
    const auth = entry.auth.map((a) => {
      if (a.provider !== provider || !a.scopeGroups) return a;
      // Keep the template's declaration order so the stored choice diffs stably; ids the
      // snapshot doesn't know are dropped (the caller's list is browser-supplied).
      const next = a.scopeGroups
        .map((g) => g.id)
        .filter((id) => selected.includes(id));
      const current = selectedGroupIds(a);
      if (
        a.selectedGroups !== undefined &&
        next.length === current.length &&
        next.every((id, i) => id === current[i])
      ) {
        return a;
      }
      entryChanged = true;
      return { ...a, selectedGroups: next };
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, auth };
  });
  return changed ? { lock: { ...lock, installs }, changed } : { lock, changed };
}

/** Upsert an entry by (id, member): replaces the matching install, else appends. Pure. */
export function upsertInstall(lock: HarnesstLock, entry: InstallEntry): HarnesstLock {
  const rest = lock.installs.filter(
    (e) => !(e.id === entry.id && e.member === entry.member),
  );
  return { ...lock, installs: [...rest, entry] };
}

/** Remove the (id, member) entry, returning a new lock. Pure. */
export function removeInstall(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): HarnesstLock {
  return {
    ...lock,
    installs: lock.installs.filter(
      (e) => !(e.id === id && e.member === member),
    ),
  };
}

/**
 * Rewrite every install owned by member `oldName` to `newName` when a team member is renamed:
 * retag `member`, and remap the FINAL `files` paths from `agents/<old>/…` to `agents/<new>/…`
 * (the lock records final paths precisely so uninstall/update survive a rename — §7.8). Entries
 * for other members and the root agent (`member === null`) pass through untouched. Pure; returns
 * a new lock and a flag for whether anything changed (so callers can skip an empty rewrite).
 */
export function renameMember(
  lock: HarnesstLock,
  oldName: string,
  newName: string,
): { lock: HarnesstLock; changed: boolean } {
  let changed = false;
  const oldPrefix = `agents/${oldName}/`;
  const newPrefix = `agents/${newName}/`;
  const installs = lock.installs.map((entry) => {
    if (entry.member !== oldName) return entry;
    changed = true;
    return {
      ...entry,
      member: newName,
      files: entry.files.map((f) =>
        f.startsWith(oldPrefix) ? newPrefix + f.slice(oldPrefix.length) : f,
      ),
    };
  });
  return { lock: { ...lock, installs }, changed };
}

/**
 * Serialize to stable, review-friendly JSON: installs sorted by (id, member) so a diff is
 * driven by content not insertion order, 2-space indent, trailing newline (the repo's file
 * convention — everything else in a change-set looks like this).
 */
export function serializeLock(lock: HarnesstLock): string {
  const installs = [...lock.installs].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    // Root agent (null member) sorts before named members; then lexical.
    const am = a.member ?? "";
    const bm = b.member ?? "";
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
  return JSON.stringify({ version: lock.version, installs }, null, 2) + "\n";
}
