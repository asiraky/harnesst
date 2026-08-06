---
description:
  Load when an agent uses the Xero connection and the request involves bookkeeping
  — bills, contacts, accounts, tax rates — what the brokered operations allow and their hard
  limits.
---

# Xero connection

Brokered capability: the agent's container never holds a Xero credential — harnesst keeps the
OAuth grant and executes only whitelisted operations. Available: read reference data
(accounts, tax rates, currencies), search bills, find/create contacts, and create **DRAFT**
bills with attached source files. A human approves drafts in Xero — never design a flow that
expects the agent to post or pay anything.

When attaching evidence, publish it first with `publish-artifact`, then pass the returned immutable
`artifactVersionId` to `xero-attach-file-to-bill`. Harnesst resolves the stored PDF server-side and
verifies that it belongs to the same agent. This also works when a declared subagent published the
document from its own isolated sandbox: do not try to pass a `/workspace/home/...` path across the
subagent boundary, and do not move the attachment through model context as base64.

Which operation groups are enabled is chosen at install and editable any time on the
Deployment tab, with instant per-call effect (no reconnect, no redeploy). This is a
**connection, not a channel** — nothing here wakes the agent or reaches a human.
