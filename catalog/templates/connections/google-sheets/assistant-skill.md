---
description: Load when an agent uses the Google Sheets connection and the request involves
  reading or writing spreadsheets — what the google_sheets__* tools provide and how they are
  authorized.
---

# Google Sheets connection

The agent gets `google_sheets__*` tools (read/append/update cells, metadata, batch updates)
via eve's OpenAPI connection; tokens self-refresh. The human clicks Connect Google once on the
agent's Deployment tab.

For the assistant: this is a **connection, not a channel** — nothing here wakes the agent or
reaches a human. Prefer installing the Google Sheets **bundle**, which adds the usage skill
(A1 notation, read-before-write, RAW vs USER_ENTERED, batchUpdate shapes).
