---
description: Use when a ledger wake arrives or before recording evidence, handing code to infra for a preview, moving work, resolving a block, or relaying human approval.
---

# Using The Ledger

The ledger is the state of record. Read ledger-get-item before acting and use its allowed_actions. A wake can be stale. The channel has already claimed it; do not claim it again.

Pass the version you read on every mutation. A stale refusal means re-read and reconsider; never retry a write blindly. Evidence and preview artifacts must name the current binding. New code needs new verification.

Questions for humans use ledger-block. Intake relays the durable question and records the answer with ledger-resolve-block. Ledger-woken sessions do not support durable ask_question parking.

Before entering a gate, make the specification reviewable: record rationale, alternatives, risks and costs in spec.review_markdown when structured fields are insufficient. The backend snapshots that document with the specification and evidence.

At a gate, intake owns the human notification. Read the approval status with ledger-get-item and include its approval.review_url as a Markdown link labelled "Review in May I", plus a concise summary of the decision. Only notify once the status is submitted and the URL exists, then complete the notification wake. Other agents report their work in the ledger rather than sending duplicate gate notices. The Supabase backend verifies the decision and resumes work. If status is failed, report the installation error to the operator. Specification, head or artifact changes invalidate the pending approval. On rework, read the decision_outcome and feedback in the rework event, address the requested changes, and submit the revised work through the normal gate. A previous approval never authorizes a changed revision.

One ledger feature/bug item is one human-reviewable issue. Keep one integration branch and one final PR for it, named ledger/<item-id>-<slug>. Internal tickets live in versioned repository documents; they are not plan/proposed_children and do not each enter human approval. Ticket PRs, when needed, use ticket/<item-id>/<ticket-id> branches and target the integration branch; only the final issue PR is attached to the ledger. Read project docs first; resume existing artifacts. QA and reviewer subagents return findings to the implementer, who records the evidence. Human acceptance concerns the combined preview and complete issue requirements. Existing issue-level UAT and merge gates remain in force.

## Preview handoff

1. **Implementer:** push the completed changes to the item's existing branch, verify the PR head, record the SHA and artifacts, and run the repository checks. Request deployment from infra through `ask-teammate`, providing the repository, item ID, PR, full commit SHA, and acceptance criteria. Ask for the deployed URL, deployment identifier and health checks. Keep ownership of the feature and its ledger updates while infra performs this bounded deployment task.
2. **Infra:** treat an explicit deployment request as work to execute. Check out the requested commit, build using the repository's configuration, and deploy through the existing preview workflow or installed Cloudflare tooling. Verify HTTPS, expected page content and required assets. Return the commit, URL, deployment identifier and checks to the caller. A deployment is complete when it is running and those checks pass. Ledger mutation permissions govern ledger writes; they do not determine whether you can deploy through your authorized Cloudflare tools. The caller records the result on its feature item.
3. **Implementer:** re-read the item and compare the returned commit with its current head. For a matching, healthy deployment, attach `preview_url` with that SHA as `binding`, then proceed to QA through the permitted transition. If the head changed, request deployment of the new commit instead. Give QA the URL, commit and acceptance criteria, and record its findings against that commit.

Cloudflare credentials belong to infra; their absence from implementer is expected. Infra returns build or deployment failures with the failing check and actionable details. Escalate only an actual operator decision such as missing infra access, unsafe production impact or unapproved spending. Teammates exchange results directly; routine preview handoffs do not require the human to relay them.

## Delivery

A delivery lease can expire while work is running. Re-read before each side effect and reuse existing branches, PRs and deployments. Claiming is not a guarantee of exactly-once external work.

On an escalation wake, tell the human which item could not reach its owner. For a sweep, list mine=true and inspect unfinished items with no recent event. Terminal deployed/done items need a human completion notice, not another transition.

After delivering a terminal, gate, block or escalation notice, call ledger-complete-wake with the wake ID. Ordinary work wakes complete through the stage transition.
