---
description: Where to find eve's authoring conventions (the official docs) and the harnesst-specific rules layered on top when building tools, skills, schedules, sandboxes, and dependencies in a connected repo.
---

# Building eve agents in a harnesst repo

eve is filesystem-first: under an agent's root, the directory a file lives in determines what it is, and identity comes from the path (never a `name`/`id` field). A member's root is `agent/` (single-agent repo) or `agents/<member>/agent/` (team member).

Consult the eve docs for the framework conventions before authoring — they're the source of truth and stay current with the installed version:

- Project layout & the path-naming rule: https://eve.dev/docs/reference/project-layout
- Tools: https://eve.dev/docs/tools · Skills: https://eve.dev/docs/skills · Schedules: https://eve.dev/docs/schedules
- Sandbox: https://eve.dev/docs/sandbox · Connections: https://eve.dev/docs/connections · Subagents: https://eve.dev/docs/subagents · Channels: https://eve.dev/docs/channels/overview
- `agent.ts`: https://eve.dev/docs/agent-config · `define*` reference: https://eve.dev/docs/reference/typescript-api

## harnesst's rules on top of the framework

- Marketplace capabilities follow one path: browse with `harnesst_catalog`, inspect the template, then call `harnesst_install` with the target member. Never hand-copy catalog files. The installer records `harnesst-lock.json`, composes bundle includes, merges dependencies, handles required/shared secrets, snapshots auth and capability selections, and installs sandbox setup. `sandbox.bootstrap` is the manifest's install-time setup mechanism: its commands run when eve rebuilds the reusable sandbox template after the change is published and deployed; there is no separate `postInstall` hook. An install lands as a pending harnesst change-set the human reviews on the Deployment tab — its files will not appear in your checkout until they publish and merge it, so their absence right after a successful `harnesst_install` is expected; never re-create them by hand.
- Models are workspace configuration, never code: no model strings or provider `.chatModel(...)` calls in any agent file. A member's `agent.ts` uses `model: harnesstAgentModel('<member-name>')` from the harnesst-generated `./harnesst-model`; subagents use the same call with the PARENT member's name (import `'../../harnesst-model'`). Model changes happen in harnesst's Org settings, not in the repo — copy `harnesst-model.ts` verbatim from an existing member when creating a new one.
- Secrets are `process.env.NAME`, `SCREAMING_SNAKE_CASE`, never hardcoded. The human sets values on harnesst's Secrets page; harnesst injects them at deploy time. The sandbox shell is sealed — it only sees names in the `HARNESST_SANDBOX_ENV` allowlist, so preserve that block when editing an existing `sandbox.ts`.
- Prefer `fetch()` + Node built-ins first — most integrations are one HTTPS call. When a dependency is justified, run `npm install <pkg>` in the correct agent project so its manifest and lockfile change together; never hand-edit the lockfile.
- Keep tools small and single-purpose, and handle failure paths with useful error shapes; the model picks a tool by reading its `description`, so make descriptions precise.
- Ground every plan or change in `harnesst_project_context` and the actual git checkout. Make changes in that checkout and use its native npm scripts and `npx eve` commands for verification.
- For create/build/change/fix requests, follow the `plan-implement-validate` skill through implementation and behavioral checks. A compilation-only check is not enough when the requested behavior can be exercised with evals, skill-load assertions, schedule dispatch, or a running instance.
