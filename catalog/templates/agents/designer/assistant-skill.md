---
description: Load when the user asks how the installed Designer agent works, what its Impeccable
  skill does, how to change its workflow safely, or how to update the vendored Impeccable payload.
---

# Designer agent template

Designer is a linear Front of House website builder:

1. It interviews the user in chat, at most three focused questions per round.
2. It writes and confirms `/workspace/home/PRODUCT.md`.
3. It uses the vendored Impeccable skill to choose a direction and build a static HTML/CSS site at
   `/workspace/home/artifacts/site`.
4. It records the built visual system in `DESIGN.md`, runs the pinned Impeccable detector, fixes all
   findings, and publishes the directory with the installed `publish_artifact` tool.
5. Refinements reuse the same directory and publish path, so Front of House adds a version to the
   existing card.

The template suggests `anthropic/claude-sonnet-5`, but the installer can select another model and
harnesst rewrites `agent.ts`. Keep a strong model: the workflow asks the model to interpret a
product interview, derive a visual system, and implement it.

The upstream payload is under `agent/skills/impeccable/`. `VENDORED.md` records its version, commit,
license, transformations, and rebase procedure. The harnesst-specific behavior is isolated in
`reference/designer-v1.md` plus the short priority note near the top of `SKILL.md`. Adjust those two
files when changing the linear workflow; avoid editing upstream reference files unless the upstream
source itself is being rebased.

When rebasing, start from the `skill/` source directory at the recorded upstream commit, not one of
Impeccable's generated provider directories. Reapply the transformations listed in `VENDORED.md`,
review upstream changes to `init.md`, `new-work.md`, `craft-floor.md`, `document.md`, and detector
scripts against `designer-v1.md`, then bump the template version and sandbox revalidation key. Keep
the npm detector version explicit: the vendored skill and published CLI have independent versions.

Template-owned files are replaced by marketplace updates. Put customer-specific product truth and
visual decisions in the workspace `PRODUCT.md` and `DESIGN.md`, not in the agent prompt or vendored
skill.
