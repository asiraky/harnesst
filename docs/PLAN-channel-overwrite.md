# Plan: one-file channel templates, updates overwrite

**Decision (Aaron, 2026-07-29):** stop trying to preserve customer edits to marketplace channel
files. A channel template is one self-contained file; a marketplace update overwrites it. No
platform/customer split for channels, no install-once, no re-export wrapper.

This partially reverses #254's architecture (the `harnesst/` split and install-once preservation)
while keeping the parts that are orthogonal and working: the settings panel, lock-stored settings,
and env projection at deploy.

## Target state

- `catalog/templates/channels/github/files/channels/github.ts` contains the **entire**
  implementation — wake handlers, checkout, park/answer routes, env reading. No
  `files/harnesst/github-channel.ts`, no `installOnce` in the manifest.
- Installed as `agents/<member>/agent/channels/github.ts` (or `agent/channels/github.ts`
  single-agent). One file. An update rewrites it byte-for-byte from the template.
- Settings flow unchanged: Deployment tab panel → `harnesst-lock.json` → `HARNESST_CHANNEL_GITHUB_*`
  env at deploy → the channel file reads `process.env`. Operator settings still survive updates
  (`carriedSettings`, install.server.ts:~740).
- `harnesst/` survives **only** for `model.ts` (org model resolution). The platform hash gate
  keeps guarding that; it simply has no channel files to check anymore.

## Semantics change: what "preserved" means now

Preservation guards **first install only**. On an update, template-shipped paths are the
template's to overwrite — including paths a previous install preserved.

Today's blockers in `app/marketplace/install.server.ts` (~640–700):

1. `installOnceTargets` — template-declared install-once. **Remove the mechanism** (manifest
   field, planner branch, wizard copy). No template will declare it after this change.
2. `previouslyPreserved` stickiness (issue #177) — auto-preserves any path the entry preserved
   before. **Narrow it:** sticky preservation no longer applies to paths the incoming template
   ships as file writes. Those get overwritten on update. It still applies to conflict paths a
   first install registered around (the #177 "register and keep existing files" case only blocks
   or preserves at first-install time; a later **update** overwrites).
   - Consequence, accepted: a customer who chose "keep existing files" at install time and then
     takes an update loses their file to the template version. That is the point: let it overwrite.

Why ivy/sam are stuck today: their `agent/channels/github.ts` sits in `preservedFiles` (written by
the 0.4.0 update's install-once branch), so every future update re-preserves the dead 571-line
file forever. Rule 2 is what breaks that loop — the file is a template path, so the update
overwrites it.

## Work items

### 1. Catalog — fold the implementation back into one file

- Merge `files/harnesst/github-channel.ts` into `files/channels/github.ts`: inline the factory
  body, `export default` the configured channel (keep the answer route composition). Delete
  `files/harnesst/github-channel.ts` and the wrapper content.
- `template.json`: `files: ["channels/github.ts"]`, drop `installOnce`, keep secrets + settings
  panel id. Bump **github 0.6.0 → 0.7.0**, **github-bundle 0.4.0 → 0.5.0**.
- `node catalog/scripts/validate.mjs`; rebuild `catalog/index.json`.

### 2. Installer — overwrite semantics

`app/marketplace/install.server.ts`:

- Delete the install-once branch (~672–678) and `installOnceTargets`; delete `installOnce` from
  `app/marketplace/manifest.ts` and compose handling in `app/marketplace/compose.server.ts`.
- Narrow `previouslyPreserved` per Semantics §2: skip auto-preserve when the path is one of this
  plan's `fileWrites` (template ships it) — it falls through to the normal
  `owned/occupied` logic and, being an update, gets overwritten. Keep auto-preserve for paths the
  template does NOT ship (the entry merely registered around them).
  - Note: a template-shipped path that is occupied but **not** owned and **not** previously
    preserved must still conflict on first install (unchanged behaviour).
- Verify the existing `deletions` logic (~716) stages the removal of
  `agents/<m>/harnesst/github-channel.ts` — it is in `entry.files` for the 0.4.0 entry and absent
  from the 0.5.0 write set, so it should fall out for free. Confirm with a test.
- Lock entry: `preservedFiles` shrinks accordingly; `platformFiles` becomes empty for this
  template (field omitted) — confirm the publish hash gate sees the staged deletion and checks
  nothing (`platformPathsUnderCheck` already drops deleted drafts).

### 3. Tests

`tests/unit/install.test.ts`, `tests/unit/marketplace.test.ts`, `tests/unit/compose.test.ts`:

- Rewrite the issue-254 install-once suite: update **overwrites** an occupied template path,
  including one recorded in `preservedFiles` (the exact ivy/sam state — regression test for this
  migration).
- Update stages a deletion for a previously-owned file the new version no longer ships
  (`harnesst/github-channel.ts`), and the resulting lock entry has no `platformFiles`.
- First-install conflict + "keep existing files" still registers around a non-template path and
  stays sticky; a template-shipped kept path is overwritten by the next update.
- Settings still carried across the update.
- Channel behaviour tests (`github-channel-checkout.test.ts` etc.) repointed at the single file.

### 4. Publish button (separate commit, same PR or its own)

The banner at `app/routes/projects.$projectId.tsx:604` renders only on member pages; the button at
`app/routes/projects.$projectId.deployments.tsx:1142` renders only on non-member pages. Fix:
render `PublishDeploymentButton` at member level too (label copy stays repo-wide-honest), and/or
point the banner's copy at the publish panel. Either way: **no state where a banner references a
button that isn't on screen.**

## Rollout

1. Land the PR (base `main`). CI green. Merge → control-plane image rebuild + deploy (catalog
   ships in the image — the UI cannot offer 0.5.0 before this).
2. In harnesst: project `worksauceapp/agents` → **Update github-bundle to 0.5.0 on Ivy and Sam.**
   Expect per member: `agent/channels/github.ts` overwritten (full implementation),
   `harnesst/github-channel.ts` staged deletion, lock entry updated, settings carried.
3. Publish once (Ivy's staged wake settings ride along), deploy both members.
4. Configure Sam's settings when desired (wake-on-new-issues) — not a blocker for Ivy.
5. Verify: remove + re-add `ready` on marketing-site #20 as a human → Ivy run appears in `runs`,
   turn in container log, branch + PR follow.

## Out of scope (already tracked elsewhere)

- Sam's webhook 401s (secret mismatch on ~half the deliveries).
- Model-module backfill (Quinn/Remy hardcoded models; runbook 3.6).
- Ivy's reconciliation schedule (runbook 3.7).
- The empty `agent` marketplace category.

## Known accepted risks

- Overwrite-on-update is exactly what caused the 27 Jul incident. The difference now: the
  template is generic (wake logic driven by panel settings, not hand-edits), so there should be
  nothing in the file a customer needs to edit. If a customer does edit it, the next update eats
  the edit — accepted "for now" by decision above.
- `docs/RUNBOOK-254.md` steps 3.1/3.2 and the Phase 4 "thin wrapper" checks become stale —
  update the runbook in the same PR.
