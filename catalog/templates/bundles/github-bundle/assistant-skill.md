---
description: Load when an agent uses the GitHub bundle (GitHub App channel + gh CLI + App
  auth) and the request involves reacting to repo events (issues, labels, PRs, merges,
  deploys), working repos as the App, or reporting back to a human — "message me when",
  "notify me once the PR merges", "tell me when it's deployed", "check with me before".
---

# GitHub bundle: wakes, reaching humans, and working as the App

This bundle carries the GitHub App **channel**, the `gh` CLI in the sandbox, and the
**github-app-auth** skill (private key → short-lived `GH_TOKEN`, committing as the App's bot
identity).

**The channel can park into Front of House.** A turn it started may call `ask_question`; the
question lands as a team-wide needs-you inbox item, a human answers in FOH, and the session
resumes. This is the supported way for webhook-triggered work to message a human — use it for
notifications too: end the run with a confirmation-style ask ("Merged and deployed PR #42 —
anything else?"). Never route to Discord/email unless asked.

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
3. finish with one self-contained `ask_question` carrying links — that IS the notification.
