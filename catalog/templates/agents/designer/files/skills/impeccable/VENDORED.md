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
- `.agents/skills/impeccable/reference/degraded/{finish-reviewer,documenter,asset-producer}.md`
  become `reference/degraded/**` — same precedent as the detector engine. Upstream compiles these
  inline-substitute variants from `skill/agents/**` at build time, so `skill/reference/` has no
  `degraded/` directory, yet `new-work.md` and `visualize.md` link them as relative paths and eve
  has no subagents, which makes them the only way to run those roles. `finish-reviewer.md` and
  `documenter.md` are byte-identical to upstream and identical across the `.agents/` and `.claude/`
  trees. `asset-producer.md` carries one local edit: eve transformation 2 below rewrites its
  hardcoded `.agents/skills/impeccable/scripts/embed-prompt.mjs` path to the resolved
  `$HOME/...` form used everywhere else in this payload. Upstream's fourth degraded file,
  `manual-edit-applier.md`, is deliberately not vendored: it serves the `live` flow, which Designer
  v1 forbids.

Upstream subagent definitions (`skill/agents/**`) are not included. Designer v1 runs an eve workflow
with no subagents and performs its direction, finish, documentation, and sketch passes in the main
agent, driven by the degraded inline-substitute files above. `reference/designer-v1.md` is the local
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
   `skill/SKILL.src.md`, plus these files from the generated `.agents/` tree:
   `scripts/detector/**`, `scripts/lib/impeccable-config.mjs`, and
   `reference/degraded/{finish-reviewer,documenter,asset-producer}.md`.
2. Reapply the transformations above. Beyond the files named in step 1, do not copy anything else
   from `.agents/`, `.claude/`, `plugin/`, or another generated provider tree.
3. Review changes to `init.md`, `new-work.md`, `craft-floor.md`, `document.md`, the degraded role
   files, and detector scripts against the adapter. Preserve the mandatory direction roll, the
   single-question direction round, chat HITL, static preview constraints, final detector ordering,
   and stable-name publishing.
4. Run the same eve fidelity spike with deterministic concept/palette seeds, an offline catalog,
   fake image generation, and telemetry disabled.
5. Update this file, the template version, and `sandbox.revalidationKey`; regenerate and validate
   the catalog index.
