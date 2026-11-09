---
description: Use when a ledger wake arrives or before recording evidence, handing code to infra for a preview, moving work, resolving a block, or relaying human approval.
---

# Using The Ledger

The ledger is the state of record. Read ledger-get-item before acting and use its allowed_actions. A wake can be stale. The channel has already claimed it; do not claim it again.

Pass the version you read on every mutation. A stale refusal means re-read and reconsider; never retry a write blindly. Evidence and preview artifacts must name the current binding. New code needs new verification.

Every notify-user message about ledger work sets `topic` to the issue id (for a ticket, its parent_id). A new message on a topic retires the older unanswered updates on it, so the humans see the latest word on each issue instead of its history. Send one message when something changes for the humans; do not narrate routine progress.

Questions for humans use ledger-block. The block is your message to the human: put everything they need in the question (the ask, links, what you already checked) and do not also send notify-user about it, or they get the same ask twice. Intake relays the durable question in one notify-user message with `awaits_reply` set to true and records the answer with ledger-resolve-block. Ledger-woken sessions do not support durable ask_question parking.

Inviting a human into a conversation you will run yourself (the architect calling in an engineer) is not a block. Send the notify-user message with `awaits_reply` set to true, then call ledger-complete-wake with `awaiting`: the role you are waiting on and one sentence saying what they must do and where. The ledger stops waking you and records an `awaiting_human` event. On any later wake, that event after the item's latest stage change means the ask has already gone out: send nothing and finish the turn.

When anyone asks where an item is up to, an `awaiting_human` event after its latest stage change is the outstanding action. Name the role and repeat its request, so the person knows exactly what to do.

The only human gate is merge approval on the parent issue. harnesst shows the request with its spec, evidence and links, and records who decided.

At the gate, intake owns the human notification. Read the approval status with ledger-get-item and put its approval.review_url on a line of its own as a bare URL, with nothing else on that line (harnesst shows it as an approval card with Approve and Reject), plus a concise summary of the decision. Only notify once the status is submitted and the URL exists, then complete the notification wake. Other agents report their work in the ledger rather than sending duplicate gate notices. The ledger verifies the decision and resumes work. If status is expired, tell the requester the request lapsed unanswered and that an operator must reissue the gate. If status is failed, report the installation error to the operator. A new head or artifact invalidates the pending approval. On rework, read the decision_outcome and feedback in the rework event, address the requested changes, and submit the revised work through the normal gate. A previous approval never authorizes a changed revision.

An issue is a feature or bug item; its tickets are ticket items with parent_id and blocked_by. The issue branch is ledger/<issue-id>-<slug> off the default branch, and each ticket branch is ledger/<ticket-id>-<slug> off the issue branch. A ticket PR targets the issue branch and GitHub closes the ticket when it merges. The issue PR targets the default branch and goes through QA, review and merge approval once every ticket has merged. Once a human approves the merge gate, harnesst merges the issue PR at the approved head with its own GitHub App. No agent merges into or pushes to the default branch, or enables auto-merge: auto-merge would let a later commit land under the human's approval. Read project docs first; resume existing artifacts. QA and reviewer subagents return findings to the implementer, who records the evidence.

## Preview handoff

1. **Implementer:** push the completed changes to the issue branch, verify the PR head, record the SHA and artifacts, and run the repository checks. Request deployment from infra through `ask-teammate`, providing the repository, item ID, PR, full commit SHA, and acceptance criteria. Ask for the deployed URL, deployment identifier and health checks. Keep ownership of the feature and its ledger updates while infra performs this bounded deployment task.
2. **Infra:** treat an explicit deployment request as work to execute. Check out the requested commit, build using the repository's configuration, and deploy through the existing preview workflow or installed Cloudflare tooling. Verify HTTPS, expected page content and required assets. Return the commit, URL, deployment identifier and checks to the caller. A deployment is complete when it is running and those checks pass. Ledger mutation permissions govern ledger writes; they do not determine whether you can deploy through your authorized Cloudflare tools. The caller records the result on its feature item.
3. **Implementer:** re-read the item and compare the returned commit with its current head. For a matching, healthy deployment, attach `preview_url` with that SHA as `binding`, then proceed to QA through the permitted transition. If the head changed, request deployment of the new commit instead. Give QA the URL, commit and acceptance criteria, and record its findings against that commit.

Cloudflare credentials belong to infra; their absence from implementer is expected. Infra returns build or deployment failures with the failing check and actionable details. Escalate only an actual operator decision such as missing infra access, unsafe production impact or unapproved spending. Teammates exchange results directly; routine preview handoffs do not require the human to relay them.

## Delivery

A delivery lease can expire while work is running. Re-read before each side effect and reuse existing branches, PRs and deployments. Claiming is not a guarantee of exactly-once external work.

On an escalation wake, read the item first. An escalation means the owner was woken repeatedly and the item did not move, not that the owner is offline. If an `awaiting_human` event follows the latest stage change, tell that person what is waiting on them. Otherwise tell the human which item is stuck and with which owner; do not call it a delivery failure. For a sweep, list mine=true and inspect unfinished items with no recent event. Terminal deployed/done items need a human completion notice, not another transition.

After delivering a terminal, gate, block or escalation notice, call ledger-complete-wake with the wake ID. Ordinary work wakes complete through the stage transition, or with `awaiting` when you own the stage and are waiting on a human.
