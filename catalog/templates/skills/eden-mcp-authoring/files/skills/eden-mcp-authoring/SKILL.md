---
name: eden-mcp-authoring
description: Author, publish, and deploy eve agents through Eden's MCP tools. Use when creating or changing agent instructions, skills, tools, schedules, connections, channels, subagents, sandboxes, or agent.ts through a connected Eden project, including taking the change live through Eden's publish pipeline and confirming the deployment.
---

# Authoring eve agents with Eden MCP

Use Eden's MCP server for the complete delivery path:

1. discover the project and its agent layout;
2. author and stage complete file contents as saved drafts;
3. publish — one call runs Eden's whole pipeline (check, build, commit, version, deploy); and
4. poll every deployment until it is live or has failed.

Do not commit or push directly to the repository yourself. `stage_changes` and `publish_changes`
are the supported write path: staging saves drafts in Eden, and publishing commits them to the
default branch only after Eden's build passes. MCP clients may display a server prefix on these
names; the server-side names below are the contract.

## Preconditions and tool contract

The Eden API key needs `read`, `author`, and `deploy` scopes. The project needs a connected GitHub
repository. Never print the API key or put it in an authored file.

- `list_projects()`
- `list_agents({ projectId })`
- `list_releases({ projectId, agentId? })`
- `list_environments({ projectId, agentId? })`
- `stage_changes({ projectId, edits: [{ path, content, baseSha? }] })`
- `publish_changes({ projectId, environment? })`
- `discard_changes({ projectId, paths })`
- `deploy_team_version({ projectId, gitSha, environment, rebuild? })`
- `deploy_head({ projectId, environment })`
- `get_deploy_status({ deploymentId })`
- `retry_deployment({ deploymentId })`
- `clear_failed({ environmentId })`

`stage_changes` takes the complete UTF-8 content for every write and `null` for a deletion. Its
optional `baseSha` is a source-blob conflict hint, not a substitute for reading the source. Eden's
MCP server does not expose repository file contents. Before replacing an existing file, obtain its
current complete content through the client's repository/file access or from the user. If neither is
available, do not guess or silently overwrite it. Creating a new file from complete known content is
safe without a repository reader.

## Ground the authoring work

Call `list_projects` first and select the project explicitly; do not infer a project ID from its
display name. Use the returned `layout`, then call `list_agents` and use each returned `root`:

- a single-agent repository normally authors below `agent/`;
- a team member normally authors below `agents/<member>/agent/`;
- `agent.ts` and `instructions.md` live directly in that agent root;
- tools, skills, schedules, sandboxes, connections, channels, and subagents live in their eve
  directories beneath the root. Identity comes from the path, not a `name` or `id` field in the
  file.

Read the target agent's current instructions, config, manifests, and closest examples whenever the
client has repository access. Consult the installed eve version and the official docs before
authoring unfamiliar surfaces:

- project layout: https://eve.dev/docs/reference/project-layout
- tools: https://eve.dev/docs/tools; skills: https://eve.dev/docs/skills; schedules:
  https://eve.dev/docs/schedules
- sandboxes: https://eve.dev/docs/sandbox; connections: https://eve.dev/docs/connections;
  subagents: https://eve.dev/docs/subagents; channels: https://eve.dev/docs/channels/overview
- `agent.ts`: https://eve.dev/docs/agent-config; TypeScript API:
  https://eve.dev/docs/reference/typescript-api

Keep one working checklist for the requested behavior, exact paths, validation, and deploy.
Resolve material ambiguity before writing; otherwise make the smallest change consistent with the
request and nearby patterns.

## Author complete, valid files

Follow the existing project and installed eve version. In particular:

- Instructions and skills should ground behavior and boundaries without scripting every response.
  Give skills focused trigger descriptions in their frontmatter.
- Tools should use the eve `defineTool` shape and Zod input schema used by the repository. Keep each
  tool focused, make its description precise enough for model selection, and return useful failure
  information.
- Never hardcode or invent a secret. Read it as `process.env.SCREAMING_SNAKE_CASE` inside the
  execution path and report the exact secret names that a human must configure in Eden. Preserve an
  existing sandbox's `EDEN_SANDBOX_ENV` forwarding.
- Prefer `fetch` and Node built-ins. If a dependency is necessary and the client has a checkout,
  use that project's package manager so `package.json` and its lockfile stay synchronized, then
  stage their complete resulting contents. Without a checkout or complete current manifests, do not
  fabricate dependency files.
- Preserve unrelated content. A deletion is explicit: use `content: null` only when the user asked
  for it or it is required by the change.

Before publishing, validate in a checkout when one is available: install with the repository's
package manager, run its typecheck and lint scripts, run `npx eve build`, and exercise relevant
evals or a local eve instance. Static compilation is not behavioral proof. If no checkout exists,
state that local checks were unavailable; `publish_changes` still runs Eden's server-side build for
every affected agent root, and a failed build lands nothing.

## Stage one coherent change set

Call `stage_changes` with all complete edits that belong together. The staging area is shared per
project: `publish_changes` takes EVERYTHING saved live in one action, so anything you stage rides
with whatever else is already saved. Multiple staging calls are allowed when correcting an
unpublished draft, but they should still form one coherent change set.

Inspect the returned `drafts`: confirm every expected path and its `write` or `delete` operation.
The response intentionally does not echo file contents. If the request is abandoned before publish,
call `discard_changes` with every staged path. `discard_changes` removes unpublished drafts only.

## Publish — one call, the whole pipeline

When the change set is ready, call `publish_changes({ projectId })`. It runs Eden's full pipeline
synchronously: check the drafts, build every affected agent root, commit the whole saved set to the
project's default branch, cut a version per roster member, and queue a deploy of the WHOLE team
into the project's live environment. Pass `environment` only when the project has several
environments and Eden has no live environment recorded yet — the answer is remembered.

If the build fails, nothing lands: no commit, no version, no deploy, and every draft stays saved.
The error carries the compiler's own output. Correct the complete file contents with
`stage_changes`, revalidate, and call `publish_changes` again.

Record the returned `commitSha`, `releaseIds`, and `deploymentIds`. The commit sha is the version
identity that landed; the deployment ids are the queued team deploys to poll.

## Confirm the deployment

The team is the deployment unit. A publish deploys every roster member; never simulate a partial
team deploy.

1. For every entry in `deploymentIds`, call `get_deploy_status` until the status reaches `live` or
   `failed`. Deploys are asynchronous; `pending` and `building` are normal states. Poll at a
   moderate interval rather than queueing another deploy.
2. Treat the workflow as complete only when every deployment is `live`, its
   `deployment.release.gitSha` equals the returned commit sha, and the live URL is reported. Also
   surface `hasUnreleasedChanges` and `hasUndeployedRelease`; these drift flags are useful context
   but do not replace checking the requested deployment's status and SHA.

`deploy_team_version({ projectId, gitSha, environment })` moves the whole team to an EXISTING
version — the rollback/redeploy path. Reserve `rebuild: true` for an intentional rebuild of that
existing release. `deploy_head` cuts and queues a release from whatever commit is currently at the
connected default branch; use it only for an explicit HEAD deploy with nothing saved.

On `failed`, report `errorDetail`. If retry is appropriate, call `retry_deployment` with the failed
deployment ID, save the new returned deployment ID, and poll that new row. Use `clear_failed` with
the environment ID only when the user wants the failed state cleared without a retry. If Eden
reports `already_deploying`, do not submit another deploy; continue polling the deployment IDs
already known to the conversation, or report that an operator must identify the in-flight
deployment when its ID is unavailable.

## Finish with evidence

Report the published commit sha, release ids, deployed environment, every deployment ID and final
status/URL, validation performed, required secret names, and any live checks that were not
possible. Never claim the agent is live from a successful publish call alone — poll the
deployments.
