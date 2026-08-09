---
description: Load when the user wants an agent that deploys to Vercel, asks how to set up the
  Vercel integration, or asks what the Vercel bundle installs and how the pieces fit.
---

# Vercel (installed bundle)

One install that makes a member a Vercel deployer: the **Vercel CLI tool** (the whole `vercel`
CLI behind one gated tool — project-scoped token in tool-process env only, human approval per
command by default) plus the **Deploying Vercel apps** skill (how to get a project provisioned
and ship through the tool).

The recommended team shape is this bundle on the building agent plus the **Vercel Issuer** agent
as a separate member holding the full-account token. The dev agent asks the issuer for a project;
a human approves; a project-scoped `VERCEL_TOKEN` lands in the dev agent's env via a queued
redeploy; from then on the dev agent deploys freely within that one project.

Operator knobs after install:

- `VERCEL_CLI_REQUIRE_APPROVAL=0` on this member disables the per-command gate (the issuer stays
  always-gated regardless).
- `VERCEL_TOKEN` can be set by hand for standalone use — make it a project-scoped token.
- The Vercel GitHub App (one-time browser install) enables push-to-deploy; without it the agent
  still deploys by CLI upload.
