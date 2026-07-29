---
description: Load when an agent uses the Discord channel and the request involves talking to
  users on Discord, the agent's slash command, or how a Discord-triggered run asks a human
  something — "answer on Discord", "ask before doing X". Covers what wakes the agent and where
  its questions land.
---

# Discord channel: wakes and reaching humans

**This channel does NOT park into Front of House.** A turn this channel started that calls
`ask_question` posts the question back into Discord as buttons (with free text available) —
the asker answers where they asked, and the session resumes there. The question never appears
in the harnesst inbox.

**What wakes the agent:** a user invoking the agent's slash command (`/<agent-name>`) in a
connected server. Nothing else — no message-watching, no reactions, no Discord-side events.

**Design rules:**

- Work that arrives via Discord is answered on Discord — the final reply is the message the
  user reads, so make it a real answer.
- "Notify me on Discord when X" needs a wake for X from another entry point (a schedule or
  another channel) plus an outbound tool such as `discord-send-message` (a separate
  marketplace tool) — this channel only replies to interactions it started.
- A redeploy ends any conversation waiting on an answer; the user asks again to start fresh.
