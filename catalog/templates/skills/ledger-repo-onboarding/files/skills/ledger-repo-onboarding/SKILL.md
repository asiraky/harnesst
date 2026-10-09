---
name: ledger-repo-onboarding
description: Create a product repository and connect a repository to the team's ledger with gh (Actions secrets, ledger workflow, Cloudflare deploy secrets). Infra only. Use when intake asks for a new app or a repository the ledger does not know yet.
---

# Ledger repository onboarding

The team works across many repositories. A repository joins the team in two halves:

- **intake** registers it as a ledger project (`ledger-create-project`). Only intake can.
- **infra** (you) makes the repository report to the ledger: the ledger workflow, its helper
  script and three Actions secrets. Only your GitHub App has the Workflows, Secrets, Variables and
  Administration permissions this needs; teammates get HTTP 403 by design.

Mint `GH_TOKEN` with the github-app-auth skill first, with `TARGET` set to the repository (or to
the owner, when creating one). Every step below is idempotent: re-run it rather than guessing
what a previous attempt finished.

## Create a repository

Only when a human asked for a new app and the owner is a GitHub **organization** the App is
installed on. An App cannot create repositories in a personal account: if the owner is a user,
block on the engineer and ask them to create the empty repository.

```bash
gh repo create "$OWNER/$NAME" --private --add-readme --description "$DESCRIPTION"
```

A repository created this way is visible to the App only when its installation covers "All
repositories". If the next step returns HTTP 404, block on the engineer to add the repository to
the App installation (`https://github.com/apps/$GITHUB_APP_SLUG/installations/new`) — and to the
other team members' Apps, which need it too.

Then ask intake (ask-teammate) to register the project with its slug, name and `owner/name`.

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

3. Install the workflow and its helper on the **default branch**, byte-for-byte from this skill's
   references: `references/ledger.yml` → `.github/workflows/ledger.yml` and
   `references/github-ledger.mjs` → `.github/scripts/ledger.mjs`. Never modify them. If either
   path already exists with different content, stop and block on the engineer — do not
   overwrite. Commit with the message `Install ledger automation` and push to the default branch
   (or open a PR when branch protection requires one, and ask the engineer to merge it).

4. For a Cloudflare Workers app, also install `references/deploy.yml` as
   `.github/workflows/deploy.yml`, adapt only its build and deploy commands, and set:

```bash
gh secret set CLOUDFLARE_API_TOKEN  --repo "$REPO" --body "$CLOUDFLARE_API_TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --body "$CLOUDFLARE_ACCOUNT_ID"
gh variable set CLOUDFLARE_WORKER_URL --repo "$REPO" --body "https://<worker>.<subdomain>.workers.dev"
```

5. Enable automation and confirm:

```bash
gh variable set LEDGER_ENABLED --repo "$REPO" --body true
gh workflow run ledger.yml --repo "$REPO" && sleep 20 && gh run list --repo "$REPO" --workflow ledger.yml --limit 1
```

The run must succeed. Record the repository, the workflow run URL and the default-branch commit
on the infra item, then tell intake the repository is connected.

## Merging

Who merges is the repository's choice, not this skill's: the ledger workflow merges an approved
PR head after May I approval, and branch protection decides whether anyone else can. Do not
loosen branch protection to make a merge go through.
