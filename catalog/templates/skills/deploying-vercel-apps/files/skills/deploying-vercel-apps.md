---
description: Deploying and operating an app on Vercel — use when asked to ship, configure, or
  inspect a Vercel deployment.
---

# Deploying Vercel apps

All Vercel work goes through the Vercel CLI tool. The `vercel` command does not exist in your
shell and no credential is visible there — that is by design. Each tool call takes the CLI argv
plus a short justification; a human may review and approve the command before it runs, so write
justifications that let them decide quickly.

## Getting a project

You deploy into exactly one Vercel project, with access scoped to it alone. If the tool reports
that no credential is configured, you don't have a project yet: delegate to the Vercel platform
teammate with the project name you want, the framework, and the git repository if there is one.
Expect the answer "waiting on a human" — that is success, not failure. Report where things stand
and end your turn; access arrives while you're away (your environment restarts to receive it),
so pick the deployment work back up in a later turn.

## Deploying

- The first `deploy --yes` from your app directory uploads and builds it; `deploy --prod --yes`
  ships to production. There is no separate "create" step.
- Prefer git-connected deploys when a repository exists: `git connect --yes` links it, after
  which every push builds automatically and you use the tool mainly to configure, inspect, and
  promote.
- Configure environment variables with `env add` (values for the app you're deploying — never
  your own credentials) and check them with `env ls`.
- Inspect before you mutate: `inspect <deployment-url>` and `project ls` tell you what exists
  and what state it's in; verify rather than assume, especially before promoting or rolling
  back.
- For anything the CLI has no subcommand for, `api` calls the Vercel REST API under the same
  scoped access, e.g. `api /v9/projects/<name>`.

## Judgment

- Deploy previews freely; treat production deploys, rollbacks, and domain changes as actions
  worth double-checking — say what you're about to do in the justification.
- If a command is denied by the human, don't retry it unchanged; report the denial and adjust.
- Never ask anyone for a token and never try to read one; access is provisioned, not shared.
