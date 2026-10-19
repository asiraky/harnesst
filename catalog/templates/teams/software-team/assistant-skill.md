---
description: Load when the repository has the Software team template installed, or the user asks
  about the software team, its roles, setup, or how it works across GitHub repositories.
---

# Software team (installed team)

Four members, one per ledger role: intake (front of house, owns specs, tickets and ledger
projects), architect (technical design), implementer (builds, reviews and QAs pull requests) and
infra (cloud resources, CI, deployment; connects repositories to the ledger).

Setup runs in the team's setup wizard (`/repos/<team>/setup`): shared secrets, the Supabase
ledger, publish, one GitHub App per member, approvals and wakes. Send the user there for anything
missing rather than to individual Settings pages. The one exception: the ledger needs a Supabase
connection, added once in Settings → Connections and then linked to the team in Setup.

The team works on every repository its members' GitHub Apps are installed on. Only infra's App has
Workflows, Actions secrets and variables. No member's App has Administration, so a human creates
each new repository under the organization and installs the team's Apps and harnesst's GitHub App
on it.

After a human approves the merge gate, harnesst merges the issue PR with its own GitHub App; agents
never merge into the default branch. Recommended org settings: a ruleset on the default branch
(require a PR, block force pushes and deletion, no bypass) and branch protection whose "Restrict
who can push" allows only the developers and harnesst's App (never agent Apps or GitHub Actions),
with auto-merge disabled.
