# Designer v1: product interview to published static site

This adapter owns the Designer agent's ordinary workflow. It narrows the broader Impeccable skill
to one Front of House path. Where another reference conflicts with this file, follow this file.

## 1. Establish the workspace

Work from `/workspace/home`. The durable files are:

- `PRODUCT.md` for confirmed product truth;
- `DESIGN.md` and `.impeccable/design.json` for the visual system derived from the finished build;
- `artifacts/site/index.html` plus local CSS, JavaScript, fonts, and images for the preview;
- `.impeccable/sketches/` for direction sketches;
- `.impeccable/directions.json` for the direction-round state described in section 3.

Run `node $HOME/.agents/skills/impeccable/scripts/context.mjs --target artifacts/site/index.html`
once at the start of the session. Do not rerun it later in the same session. Its output is also
the image-generation probe: it prints an `IMAGE_GEN_AVAILABLE:` line when and only when
`OPENAI_API_KEY` is set in this sandbox. Absence of that line means image generation is off; that
is a configuration fact to disclose, never an error to retry or an install to attempt.

The root session receives eve's built-in `agent` tool by default. Each call starts a fresh copy of
Designer with no parent conversation history, but with the same instructions, tools, credentials,
and sandbox; a child's writes under `/workspace/home` are immediately visible to the root. Every
role message must therefore name its file under `reference/roles/`, tell the child that the role
overrides the ordinary Designer workflow for this task, and carry every task input. Do not author
declared subagents: their sandbox would fall back to the framework default instead of inheriting
this workspace.

If an `agent` call actually fails, run that one role inline from the same role file and disclose the
exact failure. A successful child pass needs no degradation disclaimer. Never choose the inline
path merely to save a call.

## 2. Interview and confirm product truth

When `PRODUCT.md` is missing or the user is starting a different product, read `init.md` and follow
its product-truth schema. Ask at most three focused questions per round through eve's structured
question tool when available. Ask about users, their job, the product's mechanism, constraints,
evidence, and the action the site should earn. Do not ask for colors, fonts, styles, or aesthetic
lanes.

Write `PRODUCT.md`, summarize what it says, and ask the user to confirm or correct it. End the turn
there. Do not design before confirmation.

If a confirmed `PRODUCT.md` already matches the request, do not reopen settled questions. The
direction roll in section 3 refuses to run without `PRODUCT.md` (`NO_PRODUCT_MD`, exit 1), so this
ordering is mechanical, not a preference.

## 3. Roll the direction and serve the choice

After confirmation, read `new-work.md` for its product-truth, visitor-mode, direction, composition,
and honesty rules. The page is normally Persuade mode. Run this section only when the session calls
for a new or replacement visual world. Refining an existing site never re-rolls direction; see
section 6.

### 3.1 Shortlist and roll

Derive the shortlist `new-work.md` requires: the mechanism, the audience scene, the cultural home,
what the surface must prove, and the rut to avoid, then seven concrete visual systems ordered by
resonance and spanning at least three material families. Then run the roll:

```bash
node $HOME/.agents/skills/impeccable/scripts/concept-seed.mjs --scope direction --mode <mode>
```

This step has no substitute and no skip condition: on a new or replacement world, writing artifact
code before this script has run and its assignment is acknowledged is a contract violation,
whatever the harness, the model, or the time pressure.

Acknowledge the assigned index against your ordered list before anything else, and keep the seed
key the script printed — the direction contract in section 4 has to carry it, and the finish review
in section 7 checks for it.

Fuse each dealt challenger before judging it: the challenger supplies the form and its system
grammar, the product supplies every fact, and clarity wins conflicts. Weigh fused challengers
against the assignment on exactly two axes, audience identification and product clarity.

### 3.2 Deal the hand

The hand is the assigned direction, at most three challengers, and the canon exit. Extra
challengers wait in the re-roll pool, noted in one line. Dropping a challenger from the hand
requires a named product-truth failure, disclosed in the reply.

Give every card the same anatomy: thesis, palette, materials, first viewport, honest risk, and the
challenger's case line. The canon card is the category standard played straight, authored with the
same anatomy. Never recommend canon, never weigh it against the roll, never let it soften the
dealt directions.

### 3.3 Serve the choice through eve, not the decision page

`serve-question.mjs` cannot run here: this sandbox is headless, so the script exits 2, and
`IMPECCABLE_QUESTION_DISABLED` is set so it never tries. Exit 2 is the documented fallback rung,
never an error to retry. Designer v1 pins that rung to eve's structured question tool.

Emit **exactly one** structured question for the whole round. A human's answer resolves every
pending ask on the session, so a second question in the same turn loses one of them. Shape it as:

- a `select` display with free-form answers allowed — free text is the steer channel;
- a self-contained prompt naming the surface, the mode, whether the roll ran degraded, and the
  sketch artifact names when section 5 published any;
- one option per card, in reading order: assigned first, then the hand, then `canon`, then
  `reroll`.

Each option carries an id, a label, and a description. The card fields have no separate slots in
this UI, so compress them into the description: thesis first, then palette as text chips,
materials, first viewport, and the honest risk. Every option having a description is what makes
Front of House render the round as stacked rows instead of chips, which is the layout this decision
needs.

Use stable ids: `assigned`, `challenger-1`…`challenger-3`, `canon`, `reroll`.

### 3.4 Honor the answer

- A card id is the choice. Record it and build it.
- `reroll` re-runs `concept-seed.mjs` with `--from <seedKey from directions.json> --reroll <n>`,
  where `n` is `rerollCount + 1`, and deals a fresh hand. The `--from` key is not optional: the
  script eliminates prior rounds by recomputing what rounds 0..n-1 drew from that one base key, so
  omitting it mints a new random key and re-deals directions you already showed. Re-roll eliminates
  every direction already shown, grounded and challenger alike, and eliminated directions may not
  return reworded. After two consecutive re-rolls, ask what quality is missing before dealing again.
- `canon` is the standing exit. Ask once for two or three products it should sit alongside, make
  their craft level the bar, execute at full fidelity without irony, and record the standing
  preference as a brand commitment in `PRODUCT.md`.
- Free text is a steer. Acknowledge it in your own words, apply it to the chosen or assigned
  direction, and say what you changed because of it. A user- or brief-pinned direction beats the
  roll, always.
- No answer at all: proceed unattended with the assigned direction and state the assumptions.

You may re-roll on your own only on named factual grounds, when the assigned direction cannot carry
the product's truth or task. Taste is never grounds.

### 3.5 Elimination bookkeeping across turns

The answer arrives in a later turn than the roll, so the round state has to live on disk. Maintain
`/workspace/home/.impeccable/directions.json`:

```json
{
  "surface": "artifacts/site/index.html",
  "mode": "persuade",
  "seedKey": "<key concept-seed printed>",
  "rerollCount": 0,
  "consecutiveRerolls": 0,
  "shown": ["<direction label>"],
  "pool": ["<unshown challenger label>"],
  "chosen": null
}
```

Write it before emitting the question and update it on every answer. `seedKey` is the base key of
the whole round chain: write it once from the first roll and never overwrite it, because every
re-roll passes it back as `--from` and a re-rolled round prints the same key. `shown` accumulates
every direction ever served in this workspace, assigned and challenger alike; a new hand must
contain none of them, and if one repeats anyway the `--from` key was lost — say so rather than
quietly dropping the card. Bump `rerollCount` and `consecutiveRerolls` on a re-roll, reset
`consecutiveRerolls` to zero on any other answer — that counter is what triggers the "what quality
is missing" question, and `rerollCount` is the `<n>` the next `--reroll` needs.

### 3.6 Degraded roll

`concept-seed.mjs` resolves its catalog from a local directory, then one GET to
`https://impeccable.style/api/roll`, then a degraded assignment-only mode. Degraded still assigns an
index — the anti-argmax mechanism survives — but deals no challengers. When the script reports a
degraded source, serve a single text-only card plus `reroll` and `canon`, and say plainly in the
prompt that the catalog was unreachable and this round is assignment-only. Do not present a
one-card round as if it were a full hand.

## 4. The direction contract

After the choice lands, write the direction contract `new-work.md` requires: an HTML comment of at
most 150 words, placed as the first child of `<body>`, with the five blocks `THESIS`, `OWN-WORLD`,
`STORY`, `FIRST VIEWPORT`, and `FORM`. `FORM` names the chosen form, its position on your ordered
list, and the seed key the roll printed. Close it with this line verbatim:

```text
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
```

Grep the built output for the seed key before publishing; a contract that does not survive into the
published HTML is not a contract.

Immediately before writing or editing page files, read `craft-floor.md`. Build a complete, styled,
responsive site, not a scaffold.

## 5. Direction sketches

Sketches are optional and depend on `OPENAI_API_KEY`. They exist so the user chooses with their
eyes as well as the theses.

**Sequencing matters.** A structured question parks the turn, and `publish_artifact` needs a live
turn, so every sketch must be generated and published **before** the question of section 3.3 is
emitted. A publish attempted after the park has no live turn and is refused.

When the `IMAGE_GEN_AVAILABLE` line from section 1 was present:

1. Emit one built-in `agent` call per card in the same response so eve runs them concurrently. Give
   each child a non-overlapping output path and this complete packet: tell it to read
   `reference/roles/asset-producer.md` and follow only its **Decision Sketches** role; include
   `PRODUCT.md`, the card's structured fields, the shared frame, the real product name and headline,
   and its `.impeccable/sketches/<slug>.webp` output path. The shared frame is the requested
   surface's first viewport, flat matte, deliberately unfinished, no photorealism, no gloss,
   identical framing, and an aspect following the surface. Everything except the real product name
   and one real headline is greeked. Each child generates immediately with:

   ```bash
   node $HOME/.agents/skills/impeccable/scripts/generate-image.mjs \
     --prompt-file <brief> --out .impeccable/sketches/<slug>.webp
   ```

2. Wait for every child result, then verify each reported path exists. Children write the files;
   only the root publishes them.
3. Publish each finished sketch with `publish_artifact`, `kind: "image"`, using stable names so a
   re-roll versions the existing card instead of spamming new ones: `sketch-assigned.webp`,
   `sketch-challenger-1.webp` … `sketch-challenger-3.webp`, `sketch-canon.webp`. Keep the extension
   identical between rounds; a name change splits one card into two.
4. Name the sketches in the question's prompt so the user knows which card is which.
5. Say once, before the first render, that images are billed to the configured OpenAI key.

Two degraded paths, both disclosed rather than blocking:

- **No key.** Skip generation entirely. Serve the text-only cards and say in one line that sketches
  are off because no image key is configured. Per `new-work.md`, that round is complete, not a
  lesser version.
- **Generation fails mid-batch.** Publish the sketches that rendered, serve the whole hand anyway,
  annotate the cards that have no sketch in their description, and disclose the exact child or
  generation failure. Never drop a direction because its picture failed.

Do not regenerate a sketch for a card that has not changed; a re-roll generates only for new cards.

`IMPECCABLE_IMAGE_GEN_FAKE=1` produces a deterministic offline stand-in at `$0.00`; it is for evals
and CI, and its output is PNG bytes whatever the extension.

A sketch answers which world, never which composition. Do not enter the comp flow.

## 6. Refine, evaluate, and enhance an existing site

When a published site already exists and the user asks to sharpen it, route the request to the one
reference that owns it. `instructions.md` carries the intent table. The invariants:

- **Refine never re-rolls direction.** Polish, bolder, quieter, distill, harden, onboard, animate,
  colorize, typeset, layout, delight, overdrive, clarify, adapt, and optimize all preserve the
  committed world. Only an explicit request for a different look — a replacement visual world — is
  a new-work trigger, and that means section 3 from the top, including the roll.
- **Re-read the direction contract before editing.** It is the drift guard: the comment in `<body>`
  states what this world promised, and a refine pass that contradicts it is drift, not refinement.
  Say so instead of quietly overwriting it.
- **Load `craft-floor.md` immediately before editing UI**, after the scope is settled, and build
  without announcing the checklist. Do not load it for planning-only work.
- **Scope stays tight.** Refine commands edit the existing `artifacts/site` directory. They do not
  add pages, restyle neighbors, or migrate the site to a new idea.
- **One detector pass per cycle.** Section 8's gate is that pass; do not add another.
- For `critique.md`, use eve's built-in `agent` tool. Emit Assessment A and Assessment B as two calls
  in the same response, each with a message naming `critique.md`, the assessment letter, target
  paths, and every input that assessment requires. Say explicitly: perform only the named
  assessment and its return contract; do not run critique orchestration, synthesis, persistence, or
  call `agent`. They run concurrently in isolated child histories and share the screenshots and
  built files. Merge their results only after both return. Do not print a degraded banner when both
  children succeed. If a call fails, run only that assessment inline and use `critique.md`'s banner
  with the exact failure reason.

An ambiguous ask gets the menu instead of a guess: name the two or three highest-value commands for
what is on screen, with one line of reason each, and let the user pick. Never auto-run a command the
user did not ask for.

## 7. Finish pass

The finish pass runs at the end of a build and at the end of any refine cycle that changed the
page. It is one batched round, with a ceiling of two rounds total, and fixes batch between them.

### 7.1 Screenshots

Serve the built site over localhost rather than `file://`, then capture desktop and mobile in the
same round with the `agent-browser` skill installed alongside this one. The sandbox is a Node image
with no Python, so serve it with `http-server`, which the bootstrap installs globally:

```bash
http-server artifacts/site -p 8080 --silent &
agent-browser open http://localhost:8080
agent-browser screenshot /workspace/home/agent-browser/screenshots/screenshot-desktop.png
agent-browser close --all
```

Kill the server when the round is done. Take the mobile capture at a phone viewport in the same
round. Publish both with `publish_artifact`, `kind: "image"`, under the stable names
`screenshot-desktop.png` and `screenshot-mobile.png`, so later rounds version the same two cards.
Publish them while the turn is still live.

If `agent-browser --version` or `http-server --version` fails, the sandbox bootstrap did not take
effect. Do not install anything. Report the failure, then run the review from the files with a
one-line disclosure that the reviewer worked without screenshots — that is a real reduction in what
it could check.

### 7.2 Fresh finish review

Call the built-in `agent` tool with a message that tells the child to read
`reference/roles/finish-reviewer.md`, adopt only that role for this task, and never edit. Hand it
every input its contract names: the original request, confirmed answers, artifact path, both
screenshot paths, direction contract, `PRODUCT.md` path, existing detector findings, QUALITY BAR
card and approved comp paths when present, and `reference/craft-floor.md`. The child can read all of
them directly because it shares `/workspace/home`.

Set `outputSchema` on the call to this schema:

```json
{
  "type": "object",
  "properties": {
    "disposition": {
      "type": "string",
      "enum": ["rebuild", "fix", "ship"]
    },
    "missing_inputs": {
      "type": "array",
      "items": { "type": "string" }
    },
    "persistence": { "type": "string" },
    "fidelity": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "element": { "type": "string" },
          "status": {
            "type": "string",
            "enum": [
              "match",
              "adaptation",
              "missing",
              "contradicted",
              "added without approval"
            ]
          },
          "evidence": { "type": "string" }
        },
        "required": ["element", "status", "evidence"],
        "additionalProperties": false
      }
    },
    "ceiling": { "type": "string" },
    "material_fixes": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 8
    },
    "keep": { "type": "string" }
  },
  "required": [
    "disposition",
    "missing_inputs",
    "persistence",
    "fidelity",
    "ceiling",
    "material_fixes",
    "keep"
  ],
  "additionalProperties": false
}
```

Treat the structured tool result as the reviewer's contract and obey it without softening:

- report the `disposition` word verbatim — `rebuild`, `fix`, or `ship`;
- its contract check verifies `FORM` carries the seed key the roll printed; a contract with no seed
  key means the roll was skipped, and that is a material fix ahead of every craft point;
- apply `material_fixes` in order, recapture, and run the file's **Verdict Pass** to score them;
  unresolved or partial material findings can never recompute to `ship`;
- a rebuild directive short-circuits the patch list — do not launder it into a fix list;
- do not run a second detector pass here.

After applying a fix batch and recapturing, call a fresh child with the same role path, the original
review object, the new screenshot paths, and an instruction to run only its **Verdict Pass**. Use
this `outputSchema`:

```json
{
  "type": "object",
  "properties": {
    "verdict": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fix": { "type": "string" },
          "status": {
            "type": "string",
            "enum": ["resolved", "partial", "unresolved"]
          },
          "evidence": { "type": "string" }
        },
        "required": ["fix", "status", "evidence"],
        "additionalProperties": false
      }
    },
    "remaining": {
      "type": "array",
      "items": { "type": "string" }
    },
    "regressions": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 3
    },
    "disposition": {
      "type": "string",
      "enum": ["rebuild", "fix", "ship"]
    }
  },
  "required": ["verdict", "remaining", "regressions", "disposition"],
  "additionalProperties": false
}
```

Two rounds is the budget. When the budget is spent with findings open, say what remains open rather
than continuing to polish.

### 7.3 Documentation

After the review, call the built-in `agent` tool with a message that tells the child to read
`reference/roles/documenter.md`, adopt only that role, and follow `document.md` exactly for format,
token schema, sidecar, and section order. Pass the project root, artifact path, direction contract,
`PRODUCT.md`, `reference/document.md`, the boundary to write at, and any existing `DESIGN.md`. The
child writes `DESIGN.md` and `.impeccable/design.json` directly into the shared sandbox from the
built result, never from what was planned. Never canonize a craft-floor refusal into the system.

On a new world `DESIGN.md` is written after the review, so its absence during the review is not a
finding.

## 8. Detector gate

Run the final gate before every publish:

```bash
npx impeccable@3.5.0 detect --json artifacts/site
```

Exit 0 is clean. Exit 2 means findings: fix all of them, update `DESIGN.md` if the fix changes the
system, and rerun the detector. Do not publish while findings remain. Detector installation or
execution failure is also a failed gate; report it plainly instead of claiming a clean run.

Report what the detector found and what you fixed in the reply.

## 9. Publish

Call `publish_artifact` for the site only after the final detector exits 0:

- `path`: `artifacts/site`
- `kind`: `html`
- `title`: a short product/site title

Mention the published page in the reply. There is no page URL to quote; the user opens its card in
Front of House.

Image artifacts published by sections 5 and 7 use `kind: "image"` and their own stable names.
Artifact identity is the file's base name, so a republish under the same name versions the existing
card and a renamed file creates a competing one. An artifact's kind is pinned for its life.

For later refinements, edit the same `artifacts/site` directory, update documentation when the
visual system changes, rerun the gate, and publish the same path. That updates the existing card as
a new version instead of creating a competing artifact.

## 10. Preview constraints

The preview is network-isolated. It must not require a CDN, remote font, remote image, form
submission, `fetch`, or XHR. Inline data into HTML. Local sibling stylesheets, scripts, fonts, and
images are allowed. Keep the bundle to at most 40 regular files with plain names and supported web
extensions; do not use symlinks or hidden files inside `artifacts/site`.

Do not enter visualize, live-browser, comp-approval, or subagent flows. Browser use in this agent is
limited to the batched finish capture in section 7.
