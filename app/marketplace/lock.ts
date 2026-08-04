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
  /**
   * The `/`-joined declared-subagent path below the member's agent root that this install's files
   * live under — `"reader"` for `<memberRoot>/subagents/reader/…`, `"reader/skim"` for a nested
   * one. Omitted (never `""`) means the member agent itself, so every lock written before installs
   * could target a subagent stays byte-identical. LOCK_VERSION stays 1 — optional, old locks parse
   * fine.
   *
   * This is part of the install IDENTITY alongside `(id, member)`, not an annotation: eve treats a
   * declared subagent as its own agent root that inherits nothing from its parent, so the same
   * template legitimately installs on both a member and that member's subagent, and those two rows
   * must not clobber each other on upsert, uninstall or update.
   */
  subagent: z.string().min(1).optional(),
  /** FINAL repo-relative paths the install owns (excludes package.json / harnesst-lock.json). */
  files: z.array(z.string().min(1)),
  /**
   * Snapshot of the template's assistant skill CONTENT at install time (issue #274) — the
   * markdown the harnesst assistant loads about this template, delivered to the assistant instance
   * via the bundle (`skills/harnesst-installed-<template-id>.md`), never installed into the repo
   * tree.
   * Snapshotted like `secrets`/`auth` so the install pins the skill it shipped with: the catalog
   * only serves its current version, and a newer template's skill may describe capabilities the
   * installed code doesn't have. Old locks without the field backfill from the catalog on bundle
   * assembly. LOCK_VERSION stays 1 — optional, old locks parse fine.
   */
  assistantSkill: z.string().min(1).optional(),
  /**
   * Paths this install deliberately PRESERVED at register time (issue #177): files that already
   * existed outside the lock and were kept byte-for-byte and left UNMANAGED. They are NOT in
   * `files`, so uninstall never deletes them; recording them here lets the Settings drift check
   * treat them as present (not missing) and stops a later repair/update from blocking on the very
   * files the register step promised to leave alone. The promise is scoped to what the incoming
   * template does NOT ship: a template-shipped path recorded here is reclaimed — overwritten and
   * moved into `files` — by the next update (the #254 reversal: updates overwrite).
   * LOCK_VERSION stays 1 — optional, old locks parse fine.
   */
  preservedFiles: z.array(z.string().min(1)).optional(),
  /**
   * sha256(hex) per repo-relative path of every PLATFORM file this install materialized (issue
   * #254) — the `harnesst/…` code sibling to the agent root that only the installer may write.
   *
   * This is a FILE-CONTENT hash and is deliberately distinct from `hash` above (the template's own
   * sha1 over manifest + files). `hash` answers "which catalog version is installed?" and is blind
   * to what happened to the bytes afterwards — which is how an update overwrote two live agents'
   * customised channel code without anyone being able to tell customised from untouched. Publish
   * re-hashes each `harnesst/` file on disk against this map and refuses the publish on a mismatch
   * or an unknown platform path, so platform code can only ever arrive via a marketplace install.
   * LOCK_VERSION stays 1 — optional, old locks parse fine.
   */
  platformFiles: z.record(z.string().min(1), z.string().min(1)).optional(),
  /**
   * Operator-set configuration for the CHANNEL this install provides (issue #254): plain
   * key → value, projected into the deployed instance's environment at deploy time as
   * `HARNESST_CHANNEL_<ID>_<KEY>`. It lives in the lock rather than a DB table because it is
   * install-scoped configuration that must travel with the repo and be reviewable in the PR that
   * changes it; and it is env rather than code because channel behaviour is configuration, never
   * something a customer should have to edit a file to change. Absent reads as INERT — a channel
   * with no settings must change no existing agent's behaviour.
   *
   * One blob per ENTRY, resolved to a channel by `channelIdsForEntry` (a bundle's only lock entry
   * is the bundle, so a bundle-carried channel's settings live on the bundle's entry). No shipped
   * bundle carries two channels; the day one does, this becomes a per-channel map.
   * LOCK_VERSION stays 1 — optional, old locks parse fine.
   */
  settings: z
    .record(
      z.string().min(1),
      z.union([z.string(), z.array(z.string()), z.boolean()]),
    )
    .optional(),
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

/** The shared UI/error explanation for a template whose lifecycle belongs to its parent install. */
export function providerExplanation(
  provider: Pick<InstallEntry, "name" | "version">,
): string {
  return `Provided by ${provider.name} v${provider.version} — update ${provider.name} to update this.`;
}

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

/**
 * An install is identified by (id, member, subagent) — the same template can live under two
 * members, and under a member AND one of that member's declared subagents (separate agent roots
 * that inherit nothing from each other). `subagent` defaults to `""`, the member agent itself,
 * which is what every member-level caller already means.
 */
export function findInstall(
  lock: HarnesstLock,
  id: string,
  member: string | null,
  subagent: string = "",
): InstallEntry | undefined {
  return lock.installs.find(
    (e) =>
      e.id === id && e.member === member && (e.subagent ?? "") === subagent,
  );
}

export interface TemplateProvider {
  install: InstallEntry;
  via: "direct" | "include" | "catalog-include";
}

/**
 * Current-catalog evidence for one installed parent. `ownedPaths` are the included template's
 * resolved final repo paths, used to prove an older lock actually materialized that child rather
 * than merely sharing an id with something added to a later parent version. `provider.subagent`
 * keeps that proof scoped: a member and its declared subagent can both install the same composite,
 * and each row's paths are resolved against its OWN agent root, so matching evidence across the two
 * would compare a subagent entry's files against member-root paths and silently find nothing.
 */
export interface CatalogProviderEvidence {
  provider: Pick<InstallEntry, "id" | "type" | "member" | "subagent">;
  includes: Array<{
    id: string;
    type: TemplateType;
    ownedPaths: string[];
  }>;
}

/**
 * Which install provides one typed catalog template for a member? A template may have its own lock
 * row, be recorded in a composite's flattened `includes` provenance, or be confirmed through the
 * current catalog for an older parent lock that predates flattened provenance.
 *
 * Identity is always `(type, id)`, never id alone. The strict type check is security-sensitive for
 * channels/tools: those identities gate park/publish URLs and delegation tokens. Legacy inference
 * catalog fallback also matches `(type, id)` and requires at least one path the parent lock owns;
 * catalog membership alone cannot claim a child that was introduced only in a newer version.
 *
 * Scoped to ONE agent root: `subagent` (default `""` = the member agent itself) narrows to the rows
 * installed under that declared subagent, because a subagent is its own agent root — a member-level
 * row must not answer for a template installed on the subagent, nor the reverse.
 */
export function findTemplateProvider(
  lock: HarnesstLock,
  type: TemplateType,
  id: string,
  member: string | null,
  catalogProviders: readonly CatalogProviderEvidence[] = [],
  subagent: string = "",
): TemplateProvider | undefined {
  const memberInstalls = lock.installs.filter(
    (e) => e.member === member && (e.subagent ?? "") === subagent,
  );
  const direct = memberInstalls.find((e) => e.type === type && e.id === id);
  if (direct) return { install: direct, via: "direct" };

  const included = memberInstalls.find((e) =>
    (e.includes ?? []).some((i) => i.type === type && i.id === id),
  );
  if (included) return { install: included, via: "include" };

  const catalogInstall = memberInstalls.find((entry) => {
    const evidence = catalogProviders.find(
      (candidate) =>
        candidate.provider.id === entry.id &&
        candidate.provider.type === entry.type &&
        candidate.provider.member === entry.member &&
        (candidate.provider.subagent ?? "") === (entry.subagent ?? ""),
    );
    const include = evidence?.includes.find(
      (candidate) => candidate.type === type && candidate.id === id,
    );
    return (
      include !== undefined &&
      include.ownedPaths.some((path) => entry.files.includes(path))
    );
  });
  return catalogInstall
    ? { install: catalogInstall, via: "catalog-include" }
    : undefined;
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
  return findChannelInstall(lock, id, member) !== undefined;
}

/**
 * The channel template ids an install PROVIDES: itself when it is a channel template, plus every
 * channel it bundled by reference. Both branches insist on `type === "channel"`, so a tool or hook
 * that merely shares the name provides nothing.
 */
export function channelIdsForEntry(entry: InstallEntry): string[] {
  const ids = entry.type === "channel" ? [entry.id] : [];
  for (const include of entry.includes ?? []) {
    if (include.type === "channel" && !ids.includes(include.id)) {
      ids.push(include.id);
    }
  }
  return ids;
}

/**
 * Is the TOOL template `id` present for this member — installed directly, OR carried by a bundle?
 * Same bundle-blindness fix as `hasChannelInstalled` (a composite install drops its parts' own lock
 * rows), and the same insistence on the type: this decides who receives a publish URL and a
 * delegation token (#290), so a channel or hook that merely shares the name gets nothing.
 *
 * Deliberately matches on `member` alone, so it SEES subagent rows: it gates the deployment env
 * vars (`HARNESST_FOH_ARTIFACTS_URL`, `HARNESST_ASSETS_URL`) that a tool needs at runtime, and a
 * tool installed on a declared subagent still runs in its member's container and still needs them.
 */
export function hasToolInstalled(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): boolean {
  return lock.installs.some(
    (e) =>
      e.member === member &&
      ((e.type === "tool" && e.id === id) ||
        (e.includes ?? []).some((i) => i.type === "tool" && i.id === id)),
  );
}

/**
 * The install providing channel `id` for `member` — directly or bundle-carried — if any.
 *
 * Member-scoped with no `subagent` parameter on purpose: channels are root-only in eve and
 * `planInstall` refuses a channel at a subagent target, so no subagent row can ever provide one.
 * Nothing to narrow here — don't "fix" it.
 */
export function findChannelInstall(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): InstallEntry | undefined {
  return lock.installs.find(
    (e) => e.member === member && channelIdsForEntry(e).includes(id),
  );
}

/** Operator-set configuration for one channel (issue #254) — see `installEntrySchema.settings`. */
export type ChannelSettings = NonNullable<InstallEntry["settings"]>;

/**
 * The settings currently stored for channel `id` under `member` (issue #254). Empty when the
 * channel isn't installed OR was never configured — the caller never has to tell those apart,
 * because both mean the same thing: inert.
 * Client-safe: pure, no server imports.
 */
export function channelSettings(
  lock: HarnesstLock,
  id: string,
  member: string | null,
): ChannelSettings {
  return findChannelInstall(lock, id, member)?.settings ?? {};
}

/**
 * Drop settings that carry no information: an empty string, an empty list, and `false` all mean
 * "not configured", and the channel code reads a missing env var the same way. Storing them would
 * be pure diff noise in a file whose whole job is to be reviewable.
 */
function pruneSettings(settings: ChannelSettings): ChannelSettings {
  const out: ChannelSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === false || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = [...value];
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Order-insensitive equality for two settings blobs (arrays compare element-wise, in order). */
function sameSettings(a: ChannelSettings, b: ChannelSettings): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => {
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) || Array.isArray(bv)) {
      return (
        Array.isArray(av) &&
        Array.isArray(bv) &&
        av.length === bv.length &&
        av.every((v, i) => v === bv[i])
      );
    }
    return av === bv;
  });
}

/**
 * Rewrite the stored settings for the install providing channel `id` under `member` (issue #254 —
 * the Deployment tab's channel settings panel). Values that mean "not configured" are dropped
 * rather than stored blank, and an entry left with nothing loses the field entirely, so an
 * unconfigured channel is byte-identical to one that was never touched. Other members' installs
 * and installs providing other channels pass through untouched. Pure; returns a new lock and
 * whether anything changed — the shape `setSelectedGroups` uses, so the route can skip staging a
 * no-op draft.
 */
export function setChannelSettings(
  lock: HarnesstLock,
  id: string,
  member: string | null,
  settings: ChannelSettings,
): { lock: HarnesstLock; changed: boolean } {
  let changed = false;
  const next = pruneSettings(settings);
  const hasNext = Object.keys(next).length > 0;
  const installs = lock.installs.map((entry) => {
    if (entry.member !== member || !channelIdsForEntry(entry).includes(id)) {
      return entry;
    }
    if (entry.settings === undefined ? !hasNext : sameSettings(entry.settings, next)) {
      return entry;
    }
    changed = true;
    const { settings: _previous, ...rest } = entry;
    return hasNext ? { ...rest, settings: next } : rest;
  });
  return changed ? { lock: { ...lock, installs }, changed } : { lock, changed };
}

/**
 * The lock-owned paths of `entry` that are NOT in `present` — files the install still claims but
 * that no longer exist in the repo, because someone moved, renamed, or deleted them. `present` is
 * the branch tree with staged drafts applied, so a freshly-staged install (whose files are drafts,
 * not yet published) reads as intact rather than drifted.
 *
 * This is drift only a disk comparison can see: matching the lock against the catalog manifest
 * proves the LOCK is complete and says nothing about the tree, so a relocated managed file used to
 * be invisible to the Settings drift check — the exact state a hand-"fixed" install leaves behind.
 * `preservedFiles` are deliberately excluded here: they were never lock-owned (issue #177).
 * Client-safe: pure, no server imports.
 */
export function missingOwnedFiles(
  entry: InstallEntry,
  present: ReadonlySet<string>,
): string[] {
  return entry.files.filter((file) => !present.has(file));
}

/** Stable "type/id" identity for matching a lock install against a catalog row. */
export function installKey(type: TemplateType, id: string): string {
  return `${type}/${id}`;
}

/**
 * All (type/id) keys provided by a lock — direct rows plus every flattened include. The
 * marketplace "Installed" facet reads this, so a bundle-carried template is installed too even
 * though it intentionally has no standalone lock row.
 *
 * Lock-wide and never narrowed by `subagent`, so a subagent's row marks its template installed
 * too: the facet asks whether the template is present in this repo, and it is.
 */
export function installedKeys(
  lock: HarnesstLock,
  catalogProviders: readonly CatalogProviderEvidence[] = [],
): string[] {
  return lock.installs.flatMap((entry) => {
    const recorded = [
      installKey(entry.type, entry.id),
      ...(entry.includes ?? []).map((include) =>
        installKey(include.type, include.id),
      ),
    ];
    const recordedSet = new Set(recorded);
    const evidence = catalogProviders.find(
      (candidate) =>
        candidate.provider.id === entry.id &&
        candidate.provider.type === entry.type &&
        candidate.provider.member === entry.member,
    );
    const inferred = (evidence?.includes ?? []).flatMap((include) => {
      const key = installKey(include.type, include.id);
      if (recordedSet.has(key)) return [];
      const provider = findTemplateProvider(
        lock,
        include.type,
        include.id,
        entry.member,
        catalogProviders,
      );
      return provider?.install === entry ? [key] : [];
    });
    return [...recorded, ...inferred];
  });
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
 *
 * Matches on `member` alone, so it deliberately includes installs scoped to that member's declared
 * subagents: an OAuth grant is DEPLOYMENT state, and a subagent runs inside — and deploys with —
 * its member's container, so its connection needs the same scopes on the same grant.
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
 *
 * Member-only match, subagent rows included, for the same reason as `requiredScopesByProvider`:
 * the permission surface belongs to the member's deployment, which its subagents share.
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
 *
 * Member-only match, so a subagent row's snapshot is rewritten too — the selection being edited is
 * the member deployment's OAuth grant, shared by every agent root inside its container.
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

/**
 * Upsert an entry by (id, member, subagent): replaces the matching install, else appends. An entry
 * with no `subagent` is a distinct install from the same template on one of the member's subagents,
 * so all three components must match before we replace. Pure.
 */
export function upsertInstall(lock: HarnesstLock, entry: InstallEntry): HarnesstLock {
  const subagent = entry.subagent ?? "";
  const rest = lock.installs.filter(
    (e) =>
      !(
        e.id === entry.id &&
        e.member === entry.member &&
        (e.subagent ?? "") === subagent
      ),
  );
  return { ...lock, installs: [...rest, entry] };
}

/** Remove the (id, member, subagent) entry, returning a new lock. Pure. */
export function removeInstall(
  lock: HarnesstLock,
  id: string,
  member: string | null,
  subagent: string = "",
): HarnesstLock {
  return {
    ...lock,
    installs: lock.installs.filter(
      (e) =>
        !(
          e.id === id &&
          e.member === member &&
          (e.subagent ?? "") === subagent
        ),
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
 * Infer the subagent scope of an install from the paths it already owns: the `/`-joined chain when
 * EVERY path in `entry.files` sits under one common `<memberRoot>/subagents/<a>[/subagents/<b>…]/`
 * prefix, else `null`. Entries that already carry `subagent`, and entries owning no files, infer
 * nothing.
 *
 * This exists for locks written before an install could target a subagent. In the repo it was
 * written for, the assistant moved the files into the subagent tree by hand and rewrote `files` to
 * match, so those recorded paths are the only surviving evidence of where the install was meant to
 * live. Hence the unanimity requirement: a mixed entry — some files at the member root, some under
 * a subagent — is a hand-edited install no inference can safely claim, and guessing wrong here
 * would relocate live agent code on the next update. `null` means "leave it alone", never "member
 * level"; the operator can still declare the scope explicitly.
 */
export function inferSubagentScope(
  entry: InstallEntry,
  memberRoot: string,
): string | null {
  if (entry.subagent !== undefined) return null;
  if (entry.files.length === 0) return null;
  const prefix = memberRoot.endsWith("/") ? memberRoot : `${memberRoot}/`;
  let chain: string[] | null = null;
  for (const file of entry.files) {
    if (!file.startsWith(prefix)) return null;
    const segments = file.slice(prefix.length).split("/");
    const fileChain: string[] = [];
    // Read alternating `subagents/<name>` pairs off the front. The chain must be a DIRECTORY
    // prefix, so a pair only counts while at least one segment remains after it — a file literally
    // named `subagents/reader` is a file, not a subagent root.
    while (
      segments.length >= 3 &&
      segments[0] === "subagents" &&
      segments[1] !== ""
    ) {
      fileChain.push(segments[1]);
      segments.splice(0, 2);
    }
    if (chain === null) {
      chain = fileChain;
    } else if (
      chain.length !== fileChain.length ||
      chain.some((name, i) => name !== fileChain[i])
    ) {
      return null;
    }
  }
  return chain !== null && chain.length > 0 ? chain.join("/") : null;
}

/**
 * Apply `inferSubagentScope` across a lock, resolving each entry's agent root through `memberRoots`
 * (keyed by `entry.member`, so `null` is the single-agent repo's root agent). Entries whose member
 * is absent from the map are left untouched — an unresolvable root is not evidence of anything.
 *
 * Pure, and no write-on-read: the caller applies this while planning, and the corrected `subagent`
 * fields land in the same lock write the plan produces, reviewable in the PR. `changed` is false
 * and the SAME lock object comes back when nothing inferred.
 */
export function reconcileSubagentScopes(
  lock: HarnesstLock,
  memberRoots: ReadonlyMap<string | null, string>,
): { lock: HarnesstLock; changed: boolean } {
  let changed = false;
  const installs = lock.installs.map((entry) => {
    const root = memberRoots.get(entry.member);
    if (root === undefined) return entry;
    const subagent = inferSubagentScope(entry, root);
    if (subagent === null) return entry;
    changed = true;
    return { ...entry, subagent };
  });
  return changed ? { lock: { ...lock, installs }, changed } : { lock, changed };
}

/**
 * Serialize to stable, review-friendly JSON: installs sorted by (id, member, subagent) so a diff is
 * driven by content not insertion order, 2-space indent, trailing newline (the repo's file
 * convention — everything else in a change-set looks like this).
 */
export function serializeLock(lock: HarnesstLock): string {
  const installs = [...lock.installs].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    // Root agent (null member) sorts before named members; then lexical.
    const am = a.member ?? "";
    const bm = b.member ?? "";
    if (am !== bm) return am < bm ? -1 : 1;
    // The member agent (no subagent) sorts before its subagents; then lexical.
    const as = a.subagent ?? "";
    const bs = b.subagent ?? "";
    return as < bs ? -1 : as > bs ? 1 : 0;
  });
  return JSON.stringify({ version: lock.version, installs }, null, 2) + "\n";
}
