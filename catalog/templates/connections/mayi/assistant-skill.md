---
description: Load when an agent uses the May I? connection or the request involves human
  approval gates on agent actions — "require approval before", "sign off on", gated tools —
  especially from scheduled runs.
---

# May I? connection

Gated tools park until a human approves in the May I? app, then resume with a signed receipt.
The approval surface is May I?, not Front of House — approvals land in the May I? app.

**The scheduling trap:** scheduled work that may need an approval MUST use the handler form of
an eve schedule and hand the run to the channel with `receive(mayi, ...)` — task-mode
schedules cannot park for a human and will stall. Design the schedule around this from the
start.

Setup is one click: Connect on the Deployment tab (harnesst registers the OAuth client — no
operator app to create).
