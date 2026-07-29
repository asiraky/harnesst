---
description: Load when an agent uses the AgentMail connection and the request involves reading
  or labelling inbox mail (invoices, receipts, billing) — what the tools can and deliberately
  cannot do.
---

# AgentMail connection

Read + label ONLY, by design: the shipped tools list inboxes, list/search messages, read a
full message (including attachment downloads — invoice PDFs are the point), and add/remove
labels. Nothing here can send, delete, or provision mail — don't design flows that need to.

For the assistant: this is a **connection, not a channel** — mail arriving never wakes the
agent, and nothing here reaches a human. Polling an inbox means pairing these tools with a
schedule. Auth is a user-supplied API key (secret), not OAuth.
