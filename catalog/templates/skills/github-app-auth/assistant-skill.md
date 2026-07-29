---
description: Load when an agent has the GitHub App auth skill installed and the request
  involves committing, pushing, or calling GitHub APIs as the agent's App identity.
---

# GitHub App auth (installed skill)

Teaches the agent to exchange its GitHub App private key for a short-lived installation token
(`GH_TOKEN`) and commit as the App's bot identity; `gh` and `git` are preinstalled. Credential
mechanics only — the wakes and human-contact rules live with the GitHub **channel**'s skill.
The App secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) must be present on the agent.
