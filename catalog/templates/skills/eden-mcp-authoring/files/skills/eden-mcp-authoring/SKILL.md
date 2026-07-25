---
name: eden-mcp-authoring
description: Author, review, merge, and deploy eve agents through harnesst's MCP tools. Use when creating or changing agent instructions, skills, tools, schedules, connections, channels, subagents, sandboxes, or agent.ts through a connected harnesst project, including taking the change through one pull request and confirming the deployment is live.
---

# Authoring eve agents with harnesst MCP

Use harnesst's MCP server for the complete delivery path:

1. discover the project and its agent layout;
2. author and stage complete file contents;
3. publish the staged paths as one pull request;
4. review and merge that pull request;
5. deploy the exact reviewed merge; and
6. poll every deployment until it is live or has failed.

Do not commit or push directly to the repository's default branch. harnesst deliberately exposes no
direct-commit MCP tool. `stage_changes`, `publish_changes`, and `merge_change` are the supported
write path. MCP clients may display a server prefix on these names; the server-side names below are
the contract.

## Preconditions and tool contract

The harnesst API key needs `read`, `author`, and `deploy` scopes. The project needs a connected GitHub
repository and the target environment must already exist. Never print the API key or put it in an
authored file.

- `list_projects()`
- `list_agents({ projectId })`
- `list_releases({ projectId, agentId? })`
- `list_environments({ projectId, agentId? })`
- `stage_changes({ projectId, edits: [{ path, content, baseSha? }] })`
- `publish_changes({ projectId, paths, title? })`
- `list_open_changes({ projectId, limit? })`
- `merge_change({ projectId, pullRequestNumber })`
- `discard_changes({ projectId, paths })`
- `deploy_team_version({ projectId, gitSha, environment, rebuild? })`
- `deploy_head({ projectId, environment })`
- `get_deploy_status({ deploymentId })`
- `retry_deployment({ deploymentId })`
- `clear_failed({ environmentId })`

`stage_changes` takes the complete UTF-8 content for every write and `null` for a deletion. Its
optional `baseSha` is a source-blob conflict hint, not a substitute for reading the source. harnesst's
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

Keep one working checklist for the requested behavior, exact paths, validation, review, and deploy.
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
  execution path and report the exact secret names that a human must configure in harnesst. Preserve an
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
state that local checks were unavailable; `publish_changes` still runs harnesst's server-side build gate
for affected agent roots.

## Stage one coherent change set

Call `stage_changes` with all complete edits that belong together. Use the exact normalized paths
you intend to publish and retain that path list. Multiple staging calls are allowed when correcting
an unpublished draft, but they should still form one coherent change set.

Inspect the returned `drafts`: confirm every expected path and its `write` or `delete` operation.
The response intentionally does not echo file contents. If the request is abandoned before publish,
call `discard_changes` with every staged path. `discard_changes` removes unpublished drafts only; it
does not close or alter a pull request.

## Publish exactly one pull request

When the full change set is ready, call `publish_changes` once with `paths` containing every staged
path and a concise title. Publishing selected drafts creates one fresh `eden/publish-*` branch, one
commit, and one pull request targeting the project's configured default branch. It never writes
directly to that branch.

If harnesst's build gate rejects the change, no branch or pull request is created and the drafts remain
staged. Correct the complete file contents with `stage_changes`, revalidate, and call
`publish_changes` again with the same full path set. Do not split one requested delivery into several
pull requests merely to work around a validation failure.

Record the returned `change.pullRequestNumber`, `change.pullRequestUrl`, `change.branch`, and
`change.base`. Do not call `publish_changes` again after it succeeds: the MCP surface intentionally
does not amend or close an already-open pull request.

## Review, then merge

Call `list_open_changes` and select the exact pull request number returned by `publish_changes`.
Review its title, body, base, branch, draft state, mergeability, and every `files` entry. Read each
available `patch`; if GitHub omitted a patch for a binary or oversized file, use the returned PR URL
and another authorized review surface rather than treating absence as approval.

Confirm all of the following before merge:

- the base is the project's default branch and the branch is the returned harnesst branch;
- the changed paths and patches implement the request without unrelated or secret content;
- validation evidence is adequate for the risk;
- the PR is not a draft, is mergeable, and required human or policy approval is complete.

Do not equate the ability to call `merge_change` with approval to merge. When review is complete and
the caller is authorized to merge, call `merge_change({ projectId, pullRequestNumber })`. harnesst
resolves the branch server-side and refuses a PR that is not an open harnesst change targeting that
project's default branch. Save `merge.mergeSha`; it is the reviewed version to deploy.

If a human merges outside the MCP client, wait for the PR to disappear from `list_open_changes` and
obtain the merged commit SHA from the reviewed PR surface. Do not deploy an unverified guess.

## Deploy the reviewed merge

The team is the deployment unit. A deploy targets every roster member that has the named
environment; never simulate a partial team deploy.

1. Call `list_environments` and choose the environment name deliberately. Do not infer production
   intent from a project name.
2. Poll `list_releases` until the releases for the affected roster members contain the saved merge
   SHA. Release creation after merge may be asynchronous.
3. Call `deploy_team_version({ projectId, gitSha: mergeSha, environment })`. This pins the deploy to
   the reviewed commit. Reserve `rebuild: true` for an intentional rebuild of that existing release.
4. Check the returned `skipped` list. It should be empty; report every skipped member as an
   incomplete team deploy.
5. For every entry in `deployed`, save its `deploymentId` and call `get_deploy_status` until the
   status reaches `live` or `failed`. Deploy calls return immediately; `pending` and `building` are
   normal asynchronous states. Poll at a moderate interval rather than queueing another deploy.
6. Treat the workflow as complete only when every deployment is `live`, its
   `deployment.release.gitSha` equals the saved merge SHA, and the live URL is reported. Also surface
   `hasUnreleasedChanges` and `hasUndeployedRelease`; these drift flags are useful context but do not
   replace checking the requested deployment's status and SHA.

`deploy_head` cuts and queues a release from whatever commit is currently at the connected default
branch. Use it only for an explicit HEAD deploy when the user accepts that the branch may have moved;
for a just-reviewed PR, `deploy_team_version` with the saved merge SHA is the safer default.

On `failed`, report `errorDetail`. If retry is appropriate, call `retry_deployment` with the failed
deployment ID, save the new returned deployment ID, and poll that new row. Use `clear_failed` with
the environment ID only when the user wants the failed state cleared without a retry. If harnesst reports
`already_deploying`, do not submit another deploy; continue polling the deployment IDs already known
to the conversation, or report that an operator must identify the in-flight deployment when its ID
is unavailable.

## Finish with evidence

Report the pull request URL and number, review/merge outcome and merge SHA, deployed environment,
every deployment ID and final status/URL, validation performed, required secret names, skipped team
members, drift flags, and any live checks that were not possible. Never claim the agent is live from
a successful publish, merge, or queued deploy alone.
