---
description: Load when an agent has the ledger repository onboarding skill installed and the
  request involves a new product repository or connecting a repository to the ledger.
---

# Ledger repository onboarding (installed skill)

Teaches the team's infra agent to connect an existing repository to the team ledger with `gh`:
Actions secrets, plus the ledger workflow and helper and the optional Cloudflare deploy workflow,
which it opens as a PR for the engineer to merge (the default branch is protected). It needs the
infra GitHub App (Workflows, Secrets and Variables write) and the provisioned
`LEDGER_GITHUB_ACTOR_KEY`; the setup wizard grants both.

Agents cannot create repositories: no team App has Administration, which can edit branch
protection and bypasses its push allowlist. A human creates the repository under the
organization and adds it to the team's GitHub App installations and to harnesst's GitHub App,
which merges approved PRs.
