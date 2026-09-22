---
description: Use when setting up or troubleshooting ledger work items, Supabase, actor keys, wake delivery, stages, evidence, human approvals or team membership.
---

# Ledger setup and maintenance

The runtime files belong to the selected member. A ledger bundle includes tools, authenticated wake channel and the using-the-ledger skill; subagents return findings to their parent and receive no ledger credential.

## Setup

The operator runbook is `catalog/ledger/README.md` in the harnesst source. For a local trial run `npm run ledger:up` then `npm run ledger:dev`; the playground is http://localhost:55430. Actors are in ignored `catalog/ledger/.local/actors.json`. `npm run ledger:team` composes all three members and both subagents.

For manual hosted setup, follow the Ledger bundle’s LEDGER-SETUP.md. The bundle ships Supabase migrations, approval-dispatch and approval-callback functions. May I authentication and human role mappings are configured by the operator; agent credentials cannot administer approvals.

Set shared LEDGER_URL and LEDGER_ANON_KEY from Supabase API settings. Set each member's LEDGER_ACTOR_KEY and LEDGER_WAKE_TOKEN from its mint result; these are different secrets, copied once. Locally, the Docker-facing URL is http://host.docker.internal:55431 and the anon value is local. On Linux, the container may need a host-gateway mapping. SQL admin credentials never belong in an agent.

Add this grounding if the member does not already have it: “Work arrives from the ledger. Read ledger-get-item and act only through allowed_actions. Use ledger-block for human questions; re-read after stale refusals.” Deploy, then greet each member once so a ledger call registers EVE_PUBLIC_ORIGIN as its wake URL. Add a 15-minute schedule to inspect inactive unfinished items from ledger-list-items(mine=true).

## Workflow and recovery

The workflow assigns triage to intake, infra to infra and build/QA/review to implementer. Gate entry queues a May I request automatically. The human reviews and decides in May I; a signed callback applies the decision in Supabase and wakes the next role. Intake reports the approval status from ledger-get-item and completes the notification wake. A chat reply cannot approve a gate.

Requirements belong to each next edge. Human approval moves merge work to ready-to-merge; the GitHub adapter alone confirms merged and deployed. Child items spawn from an approved plan's proposed_children, each with a stable key, kind, title and spec. Changes to a spec reset pre-code work to triage; a new SHA resets downstream review and invalidates old evidence and previews.

A workflow change is a new workflows row with version+1, making the old version inactive and the new one active in the same transaction. In-flight items keep their pinned version. Update roles and stage requirements in the workflow rather than copying rules into prompts. One actor per role in this prototype; re-minting rotates that role's keys.

For missing wakes, check the actor's registered URL, separate wake token, outbox status/lease, and whether the channel could claim. A new actor must make a first tool call before it has a URL. Claims provide a lease, not exactly-once external side effects. Tools return exact database refusals; re-read after stale, verify new commits again, and resolve blocks through the named human role or proxy.
