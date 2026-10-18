---
name: ledger-repo-onboarding
description: Connect or reconnect a repository to the team's ledger with gh (Actions secrets, ledger workflow, Cloudflare deploy secrets). Infra only. Use when the ledger wakes you for an infra item that asks to connect or reconnect a repository.
---

# Ledger repository onboarding

The team works across many repositories. A repository joins the team in four steps:

- **the engineer** creates it. No agent can: no team App has the Administration permission, by
  design (Administration can edit branch protection and always bypasses its push allowlist).
- **intake** registers it as a ledger project (`ledger-create-project`). Only intake can.
- **intake** then creates an `infra` item asking for the connection and routes it to you.
- **infra** (you) makes the repository report to the ledger: the ledger workflow, its helper
  script and three Actions secrets. Only your GitHub App has the Workflows, Secrets and Variables
  permissions this needs; teammates get HTTP 403 by design.

Run this only on a ledger wake for that `infra` item, which holds the item's lease. A teammate
message asking you to connect a repository is not the start signal: tell the sender to have intake
route an `infra` item, and stop. Record each step's result as evidence on the item.

Mint `GH_TOKEN` with the github-app-auth skill first, with `TARGET` set to the repository. Every
step below is idempotent: re-run it rather than guessing what a previous attempt finished. An
existing `ledger-automation` branch or PR that the item's evidence records is your own earlier
attempt: reuse it.

## New repositories

You cannot create repositories. When asked for one, block on the engineer to:

- create the empty repository (with a README, so it has a default branch) under the organization;
- add it to every team member's GitHub App installation, unless they cover "All repositories";
- add it to harnesst's GitHub App installation, so harnesst can merge approved changes.

Then ask intake (ask-teammate) to register the project with its slug, name and `owner/name`, and
to route an `infra` item for the connection. Finish your turn; the ledger wakes you for that item.
If a step below returns HTTP 404, the repository is missing from your App's installation: block on
the engineer to add it (`https://github.com/apps/$GITHUB_APP_SLUG/installations/new`).

## Connect a repository to the ledger

`REPO=owner/name`. Your sandbox has `LEDGER_URL`, `LEDGER_ANON_KEY` and
`LEDGER_GITHUB_ACTOR_KEY` (the ledger identity GitHub Actions report as).

```bash
# 1. Pause automation while secrets change; a failed attempt stays paused and is safe to retry.
gh variable set LEDGER_ENABLED --repo "$REPO" --body false

# 2. The three secrets the ledger workflow reads.
gh secret set LEDGER_URL       --repo "$REPO" --body "$LEDGER_URL"
gh secret set LEDGER_ANON_KEY  --repo "$REPO" --body "$LEDGER_ANON_KEY"
gh secret set LEDGER_ACTOR_KEY --repo "$REPO" --body "$LEDGER_GITHUB_ACTOR_KEY"
```

3. The default branch is protected: no agent can push or merge into it. Put the workflow and its
   helper on a branch `ledger-automation` off the default branch (not `ledger/`, which names work
   items), byte-for-byte from this skill's references: `references/ledger.yml` →
   `.github/workflows/ledger.yml` and `references/github-ledger.mjs` → `.github/scripts/ledger.mjs`.
   Never modify them. A repository connected by an earlier version of this skill already has
   both files: replace them (this is an upgrade; the engineer reviews it in the PR). Any other
   file already at either path is not ours: stop and block on the engineer.

4. For a Cloudflare Workers app, also add `references/deploy.yml` as
   `.github/workflows/deploy.yml` on the same branch, adapt only its build and deploy commands,
   and set:

```bash
gh secret set CLOUDFLARE_API_TOKEN  --repo "$REPO" --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --body "$CLOUDFLARE_ACCOUNT_ID"
gh variable set CLOUDFLARE_WORKER_URL --repo "$REPO" --body "https://<worker>.<subdomain>.workers.dev"
```

5. Commit with the message `Install ledger automation`, push the branch, open a PR into the
   default branch, and block on the engineer to review and merge it. Continue once it has merged.

6. Enable automation and confirm:

```bash
gh variable set LEDGER_ENABLED --repo "$REPO" --body true
gh workflow run ledger.yml --repo "$REPO" && sleep 20 && gh run list --repo "$REPO" --workflow ledger.yml --limit 1
```

The run must succeed. Record the repository, the workflow run URL and the default-branch commit
on the infra item as `infra_provisioned` evidence, then transition it to `done`. The ledger wakes
intake on `done`; that is how intake learns the repository is connected, so don't message intake
as well.

## Merging

After a human approves the merge gate, harnesst merges the issue PR into the default branch with
its own GitHub App, at the exact approved head SHA. The ledger workflow only observes the merge,
records it and dispatches the deploy. Never merge into or push to the default branch, never enable
auto-merge, and never touch branch protection or rulesets. A merge that does not go through is the
engineer's to resolve.
