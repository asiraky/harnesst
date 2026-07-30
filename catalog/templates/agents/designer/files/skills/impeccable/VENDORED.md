# Vendored Impeccable

- Upstream: `https://github.com/pbakaus/impeccable`
- Commit: `6b342244e915d64b0d6e84d5eec448fd196ce6bb`
- Skill/plugin version: `4.0.4`
- Runtime detector package: `impeccable@3.5.0`
- License: Apache-2.0; see `LICENSE`

The skill and npm CLI have independent release lines. The version skew above is intentional and is
the pair exercised by the Designer fidelity spike for harnesst issue #293.

## What is vendored

The payload comes from upstream's provider-neutral `skill/` source, not a generated provider
directory:

- `skill/SKILL.src.md` becomes `SKILL.md`
- `skill/reference/**` becomes `reference/**`
- `skill/scripts/**` becomes `scripts/**`
- `.agents/skills/impeccable/scripts/detector/**` and
  `.agents/skills/impeccable/scripts/lib/impeccable-config.mjs` become `scripts/detector/**` and
  `scripts/lib/impeccable-config.mjs` — the bundled detector engine is only present in upstream's
  generated provider trees, not in `skill/`, and `scripts/detect.mjs` (which the references invoke
  mid-build) errors without it. It is self-contained node code, byte-identical to upstream.

Upstream subagent definitions are not included. Designer v1 runs a linear eve workflow and performs
its bounded finish/documentation passes in the main agent. `reference/designer-v1.md` is the local
adapter that defines that workflow.

## Eve transformations

1. Replace the source frontmatter with eve's supported `description` field.
2. Compile the `agents` and `codex` conditional blocks, replace provider placeholders with the
   Codex/structured-question wording, strip upstream rule markers, and resolve `scripts_path` to
   `$HOME/.agents/skills/impeccable/scripts`.
3. Render the script provider marker as `eve` with the Codex command prefix.
4. Add the Designer v1 priority note to `SKILL.md` and add `reference/designer-v1.md`.

## Rebase

1. Check out the new upstream commit and copy `skill/reference/**`, `skill/scripts/**`,
   `skill/SKILL.src.md`, plus the detector engine from the generated tree:
   `.agents/skills/impeccable/scripts/detector/**` and
   `.agents/skills/impeccable/scripts/lib/impeccable-config.mjs`.
2. Reapply the transformations above. Beyond the detector engine files in step 1, do not copy
   anything else from `.agents/`, `.claude/`, `plugin/`, or another generated provider tree.
3. Review changes to `init.md`, `new-work.md`, `craft-floor.md`, `document.md`, and detector scripts
   against the linear adapter. Preserve chat HITL, static preview constraints, final detector
   ordering, and stable-name publishing.
4. Run the same eve fidelity spike with deterministic concept/palette seeds, an offline catalog,
   fake image generation, and telemetry disabled.
5. Update this file, the template version, and `sandbox.revalidationKey`; regenerate and validate
   the catalog index.
