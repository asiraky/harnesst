---
description:
  Load when an agent uses the GitHub channel and the request involves reacting to
  repo events (issues, labels, PRs, merges, deploys) or reporting back to a human about them —
  "message me when", "notify me once the PR merges", "tell me when it's deployed", "check with
  me before". Covers what wakes the agent, and how a GitHub-triggered run reaches a human in
  Front of House.
---

# GitHub channel: wakes and reaching humans

**This channel can park into Front of House.** A turn this channel started may call
`ask_question`; the question lands as a team-wide needs-you inbox item, a human answers in
FOH, and the session resumes. Use it only when the current run cannot continue without that
answer. For a result, milestone, UAT packet, finding, or recorded blocker, call the generated
`notify-user` tool instead; it opens a new unread FOH conversation without parking the run.
Never invent a confirmation question as a notification or route to Discord/email unless asked.

**What wakes the agent:** an `@mention` of the App's slug in an issue/PR comment; and, per the
channel settings panel on the Deployment tab, configured labels being present on an issue/PR,
new issues, PR synchronize, and PR ready-for-review. There is NO wake for merged, closed, or
deployment events. `payload.label` is never populated on label wakes — match against the
issue's labels snapshot instead.

**Recipe — "notify me when X happens to a PR/issue":**

1. Pick the wake: if X has no native event (merge, deploy), have automation (CI, a workflow)
   apply a configured label when X occurs; the label wakes the agent.
2. In `instructions.md`: on that wake, verify the condition against the live GitHub state
   (don't trust the wake alone), then
3. write any required durable GitHub evidence (comment, label, or other workflow state), then call
   `notify-user` with one self-contained message carrying the relevant links and context. The
   notification does not replace the GitHub record and returns without waiting for a reply.

For a genuinely blocking question, if park isn't wired (self-hosted eve, no harnesst lock entry),
the channel falls back to posting the question as a comment on the thread so it is never lost —
but a comment reply starts a NEW turn rather than resuming the waiting one.
