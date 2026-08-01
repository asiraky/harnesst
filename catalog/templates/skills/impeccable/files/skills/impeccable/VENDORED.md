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
- `skill/agents/{impeccable-finish-reviewer,impeccable-documenter,impeccable-asset-producer}.md`
  become `reference/roles/{finish-reviewer,documenter,asset-producer}.md`. Their provider
  frontmatter is removed because they are task prompts for eve's built-in `agent` tool, not
  independently discovered agents. The built-in child inherits Designer's instructions and shared
  sandbox, so the root sends the role path and complete task inputs through `message`; the child's
  writes are immediately visible to the root. `asset-producer.md` carries one additional local
  edit: eve transformation 2 below rewrites its `scripts_path` placeholder to the resolved
  `$HOME/...` form used everywhere else in this payload. Upstream's fourth role,
  `manual-edit-applier.md`, is deliberately not vendored: it serves the `live` flow, which Designer
  v1 forbids.

Declared eve subagents are deliberately not authored under `subagents/`: their sandboxes do not
inherit the root sandbox and therefore would not see `/workspace/home`, the built site, or its
screenshots without duplicating sandbox configuration. Designer instead uses eve's root-only
built-in `agent` tool, whose fresh child sessions share the root's sandbox and tools.
`reference/harnesst-v1.md` defines each handoff and the finish reviewer's structured output schema.

Sandbox sharing was rechecked against eve 0.24.2's `execution/subagent-tool.js`: a built-in `agent`
child receives the parent's captured sandbox state and parent sandbox session id. That means the
per-FOH-session subpath mount proposed in harnesst #315 stays the child's mount too; it does not
select a sibling or create a default sandbox. #315 should retain an end-to-end assertion when that
mount lands, because the mount plumbing itself is outside this template.

## Eve transformations

1. Replace the source frontmatter with eve's supported `description` field.
2. Compile the `agents` and `codex` conditional blocks, replace provider placeholders with the
   Codex/structured-question wording, strip upstream rule markers, and resolve `scripts_path` to
   `$HOME/.agents/skills/impeccable/scripts`.
3. Render the script provider marker as `eve` with the Codex command prefix.
4. Strip provider frontmatter from the three vendored `skill/agents/**` role files, store their
   bodies under `reference/roles/**`, and add the eve `outputSchema` note to the finish reviewer.
5. Add the harnesst/eve priority note to `SKILL.md` and add `reference/harnesst-v1.md`.

## Rebase

1. Check out the new upstream commit and copy `skill/reference/**`, `skill/scripts/**`,
   `skill/SKILL.src.md`, the three `skill/agents/**` role files named above, plus these files from
   the generated `.agents/` tree: `scripts/detector/**` and
   `scripts/lib/impeccable-config.mjs`.
2. Reapply the transformations above. Beyond the files named in step 1, do not copy anything else
   from `.agents/`, `.claude/`, `plugin/`, or another generated provider tree.
3. Review changes to `init.md`, `new-work.md`, `craft-floor.md`, `document.md`, the child role
   files, and detector scripts against the adapter. Preserve the mandatory direction roll, the
   single-question direction round, chat HITL, built-in child handoffs, structured finish-review
   output, static preview constraints, final detector ordering, and stable-name publishing.
4. Run the same eve fidelity spike with deterministic concept/palette seeds, an offline catalog,
   fake image generation, and telemetry disabled.
5. Update this file, bump the Impeccable skill version and `sandbox.revalidationKey`, then bump
   Designer's version so its included payload updates; regenerate and validate the catalog index.
