import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

/**
 * The repository hierarchy is two-level (M5.8): repo pages at /repos/:projectId/..., a team
 * member's pages at /repos/:projectId/agents/:agentName/... Single-agent repos collapse to
 * the repo level. One module serves both levels via a second registration with an explicit
 * id (React Router requires unique ids; params.agentName distinguishes at runtime).
 */
const memberRoute = (tail: string, file: string, id: string) =>
  route(`repos/:projectId/agents/:agentName${tail}`, file, { id });

export default [
  // Front of House is home (FOH PRD §2.6): the three-pane operate surface at `/`, with the
  // agent/session panes as children (D14 URLs). Sign-in when unauthenticated.
  layout("routes/foh.tsx", [
    index("routes/foh._index.tsx"),
    // Static "activity" outranks the dynamic :agentId sibling in RR7 route ranking.
    route("t/:projectId/activity", "routes/foh.activity.tsx"),
    route("t/:projectId/:agentId", "routes/foh.agent.tsx", [
      index("routes/foh.agent._index.tsx"),
      route("s/:sessionId", "routes/foh.session.tsx"),
    ]),
  ]),
  // FOH resource routes: the streaming turn + stop for one repo's sessions, and the global
  // inbox badge/flyout endpoint (D12 polling).
  route("api/foh/inbox", "routes/api.foh.inbox.ts"),
  route("api/foh/:projectId/stream", "routes/api.foh.stream.ts"),
  route("api/foh/:projectId/stop", "routes/api.foh.stop.ts"),
  route("api/foh/:projectId/read", "routes/api.foh.read.ts"),
  // Marketing surface. The landing lives inside the FOH index route (host split, D11:
  // MARKETING_HOST serves it; every other host serves FOH). Case studies + sitemap +
  // robots stay pathname-routed with per-host behavior in their loaders.
  route("sitemap.xml", "routes/sitemap[.]xml.tsx"),
  route("robots.txt", "routes/robots[.]txt.tsx"),
  // Marketing case studies — index + one page per vertical.
  route("case-studies", "routes/case-studies.tsx"),
  route("case-studies/:slug", "routes/case-studies.$slug.tsx"),
  route("dashboard", "routes/dashboard.tsx"),
  // Recruit — the marketplace (PRD §7.8, M6). Browse (index.json) + a template detail page.
  route("marketplace", "routes/marketplace.tsx"),
  route("marketplace/:type/:id", "routes/marketplace.$type.$id.tsx"),
  route(
    "marketplace/:type/:id/install",
    "routes/marketplace.$type.$id.install.tsx",
  ),
  route("org/settings", "routes/org.settings.tsx"),
  // Shared workspaces (issue #56): the members/invite page, the multi-workspace chooser +
  // switch endpoint, and the shell switcher's data route.
  route("org/members", "routes/org.members.tsx"),
  route("workspaces", "routes/workspaces.tsx"),
  route("api/workspaces", "routes/api.workspaces.tsx"),
  route("connect", "routes/connect.tsx"),
  route(
    "github/installations/callback",
    "routes/github.installations.callback.tsx",
  ),
  // The product noun is REPOSITORY (one connected GitHub repo = a single agent or a team).
  // Param stays :projectId — internal identifiers didn't churn with the URL rename.
  route("repos/:projectId", "routes/projects.$projectId.tsx"),
  memberRoute("", "routes/projects.$projectId.tsx", "member-overview"),
  route(
    "repos/:projectId/deployment",
    "routes/projects.$projectId.deployments.tsx",
  ),
  memberRoute(
    "/deployment",
    "routes/projects.$projectId.deployments.tsx",
    "member-deployment",
  ),
  route("repos/:projectId/settings", "routes/projects.$projectId.settings.tsx"),
  memberRoute(
    "/settings",
    "routes/projects.$projectId.settings.tsx",
    "member-settings",
  ),
  route(
    "repos/:projectId/playground",
    "routes/projects.$projectId.playground.tsx",
  ),
  memberRoute(
    "/playground",
    "routes/projects.$projectId.playground.tsx",
    "member-playground",
  ),
  route("repos/:projectId/runs", "routes/projects.$projectId.runs.tsx"),
  memberRoute("/runs", "routes/projects.$projectId.runs.tsx", "member-runs"),
  route(
    "repos/:projectId/runs/:runId",
    "routes/projects.$projectId.runs.$runId.tsx",
  ),
  memberRoute(
    "/runs/:runId",
    "routes/projects.$projectId.runs.$runId.tsx",
    "member-run",
  ),
  route(
    "repos/:projectId/assistant",
    "routes/projects.$projectId.assistant.tsx",
  ),
  route(
    "repos/:projectId/assistant/config",
    "routes/projects.$projectId.assistant.config.tsx",
  ),
  // The assistant is project-level now; the old member-level tab 301s to the repo-level page.
  memberRoute(
    "/assistant",
    "routes/shims.member-assistant.tsx",
    "member-assistant",
  ),
  route(
    "repos/:projectId/resources/:category",
    "routes/projects.$projectId.resources.$category.tsx",
  ),
  memberRoute(
    "/resources/:category",
    "routes/projects.$projectId.resources.$category.tsx",
    "member-resources",
  ),
  route("repos/:projectId/edit", "routes/projects.$projectId.edit.tsx"),
  memberRoute("/edit", "routes/projects.$projectId.edit.tsx", "member-edit"),
  route(
    "repos/:projectId/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
  ),
  memberRoute(
    "/edit/instructions",
    "routes/projects.$projectId.edit.instructions.tsx",
    "member-edit-instructions",
  ),
  route(
    "repos/:projectId/edit/schedule",
    "routes/projects.$projectId.edit.schedule.tsx",
  ),
  memberRoute(
    "/edit/schedule",
    "routes/projects.$projectId.edit.schedule.tsx",
    "member-edit-schedule",
  ),
  // The model moved inline onto the overview; the old edit-agent page redirects there.
  route("repos/:projectId/edit/agent", "routes/legacy.edit-agent.tsx"),
  // Pre-M5.8 tab URLs — 301 into the new hierarchy (Changes/Versions → Deployment,
  // Secrets → Settings, ?agent= → /agents/:name).
  route("repos/:projectId/changes", "routes/shims.repo-tabs.tsx", {
    id: "shim-changes",
  }),
  route("repos/:projectId/deployments", "routes/shims.repo-tabs.tsx", {
    id: "shim-deployments",
  }),
  route("repos/:projectId/secrets", "routes/shims.repo-tabs.tsx", {
    id: "shim-secrets",
  }),
  // Staged-draft count for the nav pill (AgentNav); `?agent=` scopes to one member.
  route("repos/:projectId/staged-count", "routes/api.staged-count.tsx"),
  // Workspace task-progress indicator (issue #142): running + recent terminal merge/publish tasks
  // for this project. GET polls the list; POST intent=dismiss clears a terminal row.
  route("repos/:projectId/tasks", "routes/api.tasks.tsx"),
  // Invite-to-repo (FOH invites & roles): GET lists the repo team's pending invitations,
  // POST intent=invite sends one carrying the repo's teamId.
  route("api/repos/:projectId/invite", "routes/api.repos.$projectId.invite.ts"),
  // Quick deploy (AgentNav): GET returns the button's envs + staged count for the scope,
  // POST runs the whole Ship pipeline. `?agent=`/`agent` field scopes to one member.
  route("repos/:projectId/quick-deploy", "routes/api.quick-deploy.tsx"),
  // Playground streaming turn: the page POSTs here and reads an NDJSON stream of the turn.
  // Single registration — team-member selection travels as a form field, not a URL param.
  route(
    "api/repos/:projectId/playground/stream",
    "routes/api.projects.$projectId.playground.stream.ts",
  ),
  route(
    "api/repos/:projectId/playground/stop",
    "routes/api.projects.$projectId.playground.stop.ts",
  ),
  // Assistant streaming turn (project-level sibling of the playground stream).
  route(
    "api/repos/:projectId/assistant/stream",
    "routes/api.projects.$projectId.assistant.stream.ts",
  ),
  route("api/github/webhook", "routes/api.github.webhook.tsx"),
  // Per-agent GitHub App Manifest flow (issue #26): submit the manifest to GitHub, then
  // GitHub redirects back to the callback with a single-use code to convert.
  route("github/apps/new", "routes/github.apps.new.tsx"),
  route("github/apps/callback", "routes/github.apps.callback.tsx"),
  // One-click Discord channel (issue #32): harnesst's shared app. The relay is the app's single
  // Interactions Endpoint URL; connect/callback run the OAuth authorize + guild-command
  // registration; send is the control-plane proxy the discord-send-message tool calls.
  route("api/discord/interactions", "routes/api.discord.interactions.ts"),
  route("discord/connect", "routes/discord.connect.tsx"),
  route("discord/callback", "routes/discord.callback.tsx"),
  route("api/discord/send", "routes/api.discord.send.ts"),
  // Install-time auth-brokered connections (issue #30): harnesst brokers Google OAuth against the
  // operator's shared client. connect signs state + redirects to consent; callback exchanges the
  // code and seals the grant. The grant is injected as env at deploy so eve self-refreshes tokens.
  route("google/connect", "routes/google.connect.tsx"),
  route("google/callback", "routes/google.callback.tsx"),
  // Provider-generic connection broker (issue #163): one connect/callback pair for every
  // registered provider; /google/* stay as aliases for redirect-URI back-compat.
  route("connections/:provider/connect", "routes/connections.$provider.connect.tsx"),
  route("connections/:provider/callback", "routes/connections.$provider.callback.tsx"),
  // Instance token broker (issue #167): instances of access-token-broker providers (rotating
  // refresh grants — mayi) fetch fresh access tokens here with their EDEN_TEAM_TOKEN.
  route("api/connections/token", "routes/api.connections.token.ts"),
  // Brokered capabilities (issue #166): capability providers' whitelisted operations. Instances
  // POST typed inputs with their EDEN_TEAM_TOKEN; harnesst validates and executes with the
  // control-plane-held credential — the grant never reaches the container.
  route(
    "api/capabilities/:provider/:operation",
    "routes/api.capabilities.$provider.$operation.ts",
  ),
  // Post-consent resource picker (issue #166): a capability provider whose account spans several
  // provider-side resources (Xero organisations) picks the one this connection targets.
  route(
    "connections/:provider/resource",
    "routes/connections.$provider.resource.tsx",
  ),
  route("api/ingest/runs", "routes/api.ingest.runs.tsx"),
  // Hosted MCP Streamable HTTP transport. Bearer API keys are verified per stateless request.
  route("api/mcp", "routes/api.mcp.ts"),
  // Teammate delegation relay: a team member's ask-teammate tool POSTs here (Bearer token).
  route("api/team/ask", "routes/api.team.ask.ts"),
  // Built-in assistant callback API. The assistant instance's baked-in
  // tools + boot entrypoint call GET|POST /api/assistant/<action> with a Bearer assistant token.
  route("api/assistant/:action", "routes/api.assistant.$action.ts"),
  route("api/models", "routes/api.models.tsx"),
  // harnesst model gateway (issue #28): a deployed agent / the assistant set to a codex/<conn>/<slug>
  // model reaches this route (Bearer edng_ token) to run on the org's connected Codex subscription.
  route("api/gateway/v1/chat/completions", "routes/api.gateway.chat.ts"),
  // Runtime model resolution: a deployed agent's generated eden-model.ts asks (same Bearer
  // edng_ token) which model the workspace wants it on — per-agent override, else the default.
  route("api/gateway/v1/model-config", "routes/api.gateway.model-config.ts"),
  // Connect an OpenAI Codex subscription via device-code OAuth (Org settings dialog fetcher).
  route("api/connections/codex", "routes/api.connections.codex.ts"),
  // Better Auth's documented React Router resource route. The splat forwards every
  // /api/auth/* request to the single server auth instance.
  route("api/auth/*", "routes/api.auth.$.ts"),
  // Legacy URLs from before the repositories rename — 301 into /repos/.
  route("projects/:projectId/*", "routes/legacy.projects.tsx", {
    id: "legacy-projects-splat",
  }),
  route("projects/:projectId", "routes/legacy.projects.tsx", {
    id: "legacy-projects",
  }),
  route(
    "accept-invitation/:invitationId",
    "routes/accept-invitation.$invitationId.tsx",
  ),
  route("login", "routes/login.tsx"),
  route("signup", "routes/signup.tsx"),
  route("forgot-password", "routes/forgot-password.tsx"),
  route("reset-password", "routes/reset-password.tsx"),
] satisfies RouteConfig;
