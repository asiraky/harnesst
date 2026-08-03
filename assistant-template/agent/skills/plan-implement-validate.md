---
description: Plan, implement, and behaviorally validate requests to create, build, change, or fix an eve agent in its connected repository.
---

# Plan, implement, and validate

Use this workflow for every request to create, build, change, or fix an eve agent. A plan is a working checklist that you execute; handing off a plan is not the finished result.

## 1. Ground the work

Before offering a plan, suggestion, or change:

1. Call `harnesst_project_context`.
2. In the checkout harnesst provided, use bash to inspect `pwd`, `git status`, the repository tree, and the relevant `package.json` files.
3. Read the target agent's `instructions.md`, configuration, and the nearest examples of the tools, skills, schedules, evals, or other files you may change.
4. Reconcile the single-agent or team roots returned by `harnesst_project_context` with the directories on disk. Work from the target member's project root.

If a grounding tool or checkout inspection fails, report exactly what failed. Do not fabricate paths, files, conventions, or current behavior.

## 2. Decide and keep a working plan

Ask one focused question only when a material ambiguity would lead to meaningfully different builds. Otherwise make the smallest reasonable decision and proceed.

Keep an exact checklist covering the files and behavior to change, static checks, runtime discovery, behavioral evals, schedule checks when relevant, and any possible deployed smoke test. Update and execute the checklist as the work progresses; do not present it as the final deliverable.

### Fixing a reported failure

When the request is a specific error — a failed build, a failed publish, a stack trace — the error names the cause. Say what the root cause is before you change anything, then make the smallest change that removes it. An error about one key in one file is one edit.

Stop and ask first if the fix you are considering would move, rename, or delete files, restructure directories, or sweep the repository for related cases. Those are separate requests, not part of fixing the reported error. And check `harnesst_project_context` for whether the failing file belongs to a marketplace install before touching it — a template-owned file that is wrong is an upstream problem to report, not a file to repair (see the `building-eve-agents` skill).

Lead your summary with the diagnosis, then the change you made.

## 3. Implement in the checkout

Edit the real connected checkout, following the installed eve version, the official https://eve.dev/docs documentation, and nearby project patterns. Preserve existing behavior outside the request.

- Never hardcode or invent secrets. Read named secrets through `process.env` inside execution paths and report which names the human must configure.
- Prefer platform APIs and existing dependencies. When a package is justified, run `npm install <pkg>` in the correct project root so `package.json` and the lockfile stay synchronized.
- Preserve the repository's package manager, scripts, team layout, and `HARNESST_SANDBOX_ENV` handling.

## 4. Validate in layers

Tailor the checks to the changed behavior. Fix failures caused by the change and keep useful project-specific eval artifacts in the repository.

### Static baseline

From every changed agent project root, run:

```sh
npm ci
npm run typecheck --if-present
npm run lint --if-present
npx eve build
```

Record commands and outcomes, but do not treat compilation alone as behavioral proof.

### Runtime discovery

Start the local instance with `npx eve dev`. Query `GET /eve/v1/health` and `GET /eve/v1/info` (or use the equivalent `eve/client` APIs), then verify that changed skills, schedules, and tools appear in the discovered runtime metadata. Capture the relevant response evidence and stop the dev process when finished.

### Behavioral evals

Create or update project-specific eval files under the app-root `evals/` using `eve/evals`. Add `evals.config.ts` with `defineEvalConfig` when the project needs configuration, and define behavior with `defineEval`.

- Use `t.send(...)` to simulate a user turn and assert relevant content or `calledTool` results.
- Use multiple `t.send(...)` calls in one test for feedback loops and conversational behavior that depends on prior turns.
- Use `t.loadedSkill(...)` to verify that a changed skill actually triggers and loads.
- Add content, tool-call, and other assertions that observe the requested outcome rather than merely checking that the agent answered.
- For LLM-as-judge assertions, import `harnesstAgentModel` from `../harnesst/model` in
  `evals/evals.config.ts` and set `judge: { model: harnesstAgentModel('<exact-member-name>') }`.
  Use that same model value for any per-eval or per-assertion override. Never use a provider/model
  string for a judge: Eve routes model strings through a separate provider gateway that does not
  carry harnesst's project-scoped authorization, so the run will be reported as incomplete.

Run the suite with `harnesst_run_eval`, passing the exact target member from
`harnesst_project_context` and the conversation id in the current checkout path. This is the only
supported model-backed eval path from the embedded assistant: it evaluates the unpublished
checkout through a disposable target and returns structured stdout/stderr, assertion status,
scores, session and artifact identities, checkout identity, exact configured model, authorization
limits, and cleanup state. Any skipped eval is returned as incomplete evidence, not success. Do not
replace it with `npx eve eval` in bash or expose model/provider secrets to the checkout.

If the tool specifically rejects a direct-provider model, report that credential-safe eval
brokering is not available for that provider and name the configured alternative it gives. Do not
turn that into a generic `MODEL_CALL_FAILED`, and do not work around it with a raw API key.

### Schedules

For a changed cron or schedule, first confirm its ID and registration in `GET /eve/v1/info`. Trigger one dev-only execution with `POST /eve/v1/dev/schedules/<id>`. Inspect the returned session ID and its stream, plus any observable effect the schedule is meant to produce. Record both registration and one-shot execution evidence.

### Deployed smoke test

Only test a deployment when its URL and credentials are available **and** it contains the change being validated. Check its health and info endpoints, then run deterministic, non-judge evals against it when they need no local model credential:

```sh
npx eve eval --url <url>
```

Model-backed validation of the unpublished checkout still goes through `harnesst_run_eval`.

If there is no connected live repository, deployable changed instance, URL, or required credential, state the exact untested flow and the setup needed to exercise it. Never imply that local or static success proves a deployed behavior you could not run.

## 5. Finish with evidence

Summarize what was implemented, the validation commands and behavioral evidence, any required secret or setup names, and the exact live flows that remain untested. Keep the result useful to the human reviewing and deploying the checkout.
