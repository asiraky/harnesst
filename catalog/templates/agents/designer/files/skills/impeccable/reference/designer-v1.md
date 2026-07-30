# Designer v1: product interview to published static site

This adapter owns the Designer agent's ordinary workflow. It narrows the broader Impeccable skill
to one Front of House path. Where another reference conflicts with this file, follow this file.

## 1. Establish the workspace

Work from `/workspace/home`. The durable files are:

- `PRODUCT.md` for confirmed product truth;
- `DESIGN.md` and `.impeccable/design.json` for the visual system derived from the finished build;
- `artifacts/site/index.html` plus local CSS, JavaScript, fonts, and images for the preview.

Run `node $HOME/.agents/skills/impeccable/scripts/context.mjs --target artifacts/site/index.html`
once at the start of the session. Do not rerun it later in the same session.

## 2. Interview and confirm product truth

When `PRODUCT.md` is missing or the user is starting a different product, read `init.md` and follow
its product-truth schema. Ask at most three focused questions per round through eve's structured
question tool when available. Ask about users, their job, the product's mechanism, constraints,
evidence, and the action the site should earn. Do not ask for colors, fonts, styles, or aesthetic
lanes.

Write `PRODUCT.md`, summarize what it says, and ask the user to confirm or correct it. End the turn
there. Do not design before confirmation.

If a confirmed `PRODUCT.md` already matches the request, do not reopen settled questions.

## 3. Choose and build

After confirmation, read `new-work.md` for its product-truth, visitor-mode, direction, composition,
and honesty rules. The page is normally Persuade mode. Designer v1 makes these adaptations:

- choose the strongest direction yourself; do not serve direction cards or wait for aesthetic
  approval;
- use `concept-seed.mjs --scope direction --mode <mode>` and honor its assigned direction;
- do not enter visualize, live-browser, image-approval, or subagent flows;
- use the fake image generator only when `IMPECCABLE_IMAGE_GEN_FAKE=1`; otherwise a v1 site should
  prefer authored CSS/SVG/interface material over an external image dependency.

Immediately before writing or editing page files, read `craft-floor.md`. Build a complete, styled,
responsive site, not a scaffold. Put the direction contract required by `new-work.md` in the HTML.

The preview is network-isolated. It must not require a CDN, remote font, remote image, form
submission, `fetch`, or XHR. Inline data into HTML. Local sibling stylesheets, scripts, fonts, and
images are allowed. Keep the bundle to at most 40 regular files with plain names and supported web
extensions; do not use symlinks or hidden files inside `artifacts/site`.

## 4. Document and gate

Inspect the result in one bounded desktop/mobile pass when a browser is available. When it is not,
check document structure, responsive rules, overflow risks, focus states, reduced-motion behavior,
and the rendered page through a local server. Apply one material fix batch.

Read `document.md` and write `DESIGN.md` plus `.impeccable/design.json` from the built result in the
main agent. Do not spawn upstream finish-reviewer or documenter subagents.

Then run the final gate:

```bash
npx impeccable@3.5.0 detect --json artifacts/site
```

Exit 0 is clean. Exit 2 means findings: fix all of them, update `DESIGN.md` if the fix changes the
system, and rerun the detector. Do not publish while findings remain. Detector installation or
execution failure is also a failed gate; report it plainly instead of claiming a clean run.

## 5. Publish

Call `publish_artifact` only after the final detector exits 0:

- `path`: `artifacts/site`
- `kind`: `html`
- `title`: a short product/site title

Mention the published page in the reply. There is no page URL to quote; the user opens its card in
Front of House.

For later refinements, edit the same `artifacts/site` directory, update documentation when the
visual system changes, rerun the final gate, and publish the same path. That updates the existing
card as a new version instead of creating a competing artifact.
