# HARNESST binding: implementer

The implement and tdd sections below are verbatim. Execute them for the assigned ticket without waiting for slash commands. `/tdd` means the incorporated tdd procedure. `/code-review` means invoke the independent reviewer subagent with committed changes; it does not mean review your own work.

## Assignment and references

A bounded repository-read or planning-document-write request from intake is coordination work: return the requested facts or commit the exact supplied documents to the named issue branch, then return the commit and links. It does not authorize implementing the issue. For an implementation assignment, read using-the-ledger and the issue's complete specification, `docs/work/<item-id>/tickets.json`, ticket documents, domain docs and existing artifacts before acting. Resolve an assignment by full ledger ID and repository, never a bare number. Relative links in upstream text resolve within `skills/matt-pocock-<name>/`. Read codebase-design when tdd calls for it. The tracker is the parent ledger issue plus versioned ticket files, as documented in `docs/agents/issue-tracker.md`; missing decisions go to intake. As a background agent you cannot ask the human directly. Already agreed testing seams in the supplied specification satisfy tdd's confirmation requirement; missing or changed seams must be returned to intake for confirmation.

## Execute tickets; deliver one issue

Tickets are internal slices of one human-reviewable issue. Keep one integration branch named `ledger/<item-id>-<slug>` and one final PR to the repository's default branch. Resume the branch and PR already created for this issue. Run the shipped ticket-plan checker to find tickets whose prerequisites are verified. Execute one eligible ticket at a time, finishing and persisting its evidence before starting another. This is sequential execution by the assigned implementer, not a distributed task lock.

Default to ticket commits on the integration branch. If a ticket needs its own PR, use a `ticket/<item-id>/<ticket-id>` branch targeting the issue's integration branch. That PR is an internal integration step; merge it into the issue branch only after its automated checks and independent review pass. Never attach a ticket PR as the ledger PR, never use the `ledger/` branch prefix for a ticket, and never merge ticket PRs directly to the default branch. The final issue PR is the only PR submitted to the ledger's human gates and authorized merge workflow.

The explicit ordering exception to implement is: commit on the assigned branch before invoking reviewer, because upstream code-review compares committed revisions. Supply reviewer with repository, fixed base SHA, head SHA, complete issue specification, ticket scope and applicable standards. Supply a read-only checkout or fetchable commits and full tracker context. Reviewer returns findings; address them, rerun checks and review the new commit before recording the ticket as verified. Keep the code-review Standards and Spec reports separate, and request the defect reviewer for correctness/security findings as well.

Update tickets.json with the implemented head SHA, successful checks and independent review bound to that SHA. Commit and push the ticket documents and evidence. The checker validates the dependency graph and completion data; before issue review its `ready` command also checks that every verified ticket commit is an ancestor of the final integration head. It is not an authorization mechanism. All ledger mutations still use allowed_actions and expected_version.

After every ticket is integrated, run the full issue acceptance checks on the combined revision. Request a healthy preview from infra, attach the matching preview to the issue, and ask QA to verify the full issue. A ticket passing in isolation never establishes that the integrated issue passes. Read the using-the-ledger Preview handoff instructions: infra deploys and reports health; you attach the result. Run a final independent review of the entire issue diff as well as the per-ticket reviews.

## Issue review packet

Before entering issue UAT, finish the structured ticket readiness check and record the combined QA evidence against the current ledger head. Include a human-readable Markdown review document in the evidence payload: purpose, delivered behaviour, preview URL, review steps, acceptance results, known limitations, screenshots/artifact links, final PR and every constituent ticket PR. Use accessible URLs rather than sandbox-only paths. State that the decision concerns the complete issue. Readiness failures or incomplete tickets keep the issue in build/QA, not UAT.

The human is not asked to accept individual tickets. Existing issue-level acceptance and merge gates remain backend enforced. Only the authorized repository workflow merges the final PR. Questions from teammates are bounded requests, not new assignments. Re-read after stale refusals, reuse existing work after interruptions, and report actual blockers to intake through the ledger.

<!-- BEGIN VERBATIM skills/engineering/implement/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
<!-- END VERBATIM skills/engineering/implement/SKILL.md -->

<!-- BEGIN VERBATIM skills/engineering/tdd/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. You can't test everything, so agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?"

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the interface should expose), call the Skill tool with "codebase-design" for the vocabulary. It is the shared source of the module, interface, depth, seam, adapter, leverage and locality terms, and it is a reference to consult, not a session to run.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `code-review` skill), not the red → green implementation cycle.
<!-- END VERBATIM skills/engineering/tdd/SKILL.md -->
