---
description: Load before creating, changing, or reviewing anything inside an eve agent project — a tool, skill, schedule, subagent, sandbox, channel, connection, eval, instructions.md, agent.ts, package.json, secret, model, or dependency, and before installing anything from the marketplace. Carries eve's filesystem conventions and official docs, plus harnesst's rules on top: how models and secrets are configured, how dependencies are added, how marketplace capabilities are installed, and the checks to run before you finish.
---

# Building eve agents in a harnesst repo

eve is filesystem-first: under an agent's root, the directory a file lives in determines what it is, and identity comes from the path (never a `name`/`id` field). A member's root is `agent/` (single-agent repo) or `agents/<member>/agent/` (team member).

## The framework conventions live in the docs

Consult these before authoring — they're the source of truth and stay current with the installed version:

- Full index: https://eve.dev/docs
- Project layout & the path-naming rule: https://eve.dev/docs/reference/project-layout
- Tools: https://eve.dev/docs/tools · Skills: https://eve.dev/docs/skills · Schedules: https://eve.dev/docs/schedules
- Sandbox: https://eve.dev/docs/sandbox · Connections: https://eve.dev/docs/connections · Subagents: https://eve.dev/docs/subagents · Channels: https://eve.dev/docs/channels/overview
- `agent.ts` config: https://eve.dev/docs/agent-config · TypeScript API (`define*` reference): https://eve.dev/docs/reference/typescript-api

## harnesst's rules on top of the framework

### Models are workspace configuration, never code

Do not write a model string anywhere in an agent project — no `model: '<provider>/<model>'` literals and no provider `.chatModel(...)` calls. Each member root carries a harnesst-generated `harnesst-model.ts` exporting `harnesstAgentModel(agentName)`:

- the member's `agent.ts` uses `model: harnesstAgentModel('<member-name>')` (`import { harnesstAgentModel } from './harnesst-model';`);
- every subagent under `subagents/<name>/agent.ts` uses the **same call with the PARENT member's name** — never the subagent's own name — imported from `'../../harnesst-model'`.

That function resolves the workspace's configured model from harnesst at runtime, so when a human asks to change an agent's model, point them at Org settings (Default model / per-agent overrides) instead of editing files. When you create a new member yourself, copy `harnesst-model.ts` byte-for-byte from an existing member (the file is identical in every project); if the repo has none, have the human add the member through harnesst's Add-member flow (which scaffolds it) rather than inventing model wiring.

### Secrets

Never hardcoded or invented. Read them as `process.env.NAME` inside `execute()`, name them `SCREAMING_SNAKE_CASE`, and tell the human every one they must set (values go on harnesst's Secrets page; harnesst injects them as env at deploy time). Model credentials like `OPENROUTER_API_KEY` are handled by harnesst for deployed agents — never ask for them; they are deliberately absent from your own shell (see the verification note below).

A sandbox shell is sealed by default: the agent's bash sees a secret only after the human marks it "available in the agent's sandbox shell" (a tool's `process.env` is unaffected). When editing an existing `sandbox.ts`, preserve its `HARNESST_SANDBOX_ENV` handling — that's how harnesst forwards the allow-listed secret names into the shell.

### Marketplace capabilities

One path only: browse with `harnesst_catalog`, inspect the template, then call `harnesst_install` with the target member. Never hand-copy catalog files. The installer records `harnesst-lock.json` (without it Deployment cannot render Connect buttons or required secrets), composes bundle includes, merges dependencies, handles required/shared secrets, snapshots auth and capability selections, and installs sandbox setup. `sandbox.bootstrap` is the manifest's install-time setup mechanism: its commands run when eve rebuilds the reusable sandbox template after the change is published and deployed; there is no separate `postInstall` hook.

An install lands as a pending harnesst change-set the human reviews on the Deployment tab — its files will not appear in your checkout until they publish it, so their absence right after a successful `harnesst_install` is expected; never re-create them by hand.

**Installed files are managed, not yours.** `harnesst_project_context` lists every install with the paths it owns; treat those paths as belonging to the template. Don't move, rename, delete, restructure, or hand-edit them, and don't "clean up" copies of them elsewhere — the next update or repair rewrites the canonical paths and your version is left orphaned, usually breaking the build a second time.

When a managed file is itself WRONG — it fails discovery or the build because of what the template shipped, not because of anything in this repo — that is a broken marketplace template, and the fix belongs upstream. Say so plainly and stop: name the file, the template, the installed version, and the exact defect, and tell the human **the template needs to be fixed by an administrator in the marketplace catalog** before it can be reinstalled. Mention `harnesst_project_context`'s `updateAvailable` if a newer version already exists (they can update the install from Settings). Never work around a broken template by editing its files, and never restructure the agent to dodge the error.

### Dependencies

Prefer `fetch()` and Node built-ins — most integrations are one HTTPS call. When a real dependency is justified, add it with `npm install <pkg>` inside the right project directory (the member's own directory in a team repo) so `package.json` and `package-lock.json` update together — never hand-edit the manifests.

### Tools

Keep them small and single-purpose, and handle failure paths with useful error shapes; the model picks a tool by reading its `description`, so make descriptions precise.

### Human and teammate communication

An agent asks a human with eve's built-in `ask_question` — never a tool you write — and delegates with the harnesst-generated `ask-teammate`, which you must never author. Which entry points may safely park, and what the delegation result shapes mean, are in the `talking-to-humans` skill; load it before designing any ask/approval/notify/escalate/delegate behavior.

## Verify natively before you finish

In the project directory you changed, run `npm ci && npm run typecheck --if-present && npm run lint --if-present` (and `npx eve build` if the repo builds), fix what fails, and run again. Don't say you're done while checks fail — harnesst runs the same build as the authoritative gate when the human publishes, so failing checks block the publish anyway.

Your bash shell deliberately has **no model-provider credentials**, so anything that calls a model from the shell — `npx eve` evals, ad-hoc scripts hitting a provider API — fails with a credential/`MODEL_CALL_FAILED` error. That is an environment limitation, not a defect in the code you wrote: don't chase it, don't work around it by moving to another directory, and in your summary report such evals as "not runnable here" rather than as a failure.

For create/build/change/fix requests, follow the `plan-implement-validate` skill through implementation and behavioral checks. A compilation-only check is not enough when the requested behavior can be exercised with evals, skill-load assertions, schedule dispatch, or a running instance.
