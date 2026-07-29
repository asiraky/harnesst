---
description: Load when an agent has the Discord Send Message tool installed and the request
  involves proactively posting to a Discord channel — "post to Discord", "announce in the
  server", outbound notifications a slash-command reply can't carry.
---

# Discord Send Message (installed tool)

Sends a message to a Discord channel by channel id via harnesst's control plane, using the
installation's shared Discord app — scoped to servers this agent is connected to. This is the
OUTBOUND half: the Discord **channel** only replies to interactions it started, so "post to
Discord when X" pairs a wake for X (schedule or another channel) with this tool. It sends
one-way messages only — it cannot ask a question or wait for an answer.
