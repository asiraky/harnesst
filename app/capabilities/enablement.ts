/**
 * Capability-group enablement, derived from the install lock (issue #166). The lock's auth
 * snapshots carry `capabilityGroups` (offered) + `selectedCapabilityGroups` (chosen) — exactly
 * parallel to #165's `scopeGroups`/`selectedGroups` — and the generic capability route enforces
 * the union of the owning member's selections PER CALL (same derivation shape as
 * `requiredScopesByProvider`). Because enforcement lives here rather than in a provider token,
 * editing the selection is INSTANT: de-selecting "Create draft bills" cuts the agent off at the
 * next call, with no reconnect and no redeploy.
 *
 * Client-safe: pure functions over lock data, no server imports — the Deployment tab's editor
 * and the capability route's server logic share them.
 */
import type { HarnesstLock, InstallAuth } from "~/marketplace/lock";

/**
 * The capability-group ids currently SELECTED for one auth snapshot: the stored choice filtered
 * to the ids the snapshot offers. An absent `selectedCapabilityGroups` reads as NOTHING enabled
 * (fail closed) — installs always write the field, so absence means the snapshot predates the
 * capability framework or was hand-edited.
 */
export function selectedCapabilityGroupIds(auth: InstallAuth): string[] {
  const offered = auth.capabilityGroups ?? [];
  if (offered.length === 0) return [];
  const valid = new Set(offered);
  return (auth.selectedCapabilityGroups ?? []).filter((id) => valid.has(id));
}

/**
 * The ENABLED capability groups per provider for `member`'s installs: the union of every
 * install's selection (two installs sharing a provider enable the union — same shape as
 * `requiredScopesByProvider`). This is the set the capability route checks per call.
 */
export function enabledCapabilityGroupsByProvider(
  lock: HarnesstLock,
  member: string | null,
): Map<string, string[]> {
  const byProvider = new Map<string, Set<string>>();
  for (const entry of lock.installs) {
    if (entry.member !== member) continue;
    for (const auth of entry.auth ?? []) {
      if (!auth.capabilityGroups || auth.capabilityGroups.length === 0) continue;
      let set = byProvider.get(auth.provider);
      if (!set) {
        set = new Set<string>();
        byProvider.set(auth.provider, set);
      }
      for (const id of selectedCapabilityGroupIds(auth)) set.add(id);
    }
  }
  const result = new Map<string, string[]>();
  for (const [provider, set] of byProvider) result.set(provider, [...set].sort());
  return result;
}

/** One offered capability group with its current selection state (Deployment-tab editor row). */
export interface CapabilityGroupChoice {
  id: string;
  /** Whether ANY of the member's installs currently selects it. */
  selected: boolean;
}

/**
 * The OFFERED capability groups per provider for `member`'s installs, with selection state —
 * deduped by id in first-occurrence order (mirroring `scopeGroupsByProvider`). Ids only; the
 * caller joins labels/descriptions/risk from the capability registry (server-side).
 */
export function capabilityChoicesByProvider(
  lock: HarnesstLock,
  member: string | null,
): Map<string, CapabilityGroupChoice[]> {
  const byProvider = new Map<string, CapabilityGroupChoice[]>();
  for (const entry of lock.installs) {
    if (entry.member !== member) continue;
    for (const auth of entry.auth ?? []) {
      if (!auth.capabilityGroups || auth.capabilityGroups.length === 0) continue;
      const selected = new Set(selectedCapabilityGroupIds(auth));
      let choices = byProvider.get(auth.provider);
      if (!choices) {
        choices = [];
        byProvider.set(auth.provider, choices);
      }
      for (const id of auth.capabilityGroups) {
        const existing = choices.find((c) => c.id === id);
        if (existing) {
          // Two installs sharing a group id: selecting it ANYWHERE keeps it enabled (union).
          existing.selected = existing.selected || selected.has(id);
          continue;
        }
        choices.push({ id, selected: selected.has(id) });
      }
    }
  }
  return byProvider;
}

/**
 * Rewrite the stored capability-group selection for every install owned by `member` that offers
 * groups for `provider` (the Deployment tab's edit) — the exact mirror of `setSelectedGroups`.
 * Each install keeps only the ids its own snapshot offers; other providers/members pass through
 * untouched. Pure; returns a new lock and whether anything changed.
 */
export function setSelectedCapabilityGroups(
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
      if (a.provider !== provider || !a.capabilityGroups) return a;
      // Keep the snapshot's declaration order so the stored choice diffs stably; ids the
      // snapshot doesn't offer are dropped (the caller's list is browser-supplied).
      const next = a.capabilityGroups.filter((id) => selected.includes(id));
      const current = selectedCapabilityGroupIds(a);
      if (
        a.selectedCapabilityGroups !== undefined &&
        next.length === current.length &&
        next.every((id, i) => id === current[i])
      ) {
        return a;
      }
      entryChanged = true;
      return { ...a, selectedCapabilityGroups: next };
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, auth };
  });
  return changed ? { lock: { ...lock, installs }, changed } : { lock, changed };
}
