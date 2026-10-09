---
description: Load when the repository has the Software team template installed, or the user asks
  about the software team, its roles, setup, or how it works across GitHub repositories.
---

# Software team (installed team)

Four members, one per ledger role: intake (front of house, owns specs, tickets and ledger
projects), architect (technical design), implementer (builds, reviews and QAs pull requests) and
infra (cloud resources, CI, deployment; creates repositories and connects them to the ledger).

Setup runs in the team's setup wizard (`/repos/<team>/setup`): shared secrets, the Supabase
ledger, publish, one GitHub App per member, May I and wakes. Send the user there for anything
missing rather than to individual Settings pages.

The team works on every repository its members' GitHub Apps are installed on. Only infra's App has
Administration, Workflows, Actions secrets and variables. Repository creation needs a GitHub
organization.
