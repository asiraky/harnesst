---
description: Load when an agent has the Vercel CLI tool installed and the request involves
  deploying to Vercel, Vercel project configuration, environment variables on Vercel, or
  troubleshooting why a Vercel command was refused or is waiting on approval.
---

# Vercel CLI (installed tool)

Runs the full `vercel` CLI as a single gated tool. The agent passes an argv array plus a written
justification; by default every call parks as an approval item in Front of House showing exactly
that argv and justification, and executes only when a human approves.

What to know when helping with it:

- **The credential never surfaces.** The Vercel token lives in the container env, is read by the
  tool process only, and is handed to the CLI child via env. It is not in the sandbox shell
  (`echo $VERCEL_TOKEN` there is empty by design), not in model context, and token-shaped strings
  are redacted from tool output. This is intentional — do not "fix" it.
- **Scope is one project.** The delivered token is project-scoped (`vcp_…`): the agent can deploy
  and configure its own project and structurally cannot touch any other.
- **Refusals are code, not policy prose.** `--token` arguments and the `tokens` / `login` /
  `logout` subcommands are rejected by the tool itself because they print or replace bearer
  credentials.
- **The approval toggle** is the agent's `VERCEL_CLI_REQUIRE_APPROVAL` secret: `0` disables the
  per-command gate; anything else (or unset) keeps it on. An agent that also holds the
  full-account token (the Vercel issuer) is always gated regardless of the toggle.
- **No token yet?** The tool answers with "no Vercel credential is configured". The fix is the
  provisioning flow: the agent delegates to the Vercel platform teammate, a human approves, and
  the token arrives via a queued redeploy — see the Vercel issuer agent template.
