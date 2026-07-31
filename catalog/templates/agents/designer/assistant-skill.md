---
description: Load when the user asks how the installed Designer agent works, what its Impeccable
  skill does, how its direction cards or sketches behave, how to change its workflow safely, or how
  to update the vendored Impeccable payload.
---

# Designer agent template

Designer is a Front of House website builder with a human-picked design direction:

1. It interviews the user in chat, at most three focused questions per round.
2. It writes and confirms `/workspace/home/PRODUCT.md`.
3. It runs Impeccable's `concept-seed.mjs` direction roll — an external dice roll that assigns which
   direction gets built and deals catalog challengers, because a model's own resonance ranking is
   deterministic and every run would otherwise ship the same concept. Skipping the roll on a new or
   replacement visual world is a contract violation, not a shortcut.
4. It publishes one generated sketch per direction as an image artifact (when a key is configured),
   then emits **one** structured question carrying the assigned direction, up to three challengers,
   a canon exit, and a re-roll. Sketches must be published before the question, because the question
   parks the turn and `publish_artifact` needs a live one.
5. It builds a static HTML/CSS site at `/workspace/home/artifacts/site` carrying the direction
   contract as the first child of `<body>`.
6. It runs the finish pass: batched desktop and mobile screenshots via the included `agent-browser`
   skill, published as image artifacts, a structured review in a fresh eve child session, then a
   documenter child writes `DESIGN.md` plus `.impeccable/design.json`.
7. It runs the pinned Impeccable detector, fixes all findings, and publishes the directory with the
   installed `publish_artifact` tool.
8. Refine requests ("polish it", "bolder", "critique it") route through an intent table in
   `instructions.md` to a single Impeccable reference, then rerun the gate and publish the same
   path, so Front of House adds a version to the existing card. Refining never re-rolls the
   direction; only an explicit request for a different visual world does.

## Direction round mechanics

The upstream skill serves directions from a local HTML decision page (`serve-question.mjs`). That
cannot work in a headless sandbox — the script self-detects and exits 2, which upstream documents as
the fallback rung, never an error. The template sets `IMPECCABLE_QUESTION_DISABLED=1` so it never
tries, and pins the fallback to eve's structured question tool. Card fields (thesis, palette,
materials, first viewport, risk) compress into each option's description; giving every option a
description is what makes Front of House render stacked rows rather than chips.

Re-roll must eliminate every direction already shown, but the answer arrives a turn after the roll,
so the round state persists in `/workspace/home/.impeccable/directions.json` (shown directions, pool,
seed key, consecutive re-roll count). That file is the only reason the elimination rule and the
"after two consecutive re-rolls, ask what quality is missing" rule survive across turns.

## Optional image key

`OPENAI_API_KEY` is declared as an optional sandbox secret. Leaving it blank at install is a
supported path: the wizard plans a skip, the deploy guard's unset-secret warning is overridable, and
the agent serves text-only direction cards with a one-line disclosure. With the key set,
`context.mjs` prints `IMAGE_GEN_AVAILABLE` at session start — that line is the probe — and images
are billed to the user's key at roughly $0.05-0.25 each. `IMPECCABLE_IMAGE_GEN_FAKE=1` gives a
deterministic offline stand-in for evals so tests never bill, and `IMPECCABLE_CONCEPT_SEED` pins the
roll.

## Model and payload

The template suggests `anthropic/claude-sonnet-5`, but the installer can select another model and
harnesst rewrites `agent.ts`. Keep a strong model: the workflow asks the model to interpret a
product interview, derive and defend a visual system, and implement it.

The upstream payload is under `agent/skills/impeccable/`. `VENDORED.md` records its version, commit,
license, transformations, and rebase procedure. The harnesst-specific behavior is isolated in
`reference/designer-v1.md` plus the short priority note near the top of `SKILL.md`. Adjust those two
files (and the routing table in `instructions.md`) when changing the workflow; avoid editing
upstream reference files unless the upstream source itself is being rebased.

When rebasing, start from the `skill/` source directory at the recorded upstream commit, not one of
Impeccable's generated provider directories — except for the files `VENDORED.md` names as
generated-only (the detector engine). Copy the three role bodies from `skill/agents/**` into
`reference/roles/**` as `VENDORED.md` describes, then reapply the transformations listed there.
Review upstream changes to `init.md`, `new-work.md`, `craft-floor.md`, `document.md`, the role files,
and detector scripts against `designer-v1.md`, then bump the template version and sandbox
revalidation key. Keep the npm detector version explicit: the vendored skill and published CLI have
independent versions.

Template-owned files are replaced by marketplace updates. Put customer-specific product truth and
visual decisions in the workspace `PRODUCT.md` and `DESIGN.md`, not in the agent prompt or vendored
skill.
