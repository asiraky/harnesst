---
description: Load when an agent uses the Google Sheets bundle and the request involves reading
  or writing spreadsheets — what the connector provides, how it is authorized, and the usage
  discipline the bundled skill teaches.
---

# Google Sheets bundle

Carries the Google Sheets **connection** (OAuth via Connect Google on the Deployment tab; the
agent gets `google_sheets__*` tools with self-refreshing tokens) and a **usage skill** (A1
notation, read-before-write, RAW vs USER_ENTERED, append vs update, batchUpdate shapes).

For the assistant: this is a **connection, not a channel** — nothing here wakes the agent or
carries questions to a human. Sheet work runs inside turns started elsewhere (FOH, a schedule,
another channel). The human must click Connect Google once on the Deployment tab before the
tools work.
