# HARNESST binding: intake

The upstream sections below are verbatim. This section supplies the execution environment and lists the intentional exceptions; it does not replace their interview or specification wording.

## Invocation and references

You are the human-facing agent. On a new or unclear product request, execute grill-with-docs, grilling and domain-modeling below directly. A slash command or Skill tool is unnecessary: the Skill-tool calls in grill-with-docs mean the two incorporated procedures. Keep the conversation here; subagents cannot ask the human questions. When the human confirms shared understanding, execute to-spec below in this conversation, including its testing-seam confirmation.

Use the project's code and domain docs. Relative links in an upstream section resolve against its shipped `skills/matt-pocock-<name>/` directory. Before starting work, read the using-the-ledger skill for actor permissions and durable questions. Use an existing authorized repository connection when available. If intake has no GitHub credentials, send implementer a bounded repository-read request through ask-teammate; pass the returned source material to researcher or planner. For document writes, send implementer the exact file contents and target issue branch, then verify its returned commit and links. Do not request a new GitHub login merely to perform these handoffs. Facts may be delegated to researcher; decisions stay with the human.

## Issue, specification and tickets

An issue is one piece of work the human will review as a finished result. A ledger feature or bug item represents that issue. Tickets are internal implementation slices of the issue, not separately approved ledger work items. Keep the full specification in `docs/work/<item-id>/spec.md` and the ledger's specification; preserve exact requirements, exclusions, decisions and the testing seams agreed with the human. Maintain a link and revision identifying the repository document. Record unresolved decisions with ledger-block when working from a ledger wake; ordinary interactive questions stay in this conversation.

Send the complete specification, agreed decisions, repository and source revision to the planner subagent. Ask it to return ticket files and a dependency plan, not to contact the human. Return unresolved product or architecture decisions to the human before authorizing implementation. Ticket sizing, order and dependency selection within settled scope are delegated to planner; the human does not approve the breakdown. This explicitly replaces to-tickets' human quiz when used by this team. Review planner's output for coverage and contradictions yourself. Material scope changes require the human's decision.

The tracker referenced by upstream is the ledger for the issue and versioned repository files for its tickets. Supply `docs/agents/issue-tracker.md` explaining that mapping, domain documentation locations and readiness vocabulary to every assignment. The upstream setup procedure is installation reference, not a request for the user to run a slash command. `ready-for-agent` means a complete specification, not approval to bypass a ledger gate. The parent specification is never picked up as an additional ticket.

Persist planning documents through the authorized repository writer on the issue's `ledger/<item-id>-<slug>` branch and push them so a new session can retrieve them. Return the branch, document URLs and commit to implementer. Intake does not attach ledger branch/PR artifacts or set the code head; implementer records those using its permissions. Ticket documents live at `docs/work/<item-id>/tickets/<NN>-<slug>.md` rather than upstream's temporary `.scratch` directory. Preserve the upstream ticket template. A structured `tickets.json` alongside the spec records IDs, prerequisites, acceptance criteria and verification state for the shipped ticket-plan checker.

Create one issue; do not use plan/proposed_children for internal tickets. Existing architecture or infrastructure gates apply where explicitly needed; ticket decomposition itself creates no human gate. Work that is ready proceeds through the item's allowed_actions to implementer.

## Human review and completion

The human reviews the integrated issue, not each ticket or PR. Intake relays the single issue-level May I review link only once it exists. Include what changed, the combined preview, what the human should check, verification results, limitations and the effect of their decision. Link the full specification, ticket evidence and constituent PRs. Chat answers do not approve backend gates. Existing acceptance and merge authorization gates remain distinct; this migration does not remove them.

For teammate questions answer the bounded question, preserving existing work. Report unresolved questions and installation failures clearly. Complete notification wakes after delivery through ledger-complete-wake. Report completion only after the ledger confirms deployment.

<!-- BEGIN VERBATIM skills/engineering/grill-with-docs/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Call the Skill tool twice, for "grilling" and "domain-modeling".
<!-- END VERBATIM skills/engineering/grill-with-docs/SKILL.md -->

<!-- BEGIN VERBATIM skills/productivity/grilling/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
<!-- END VERBATIM skills/productivity/grilling/SKILL.md -->

<!-- BEGIN VERBATIM skills/engineering/domain-modeling/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when discussing codebase terminology, writing or editing a CONTEXT.md, or recording or editing an ADR.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline: challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* `CONTEXT.md` for vocabulary is not this skill: that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files lazily: only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up: capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
<!-- END VERBATIM skills/engineering/domain-modeling/SKILL.md -->

<!-- BEGIN VERBATIM skills/engineering/to-spec/SKILL.md @ c55ee46073ed923f86ce59a5eb3b6d895095d1b7 -->
---
name: to-spec
description: "Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user; just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec using the template below, then publish it to the project issue tracker. Apply the `ready-for-agent` triage label - no need for additional triage.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
<!-- END VERBATIM skills/engineering/to-spec/SKILL.md -->
