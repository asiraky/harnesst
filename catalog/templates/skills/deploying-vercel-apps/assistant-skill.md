---
description: Load when an agent has the Deploying Vercel apps skill installed and the request
  involves how that agent ships to Vercel, why it is waiting on approval or a credential, or how
  to wire the provisioning flow with the Vercel Issuer.
---

# Deploying Vercel apps (installed skill)

Requester-side know-how for the Vercel flow: the agent does all Vercel work through the gated
Vercel CLI tool (the shell deliberately has neither the `vercel` binary configured with
credentials nor the token), asks the Vercel platform teammate for a project when it has none, and
treats "waiting on human" as the normal outcome of that ask.

Pairing expectations:

- This skill assumes the **Vercel CLI tool** is installed on the same member (the Vercel bundle
  installs both).
- Provisioning needs a **Vercel Issuer** agent on the team; without one, the agent's delegation
  for a project has no one to land on.
- The agent's `VERCEL_TOKEN` should be left unset at install — it arrives via provisioning as a
  project-scoped token. `VERCEL_CLI_REQUIRE_APPROVAL=0` turns off the per-command human gate for
  this member once trusted.
- No sandbox bootstrap: the skill intentionally does not install the CLI into the sandbox shell.
