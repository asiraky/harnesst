---
description: Load when an agent uses the Gmail connection and the request involves reading,
  labelling, or sending mail from the connected Google account — what the permission levels
  mean and what the gmail__* tools can do.
---

# Gmail connection

The agent gets `gmail__*` tools via eve's OpenAPI connection; tokens self-refresh. Permission
is **leveled at install** — Read mail / Manage labels / Send mail, read-only by default — and
the granted level is visible to the agent, so never design a flow that assumes sending unless
the Send level is enabled. The human connects the mailbox on the agent's Deployment tab.

For the assistant: this is a **connection, not a channel** — incoming mail never wakes the
agent, and sending mail is not the default way to notify a human (Front of House is, unless
the user names email). Watching a mailbox means pairing these tools with a schedule.
