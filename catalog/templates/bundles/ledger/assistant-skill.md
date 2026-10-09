---
description: Use when setting up or troubleshooting ledger work items, Supabase, actor keys, wake delivery, stages, evidence, human approvals or team membership.
---

# Ledger setup and maintenance

The runtime files belong to the selected member. A ledger bundle includes tools, authenticated wake channel and the using-the-ledger skill; subagents return findings to their parent and receive no ledger credential.

## Setup

Complete the Marketplace installation flow at `/repos/<project>/installation`. Harnesst applies database migrations, generates credentials and registers deployed wake URLs. Follow LEDGER-SETUP.md for the manual May I backend deployment and authorization. The installer accepts Supabase operator authorization separately from the publishable runtime key; operator credentials never enter agent secrets. Missing setup is an installation prerequisite, not an agent task.

May I serves approval pages. Signed decisions go directly to the Supabase approval-callback function. A public HTTPS harnesst address is needed only for agent wakes. GitHub webhooks are optional for manual tests. Product repository automation is installed through the same installation page, which writes the GitHub system actor directly into encrypted Actions secrets.

## Workflow and recovery

The workflow assigns triage and breakdown to intake, design to architect, infra to infra and build/QA/review to implementer. The only gate is merge-approval on the parent issue; entering it queues a May I request automatically. The human reviews and decides in May I; a signed callback applies the decision in Supabase and wakes the next role. Intake reports the approval status from ledger-get-item and completes the notification wake. A chat reply cannot approve a gate.

Requirements belong to each next edge. Human approval moves merge work to ready-to-merge; the GitHub adapter alone confirms merged and deployed. Tickets are sub-issues intake creates during breakdown; GitHub closes each one when its PR merges into the parent issue branch, and build cannot hand to QA while any are open. A spec edit by anyone other than the current stage owner restarts pre-code work at triage; a new SHA resets downstream review and invalidates old evidence and previews.

A workflow change is a new workflows row with version+1, making the old version inactive and the new one active in the same transaction. In-flight items keep their pinned version. Update roles and stage requirements in the workflow rather than copying rules into prompts. One actor per role in this prototype; re-minting rotates that role's keys.

For missing wakes, check the actor's registered URL, separate wake token, outbox status/lease, and whether the channel could claim. The installer registers wake URLs after verifying deployed endpoints. Claims provide a lease, not exactly-once external side effects. Tools return exact database refusals; re-read after stale, verify new commits again, and resolve blocks through the named human role or proxy.


## Installation boundary

Harnesst provisions this bundle through its Marketplace installation flow. When ledger credentials or callbacks are missing, direct the user to the team's `/repos/<project>/installation` page. Do not ask for actor keys or wake tokens, run Supabase CLI setup, or install the ledger through an agent conversation. The installer generates and stores internal credentials. Supabase operator authorization remains in the control plane and must never enter an agent environment.
