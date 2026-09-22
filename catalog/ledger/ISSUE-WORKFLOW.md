# Issue workflow: first version

A human request becomes one ledger feature/bug issue and one finished result for human acceptance. Internal tickets divide implementation; they are not separate human approval units. Each can have its own tests, independent reviews and optionally a PR into the issue branch. The final issue PR targets the default branch and is the only PR attached to the ledger. Existing UAT and engineer merge authorization remain issue-level decisions.

## Roles and human communication

- Intake owns the human conversation: verbatim grill-with-docs, grilling, domain-modeling and to-spec. Keep to-spec here because it explicitly asks the human to confirm the testing seams.
- Researcher answers bounded factual questions for intake. It cannot ask the human.
- Planner executes verbatim to-tickets in its own context and returns its files/decisions to intake. Ticket sizing is delegated; unresolved product decisions go back through intake. Optional triage reference is for incoming requests only.
- Implementer executes verbatim implement and tdd for eligible tickets, sequentially, and owns combined verification and ledger evidence.
- Reviewer executes the entire verbatim code-review procedure. Its standards and spec leaf agents receive the upstream briefs; they do not recursively delegate.
- Defect reviewer checks correctness and security separately; browser QA checks the complete preview.
- Infra deploys the requested commit and checks health; implementer attaches its result.

All introduced subagents have their own sandbox bootstrap and return to their parent. They have no ledger tools. Their sandbox environment forwarding is restricted to GitHub-related entries; they receive no ledger or Cloudflare credentials through that forwarding list. This is not a new sandbox isolation/security boundary.

## Durable records

In the product repository, commit and push:

- `docs/work/<item-id>/spec.md`: complete agreed specification.
- `docs/work/<item-id>/tickets/<NN>-<slug>.md`: one upstream-format brief per internal ticket.
- `docs/work/<item-id>/tickets.json`: dependencies, state and verified revision/evidence.
- `CONTEXT.md` and qualifying ADRs, following the upstream formats.
- `docs/agents/issue-tracker.md`: ledger parent plus repository ticket mapping; domain/readiness configuration supplied with assignments.

The parent ledger specification remains the durable runtime description and identifies the repository specification revision. Intake never sets the code head just because it committed planning documents. Implementer records the branch, final PR and current implementation head.

One issue can contain multiple internal PRs: `ticket/<item-id>/<ticket-id>` branches target `ledger/<item-id>-<slug>`. Internal PRs retain verified commits when integrated. Only the final integration branch matches the ledger GitHub adapter's branch convention. A default-branch merge still requires the existing issue authorization workflow. Constituent PRs and their evidence are linked from the final review packet.

## Explicit adaptations (upstream wording is unchanged)

1. Invocation metadata is archival; incorporated procedures execute on agent assignment. Skill calls resolve to incorporated procedures, shipped references, or the named reviewer subagent.
2. Questions from subagents return to their parent. Intake alone has the human conversation; background human questions use the durable ledger block mechanism.
3. The upstream to-tickets quiz is delegated to intake/planner for internal decomposition. It does not create a human approval for tickets. Missing scope/architecture decisions still require the human.
4. Tickets use versioned `docs/work/` instead of temporary `.scratch`; the ledger is the issue tracker. Setup is supplied configuration, not a user slash-command prerequisite.
5. Implementer commits before invoking review because code-review reads committed diffs. Review runs independently; defects are also checked separately.
6. The parent supplies exact base/head and scope; missing specifications block review. Two leaf reviewers perform the axes directly without recursive delegation.
7. Per-ticket completion is automated verification. Human acceptance is for the integrated issue; existing acceptance and merge gates are preserved.

These exceptions live separately in `agent-bindings/`. They are not permission to paraphrase upstream text.

## Validation and limits

`ticket-plan.mjs` validates a DAG, releases only tickets with verified prerequisites, rejects stale review evidence, and checks all verified commits are ancestors of the final integration head. Unit tests exercise those behaviours and real Git ancestry. It does not authenticate evidence, execute tests, claim distributed work, or enforce permissions. The agent runs it before handing the complete issue to human review; existing backend approval gates remain the authorization boundary.

No ledger schema migration, new actor, new core route, or new human ticket approval is introduced. The new planner is a subagent of intake, avoiding another root credential/installation. A root planner with independently scheduled work and backend-enforced ticket claims would be a separate architecture change.

Catalog validation and composed-source checking prove packaging, not model compliance. Live end-to-end testing must establish that questions reach intake, ticket dependencies are respected, the combined preview is checked, and a requested change returns the whole issue to implementation without generating per-ticket approvals.

## Commands

```
node catalog/ledger/package-agent-procedures.mjs
node catalog/ledger/package-agent-procedures.mjs --check
npm run catalog:index
npm run catalog:validate
node --test catalog/ledger/tests/ticket-plan.test.mjs
npm run typecheck:composed
```

## First-version verification (2026-09-22)

- All 36 vendored files matched the pinned upstream checkout byte-for-byte; the regeneration check validates 143 packaged files.
- Catalog validation passed. Ledger tests: 69 passed, including seven ticket-plan behaviours. Marketplace/subagent route tests: 93 passed.
- Actual Eve builds passed for intake, implementer and infra. Published dev team version 10; all three deployments reached live.
- A read-only intake → planner smoke test produced two pending tickets with the second depending on the first. The planner executed the shipped validator in its own sandbox. Intake rejected two invented requirements and obtained a corrected plan; the corrected JSON passed validation and only ticket 01 was eligible. The response kept human acceptance at issue level. No product repository or ledger work was created by the smoke test.
- This is not yet an end-to-end multi-ticket product build. The independent reviewer stages built successfully but have not been exercised on a product diff by this smoke test.
- The repository-wide composed-source typecheck is blocked by pre-existing Supabase/Deno sources being included in the Node agent matrix (untyped RPC default parameter, TypeScript-extension imports and SDK stub errors). Actual Eve builds and the checks above passed; do not describe the full composed check as passing.
- Adversarial review through Claude Fable was attempted but blocked by the account's Fable usage limit. No independent-review pass is claimed.

This deployment changes agent procedures only. The previously prepared rich May I review-content backend rollout remains separate; this procedure migration does not deploy it or alter pending approvals.
