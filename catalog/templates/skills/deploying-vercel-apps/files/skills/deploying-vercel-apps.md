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

- Deploy git-connected: push your code to the repository, link it with `git connect --yes`, and
  every push builds automatically; use the tool mainly to configure, inspect, and promote.
- The tool runs OUTSIDE your sandbox shell: a `cwd` pointing at files you created in your
  workspace will not resolve there. That is why file-upload `deploy` of workspace code does not
  work — get code into the git repository and let Vercel build from it.
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
