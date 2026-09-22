---
description: Read when planning internal tickets, selecting the next ticket, recording ticket verification, or preparing the combined issue for human review.
---

# Ticket plan

The parent ledger item is the issue a human reviews. Internal tickets are tracked in the product repository at `docs/work/<item-id>/tickets.json`, with a separate Markdown brief per ticket in `tickets/`. Commit and push these files; local-only files are not a handoff.

Use `ticket-plan.mjs` shipped beside this document. Run it from the product checkout:

```
node <path-to-ticket-plan.mjs> validate docs/work/<item-id>/tickets.json
node <path-to-ticket-plan.mjs> next docs/work/<item-id>/tickets.json
node <path-to-ticket-plan.mjs> ready docs/work/<item-id>/tickets.json <full-integration-head-sha>
```

The first command validates the graph and any verification claims. The second lists the eligible pending tickets; the assigned implementer executes one at a time. The third requires every ticket to be verified and its verified commit to be an ancestor of the integrated head in this checkout. Keep ticket commits when merging internal PRs (merge commit or fast-forward); squashing or rebasing requires fresh verification on the resulting commits and updated evidence.

This checker validates recorded evidence and Git ancestry. It does not execute tests, authenticate reviewer identity, lock a task or grant permission to merge. The implementer must run the checks and delegate independent review before recording results. The existing ledger and repository approval gates still govern release.

```json
{
  "version": 1,
  "issueId": "full-ledger-item-id",
  "specRevision": "immutable-specification-revision",
  "tickets": [
    {
      "id": "01",
      "title": "First independently verifiable behaviour",
      "blockedBy": [],
      "acceptanceCriteria": ["SPEC-1: observable behaviour"],
      "status": "pending"
    },
    {
      "id": "02",
      "title": "Behaviour requiring ticket 01",
      "blockedBy": ["01"],
      "acceptanceCriteria": ["SPEC-2: observable behaviour"],
      "status": "pending"
    }
  ]
}
```

After verification, set status to `verified` and add:

- `headSha`: full commit verified by the checks and reviewers.
- `checks`: objects containing `command` and `result: "passed"`.
- `review`: `headSha`, `specRevision`, and `standards`, `spec`, `defects` each equal to `"passed"` after the corresponding independent review.
- `evidenceUrl`: durable repository/PR/artifact link containing results and findings.

Changing a ticket's code invalidates its previous verification. Changing the specification requires revisiting affected tickets and reconciling every ticket with the new revision; old review revisions are rejected. After integration, run full-issue QA and review regardless of individual ticket results. A failed combined check is an issue failure, even if every ticket passed separately.
