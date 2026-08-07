/**
 * harnesst control-plane schema (Drizzle + Postgres).
 *
 * Scope rules (see docs/PRD.md §9 cross-cutting concerns):
 *  - D2: a Better Auth Organization == a harnesst tenant. Better Auth owns users,
 *    organizations, memberships, invitations, and sessions; harnesst's operational tables
 *    reference those generated canonical tables directly.
 *  - D3: the eve repo is the single source of truth. We DO NOT store agent config here —
 *    only pointers (repo coordinates, git SHAs, image refs) and operational state.
 *  - D9: a Release = an immutable merge-commit + content-addressed image. Deployments bind a
 *    release to an environment with a traffic weight for the multi-version splitter (D9/D10).
 *
 * IDs: every PK we mint is `varchar("id", { length: 12 }).primaryKey().$defaultFn(newId)`
 * with `newId` from ~/lib/id (12-char [a-zA-Z] nanoid). Better Auth owns its text IDs.
 * Legacy UUID rows were rewritten to nanoids in a one-off dev-DB pass (2026-07-04).
 */
import { sql } from "drizzle-orm";

// Type-only (erased at runtime, so no import cycle): the publish pipeline's step shape.
import type { PipelineStep } from "~/data/ports";
import { newId } from "~/lib/id";
import {
  organization,
  session as authSession,
  team,
  user,
} from "./auth-schema";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export * from "./auth-schema";

/**
 * Verified tenant grants for GitHub App installations. `installationId` is raw GitHub data and
 * must never cross the server boundary; browsers and projects refer only to this row's opaque id.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    /** GitHub account (org/user login) the app is installed on, for display. */
    accountLogin: text("account_login"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByUserId: text("verified_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("github_installations_org_install_uq").on(
      t.orgId,
      t.installationId,
    ),
    unique("github_installations_org_id_id_uq").on(t.orgId, t.id),
  ],
);

/** One-use, session-bound state for the GitHub App install + user OAuth proof flow. */
export const githubInstallationStates = pgTable(
  "github_installation_states",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => authSession.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    codeVerifier: text("code_verifier").notNull(),
    candidateInstallationId: text("candidate_installation_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("github_installation_states_expires_idx").on(t.expiresAt)],
);

/**
 * Discord connections (issue #32). harnesst owns ONE shared Discord app per installation; a user
 * authorizes it into their server and harnesst registers a guild slash command named after the
 * agent. This row binds (guild, command) → the agent/environment it routes to, so the
 * interactions relay can look up the target deployment. The bot token is never stored here (or
 * anywhere per-agent) — it lives only in control-plane env.
 *
 * Unique on (guildId, commandName): a slash command name is unique within a Discord server, so
 * two agents can't both claim `/x` in one guild — the connect flow refuses the collision.
 */
export const discordConnections = pgTable(
  "discord_connections",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    environmentId: varchar("environment_id", { length: 12 })
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** The Discord server (guild) the app was authorized into. */
    guildId: text("guild_id").notNull(),
    /** The guild's display name at connect time (best-effort, display-only). */
    guildName: text("guild_name"),
    /** The registered slash command name (harnesst derives it from the agent name). */
    commandName: text("command_name").notNull(),
    /** Discord's id for the registered command, for dedup/cleanup on disconnect. */
    commandId: text("command_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("discord_connections_guild_command_uq").on(
      t.guildId,
      t.commandName,
    ),
  ],
);

/**
 * Auth-brokered connection grants (issue #30). When an agent installs a connector like Google
 * Sheets from the marketplace, the install wizard runs a harnesst-brokered OAuth flow against the
 * operator's OAuth client; the resulting refresh token lands here, sealed with the same
 * AES-256-GCM secretbox that protects `secret_values`. Deploy unseals it, validates it once, and
 * injects the operator client creds + refresh token as env so the shipped eve connection file can
 * self-refresh access tokens at runtime (no control-plane dependency per turn).
 *
 * Phase 1 grants are APP-SCOPED: one shared grant per (agent, provider), captured at install time,
 * used by every session. The plaintext columns (provider, accountEmail, scopes, status) are
 * display/UX only — they drive the wizard's "Connected as …" line and the Deployment tab's
 * Reconnect affordance; only the sealed token is ever a secret.
 *
 * Scope is (projectId, agentId, environmentId, provider) with a nulls-not-distinct unique index —
 * matching the secrets scope convention. `environmentId` is nullable and always null in Phase 1
 * (grant applies to every environment); it exists now so a future per-environment grant needs no
 * migration.
 */
export const connectionGrants = pgTable(
  "connection_grants",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** null = applies to every environment (always null in Phase 1). */
    environmentId: varchar("environment_id", { length: 12 }).references(
      () => environments.id,
      { onDelete: "cascade" },
    ),
    /** Connector provider id, e.g. "google". */
    provider: varchar("provider", { length: 32 }).notNull(),
    /** The connected account's email, for display ("Connected as …"). Best-effort, nullable. */
    accountEmail: text("account_email"),
    /** Scopes actually granted, space-separated as the provider returned them. */
    scopes: text("scopes").notNull(),
    /** "active" | "expired" | "revoked" — display + deploy-guard state, not a secret. */
    status: varchar("status", { length: 16 }).notNull().default("active"),
    /**
     * Per-grant OAuth client id from dynamic registration at connect time (issue #167). Null =
     * the operator-level shared client (every provider before #167 — no behavior change). Token
     * exchange and every later refresh use the grant's own client when set.
     */
    clientId: text("client_id"),
    /**
     * Provider-side resource binding (issue #166): the resource a capability provider's calls
     * target — Xero's tenant id, sent as `xero-tenant-id` on every API call. Bound by the
     * connect callback (auto when the account has exactly one resource, else via the post-consent
     * picker). Null for providers whose capability declares no resource, and for all
     * non-capability providers. `resourceName` is display-only ("Connected to Acme Ltd").
     */
    resourceId: text("resource_id"),
    resourceName: text("resource_name"),
    /** Sealed OAuth refresh token (AES-256-GCM, same secretbox as secret_values). */
    refreshTokenCiphertext: text("refresh_token_ciphertext").notNull(),
    refreshTokenIv: text("refresh_token_iv").notNull(),
    refreshTokenAuthTag: text("refresh_token_auth_tag").notNull(),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("connection_grants_scope_uq")
      .on(t.projectId, t.agentId, t.environmentId, t.provider)
      .nullsNotDistinct(),
  ],
);

/**
 * Capability-call audit log (issue #166). One row per capability request that passed delegation
 * auth — allowed, refused, or errored — so every whitelisted operation an agent reaches through
 * `POST /api/capabilities/:provider/:operation` is queryable forever. `inputSummary` is the
 * OPERATION-DEFINED redacted digest (e.g. `{ contact, total, currency }` for a bill), never the
 * raw payload and never attachment bytes. Agent/deployment FKs `set null` so the audit trail
 * survives roster and deployment cleanup. Append-only; no UI yet (queryable by design).
 */
export const capabilityCalls = pgTable(
  "capability_calls",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    deploymentId: varchar("deployment_id", { length: 12 }).references(
      () => deployments.id,
      { onDelete: "set null" },
    ),
    provider: varchar("provider", { length: 32 }).notNull(),
    operation: text("operation").notNull(),
    /** The operation's group, or null when the request named an unknown operation. */
    groupId: text("group_id"),
    /**
     * "ok" | "refused" | "error" | "pending" — "pending" is the write-ahead state inserted
     * BEFORE the vendor operation runs (a mutation can never exist without a queryable row);
     * a row stuck on it means the control plane died mid-execution.
     */
    outcome: varchar("outcome", { length: 16 }).notNull(),
    /** Refusal/error text returned to the caller; null for "ok". */
    error: text("error"),
    /** Operation-defined redacted input digest — never the raw payload. */
    inputSummary: jsonb("input_summary")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("capability_calls_agent_created_idx").on(t.agentId, t.createdAt),
  ],
);

/**
 * One-time OAuth state nonces for control-plane connection flows. The signed state carries the
 * nonce; an atomic delete on callback makes it impossible to replay, while the Better Auth FKs
 * invalidate outstanding flows when their initiating user or session is removed.
 */
export const connectionOauthStates = pgTable(
  "connection_oauth_states",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => authSession.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("connection_oauth_states_expires_idx").on(t.expiresAt)],
);

/**
 * The workspace a user last worked in. Better Auth keeps `activeOrganizationId` on the SESSION,
 * so every fresh sign-in (new device, expired session, post-password-reset revocation) starts
 * org-less; this row lets `ensureWorkspace` return a multi-workspace user to their last
 * workspace instead of the chooser. Cascades keep it consistent: a deleted org or user simply
 * forgets the preference.
 */
export const userWorkspaceMemory = pgTable("user_workspace_memory", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  lastOrgId: text("last_org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  updatedAt: updatedAt(),
});

/** A project == one connected eve repo. */
export const projects = pgTable(
  "projects",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** Persisted repository shape; unlike the roster, this remains meaningful at zero members. */
    layout: text("layout").notNull().default("single"),
    /**
     * FOH repo scoping (D9): the Better Auth team mirroring this repo — a workspace `member`
     * sees a repo in front of house iff they belong to its team. Created by `ensureProjectTeam`
     * (on connect, on invite, or lazily from the FOH loader), so pre-teams rows stay null until
     * first touched.
     */
    teamId: text("team_id").references(() => team.id, { onDelete: "set null" }),
    // GitHub coordinates. repoInstallationId is an opaque verified github_installations.id grant.
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoInstallationId: text("repo_installation_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    /**
     * The environment Publish deploys into (§2.8: never ask which environment more than once).
     * Null until first resolved — a single-env project persists its only env name on first
     * publish; a multi-env project persists the user's one-time answer from the publish panel.
     */
    liveEnvironmentName: text("live_environment_name"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug),
    foreignKey({
      name: "projects_org_repo_installation_fk",
      columns: [t.orgId, t.repoInstallationId],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
    }).onDelete("restrict"),
  ],
);

/**
 * An agent — a member of a project's roster (PRD §7.9 / Milestone 5.5). A single-agent repo
 * is a team of one (`name: "agent"`, `root: "agent"`); a team repo has one row per
 * `agents/<member>/agent/` directory. Everything downstream (environments, releases, runs,
 * drafts, secrets) keys by agent, never by project — the hard-committed schema split.
 * `root` is the repo-relative agent directory the member's config lives under.
 */
export const agents = pgTable(
  "agents",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    root: text("root").notNull(),
    /**
     * A rename in flight (team members): the roster name the saved directory move will land.
     * Set the moment the rename's file set is saved as drafts (settings.tsx); the roster sync
     * maps the old row to this name IN PLACE once the published tree shows the new
     * `agents/<pendingName>/` directory and the old one gone, then clears it — so the row id,
     * and every FK to it (environments, releases, secrets, drafts, …), survives the rename.
     * Null when no rename is pending. Root single-agent renames are instant (name is decoupled
     * from the directory) and never set this.
     */
    pendingName: text("pending_name"),
    /**
     * Roster classification. `member` is a normal roster agent detected from the repo tree
     * (the default — every synced row). `assistant` is harnesst's built-in, project-level authoring
     * agent: one per project, created lazily, NEVER detected from the tree, so it must be
     * exempt from the roster prune in `syncRoster` and filtered out of every roster-facing
     * surface (team cards, switcher, teammate delegation, secrets scoping). It still keys
     * environments/releases/deployments/drafts like any agent, which is how it reuses the
     * whole deploy substrate for free.
     */
    kind: text("kind").notNull().default("member"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agents_project_name_uq").on(t.projectId, t.name)],
);

/**
 * Every per-agent GitHub App created through the manifest flow. Unlike the active credentials in
 * the secret store, these identities are append-only: replacing an App marks the outgoing row as
 * superseded so harnesst can keep warning about the App GitHub may still have installed.
 */
export const agentGithubApps = pgTable(
  "agent_github_apps",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Raw GitHub App id and slug are identities, not credentials. */
    appId: text("app_id").notNull(),
    slug: text("slug").notNull(),
    /** Needed to link to the correct user/org-owned GitHub App settings page. */
    ownerLogin: text("owner_login"),
    ownerType: text("owner_type"),
    /** Null while the callback has durably recorded creation but not committed all secret writes. */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_github_apps_agent_app_uq").on(t.agentId, t.appId),
    uniqueIndex("agent_github_apps_current_agent_uq")
      .on(t.agentId)
      .where(sql`${t.activatedAt} is not null and ${t.supersededAt} is null`),
    index("agent_github_apps_agent_created_idx").on(t.agentId, t.createdAt),
  ],
);

/** A deploy environment for an agent (e.g. production, staging). Per-agent by decision (§7.9). */
export const environments = pgTable(
  "environments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Monotonic desired-state version for everything projected into the instance process env.
     * Credential/config writers bump this; a deployment records the version it resolved.
     */
    envRevision: integer("env_revision").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("environments_agent_name_uq").on(t.agentId, t.name)],
);

/**
 * An immutable Release (D9): a merge-commit + content-addressed image. `version` is the
 * human label (v1, v2). Never mutated after creation; rollback re-points a deployment.
 */
export const releases = pgTable(
  "releases",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    gitSha: text("git_sha").notNull(),
    imageRef: text("image_ref"),
    changelog: text("changelog"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("releases_agent_version_uq").on(t.agentId, t.version),
    index("releases_project_idx").on(t.projectId),
    index("releases_agent_idx").on(t.agentId),
  ],
);

/**
 * Binds a release to an environment. The PRODUCT model is one live deployment per environment
 * (M6): a deploy that lands live demotes the env's other live rows (cutover, controller-
 * enforced — no unique constraint, since a cutover transiently has two live rows). The DATA
 * model still admits multi-version-live behind a weighted, session-sticky splitter (D9/D10);
 * `trafficWeight` is a relative integer the ingress splitter normalizes across active rows.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    environmentId: varchar("environment_id", { length: 12 })
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    releaseId: varchar("release_id", { length: 12 })
      .notNull()
      .references(() => releases.id, { onDelete: "restrict" }),
    // pending | building | live | draining | stopped | failed
    status: text("status").notNull().default("pending"),
    trafficWeight: integer("traffic_weight").notNull().default(100),
    url: text("url"),
    /** Why the deployment failed (build/deploy error surface for the UI). */
    errorDetail: text("error_detail"),
    /** The environment envRevision captured immediately before this deployment resolves env. */
    envRevision: integer("env_revision").notNull().default(0),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("deployments_environment_idx").on(t.environmentId),
    // At most one in-flight (pending/building) deployment per environment: two concurrent
    // provision requests can both read "no in-flight row" before either inserts one (#31), and
    // only the database can enforce the invariant atomically. Queued/live/stopped/failed rows
    // are unconstrained — a cutover transiently has two live rows.
    uniqueIndex("deployments_env_inflight_uq")
      .on(t.environmentId)
      .where(sql`${t.status} in ('pending', 'building')`),
  ],
);

/**
 * Saved, unpublished edits (issue #225). One row per (project, path), latest content wins.
 * Saving an editor (or an assistant turn's sync) writes a draft here — no git write. The header
 * Publish control lists every saved draft; Publish takes ALL of them through the pipeline
 * (check → build → commit → version → deploy) and deletes the published rows. The repo stays
 * the source of truth for published config — this table only ever holds in-flight edits, and
 * rows are short-lived.
 */
export const draftChanges = pgTable(
  "draft_changes",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The roster member the path belongs to (derived from the path's agent root). Null for
     * project-shared files outside every member (e.g. the root package.json).
     */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    /** Repo-relative path under the agent's root (e.g. "agent/instructions.md"). */
    path: text("path").notNull(),
    /**
     * Full new file contents (drafts are whole-file, like the editors). NULL saves a
     * DELETION of the path — deletes ride the same save → publish rails as edits instead
     * of landing on the spot.
     */
    content: text("content"),
    /** Blob sha of the file when the edit was made (null = new file); future conflict hints. */
    baseSha: text("base_sha"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("draft_changes_project_path_uq").on(t.projectId, t.path)],
);

/**
 * Secret METADATA only (D3 + SecretsProvider seam): names/scope/audit, never
 * values. Values live in the SecretsProvider (local no-op for OSS, KMS/Vault for managed).
 */
export const secretsMetadata = pgTable(
  "secrets_metadata",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * Owning roster member, OR null for a PROJECT-LEVEL shared secret (defined once, attached to
     * members via `secret_attachments`). A concrete agentId scopes the secret to one member (PRD
     * §7.9 — teammates never share credentials by default); null is the opt-in shared surface.
     */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    // null environmentId == agent-wide secret (all of that agent's environments)
    environmentId: varchar("environment_id", { length: 12 }).references(
      () => environments.id,
      {
        onDelete: "cascade",
      },
    ),
    key: text("key").notNull(),
    /**
     * Expose this secret to the agent's SANDBOX shell (not just its tools). Deploys join the
     * exposed names into HARNESST_SANDBOX_ENV — the allowlist the scaffolded sandbox.ts forwards
     * into the sandbox env (~/eve/templates). Metadata, not a value: it lives here (never in
     * the SecretsProvider) so exposure survives provider swaps and value rotations.
     * For SHARED secrets this is only the DEFAULT seeded into new attachments — the authoritative
     * per-member flag lives on `secret_attachments.sandboxExposed` (never retro-applied).
     */
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    /**
     * Full SHA-256 hex of the plaintext, computed server-side at write time (never the value).
     * Lets the UI show "fp a3f9c2" so a human can compare against a value they hold without ever
     * revealing the stored one. Null for rows written before fingerprints existed (backfill-free).
     */
    fingerprint: text("fingerprint"),
    updatedBy: text("updated_by").references(() => user.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("secrets_agent_scope_key_uq")
      .on(t.projectId, t.agentId, t.environmentId, t.key)
      .nullsNotDistinct(),
  ],
);

/**
 * Observability index (D8). One row per agent run; heavy transcript/span data lives in the
 * runs store / OTLP sink (TelemetrySink seam). This table is the queryable index for the
 * Run list + compare-by-version views.
 */
export const runs = pgTable(
  "runs",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Roster member the run belongs to; nullable — telemetry may arrive unattributed. */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    deploymentId: varchar("deployment_id", { length: 12 }).references(
      () => deployments.id,
      {
        onDelete: "set null",
      },
    ),
    releaseId: varchar("release_id", { length: 12 }).references(
      () => releases.id,
      {
        onDelete: "set null",
      },
    ),
    sessionId: varchar("session_id", { length: 12 }),
    // Correlates to the eve/Workflow run id in the telemetry store.
    externalRunId: text("external_run_id"),
    channel: text("channel"),
    // running | completed | failed
    status: text("status").notNull().default("running"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    wallClockMs: integer("wall_clock_ms"),
    error: text("error"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_project_started_idx").on(t.projectId, t.startedAt),
    index("runs_agent_started_idx").on(t.agentId, t.startedAt),
    index("runs_release_idx").on(t.releaseId),
    uniqueIndex("runs_external_uq").on(t.projectId, t.externalRunId),
  ],
);

/**
 * Observability: a Session is a durable conversation/task; each triggering input creates a
 * Run (indexed in `runs`); a Run has ordered Steps. (PRD §7.6, ARCH §3.7.)
 */
export const sessions = pgTable(
  "sessions",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    externalSessionId: text("external_session_id"),
    trigger: text("trigger"),
    channel: text("channel"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("sessions_project_started_idx").on(t.projectId, t.startedAt),
    unique("sessions_external_uq")
      .on(t.projectId, t.externalSessionId)
      .nullsNotDistinct(),
  ],
);

/**
 * Ordered steps within a Run: model calls, tool calls, reasoning, messages. Common scalar
 * fields are columns for filtering; the full per-step payload (messages, args, output) is in
 * `data` (jsonb). The system prompt is reconstructed from the Run's Release commit, not stored.
 */
export const runSteps = pgTable(
  "run_steps",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    runId: varchar("run_id", { length: 12 })
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    // model_call | tool_call | reasoning | message
    type: text("type").notNull(),
    model: text("model"),
    toolName: text("tool_name"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    durationMs: integer("duration_ms"),
    isError: boolean("is_error").notNull().default(false),
    approvalGated: boolean("approval_gated").notNull().default(false),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
  },
  (t) => [index("run_steps_run_seq_idx").on(t.runId, t.seq)],
);

/**
 * Per-eve-session reconcile cursor for the channel-run reconciler (issue #119): how far into a
 * session's durable replay stream the reconciler has folded runs, plus session state (modelId)
 * that lives before the cursor. One row per (project, eve session). Cron/Discord/other-channel
 * turns produce no in-process telemetry (only playground does), so a background loop pulls eve's
 * durable stream and folds it into runs — this cursor makes that drain incremental + idempotent.
 */
export const runReconcileCursors = pgTable(
  "run_reconcile_cursors",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    externalSessionId: text("external_session_id").notNull(),
    streamIndex: integer("stream_index").notNull().default(0),
    state: jsonb("state")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("run_reconcile_cursors_session_uq").on(
      t.projectId,
      t.externalSessionId,
    ),
  ],
);

/**
 * Per-project ingest tokens for the authenticated OTLP/runs endpoint (ARCH §3.7). BYO
 * instances ship telemetry back with one of these Bearer tokens. Only the hash is stored.
 */
export const ingestTokens = pgTable(
  "ingest_tokens",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("ingest_tokens_project_idx").on(t.projectId)],
);

/**
 * User-issued API credentials for hosted machine clients such as harnesst's MCP server. The key is
 * tenant- and user-scoped: verification requires the issuing user to still belong to the org.
 * Plaintext is returned only at creation; this table stores the shared `edn_` token digest.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("api_keys_org_created_idx").on(t.orgId, t.createdAt),
    index("api_keys_user_idx").on(t.userId),
  ],
);

/**
 * Encrypted secret VALUES for the OSS local SecretsProvider. Managed uses KMS/Vault instead
 * (same seam), so this table is only populated by the local provider. Values are AES-256-GCM
 * encrypted with `HARNESST_SECRETS_KEY`; we store ciphertext + iv + auth tag, never plaintext.
 * `secrets_metadata` remains the name/audit index; this is the value store behind the seam.
 */
export const secretValues = pgTable(
  "secret_values",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Owning member, OR null for a project-level shared secret (mirrors secrets_metadata). */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "cascade",
    }),
    environmentId: varchar("environment_id", { length: 12 }).references(
      () => environments.id,
      {
        onDelete: "cascade",
      },
    ),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("secret_values_agent_scope_key_uq")
      .on(t.projectId, t.agentId, t.environmentId, t.key)
      .nullsNotDistinct(),
  ],
);

/**
 * Per-agent opt-in to a project-level SHARED secret (§4.3). Attachment is BY NAME — it covers
 * every env row of the shared secret with that key. `sandboxExposed` is the AUTHORITATIVE
 * sandbox flag for the shared secret on this member (seeded from the shared default at attach
 * time, never retro-applied). A concrete agent-level secret with the same name shadows the
 * attachment at resolve (precedence, §5); the attachment row simply lies dormant.
 */
export const secretAttachments = pgTable(
  "secret_attachments",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("secret_attachments_agent_key_uq").on(t.agentId, t.key)],
);

/**
 * A dismissed template requirement (§7): the human marked a required-but-unset secret as "not
 * needed" for this member, so it stops surfacing as a missing-required row and stops gating the
 * deploy guard. Recoverable (never a hard delete of anything) — removing the row restores the
 * requirement. Implementer's choice per §7 (a small table over a JSON column: isolated, cascades
 * cleanly, and doesn't widen the widely-typed `agents` row).
 */
export const secretRequirementDismissals = pgTable(
  "secret_requirement_dismissals",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("secret_req_dismissals_agent_key_uq").on(t.agentId, t.key),
  ],
);

/**
 * Sealed secret values HELD for a new-member install (§4.4). An agent template installs as a new
 * roster member whose `agents` row doesn't exist until the change ships, so the wizard can't key
 * the secret to an agent yet. It stashes the sealed value here (same secretbox as `secret_values`),
 * keyed by the roster NAME the install will create; the value migrates into
 * `secret_values`/`secrets_metadata` the moment that member's agent row appears (syncRoster), and
 * is discarded if the install/draft is abandoned. Never surfaced to a client.
 */
export const pendingSecrets = pgTable(
  "pending_secrets",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The roster member name the install will create (agents/<name>/…). */
    memberName: text("member_name").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    /** SHA-256 hex of the held plaintext — carried into secrets_metadata at ship (§4.1). */
    fingerprint: text("fingerprint"),
    sandboxExposed: boolean("sandbox_exposed").notNull().default(false),
    /** Set when the wizard recorded "use the project-level shared secret" instead of a value. */
    attachShared: boolean("attach_shared").notNull().default(false),
    createdBy: text("created_by").references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("pending_secrets_scope_key_uq").on(
      t.projectId,
      t.memberName,
      t.key,
    ),
  ],
);

/**
 * Registered schedules for the Scheduler seam. OSS persists them for visibility; managed's
 * scheduler reads this to wake scaled-to-zero instances at cron time (ARCH §3.3).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    deploymentId: varchar("deployment_id", { length: 12 })
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    name: text("name"),
    createdAt: createdAt(),
  },
  (t) => [index("schedules_deployment_idx").on(t.deploymentId)],
);

/**
 * Per-tenant spend controls (managed mode — ARCH §3.2/§3.4/§8). The model gateway checks these
 * before allowing a turn: a monthly token cap and a kill-switch. OSS leaves rows absent
 * (unlimited). Keyed by Better Auth organization id.
 */
export const spendLimits = pgTable("spend_limits", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  monthlyTokenCap: integer("monthly_token_cap"),
  killSwitch: boolean("kill_switch").notNull().default(false),
  updatedAt: updatedAt(),
});

/**
 * Operational audit log (ARCH §3.8) — deploys, rollbacks, secret changes, spend-limit edits.
 * This is the audit of *operations*; authentication state is owned by Better Auth. Keyed by org.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target: text("target"),
    meta: jsonb("meta")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_org_created_idx").on(t.orgId, t.createdAt)],
);

/**
 * Raw usage events (MeteringSink seam). OSS records them locally for visibility; managed
 * aggregates and pushes Stripe usage records (ARCH §3.4). Kept append-only.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    deploymentId: varchar("deployment_id", { length: 12 }).references(
      () => deployments.id,
      {
        onDelete: "set null",
      },
    ),
    // model_tokens | compute_seconds | sandbox_exec
    kind: text("kind").notNull(),
    quantity: integer("quantity").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    meta: jsonb("meta")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [index("usage_events_org_at_idx").on(t.orgId, t.at)],
);

/**
 * Durable background jobs (control-plane work queue). Builds/deploys run here, not in HTTP
 * request handlers: GitHub webhooks time out at ~10s while an `eve build` takes minutes, and
 * a queued job survives a server restart. Claimed with FOR UPDATE SKIP LOCKED (single-worker
 * semantics per job, N workers safe).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    // e.g. deploy_release
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // queued | running | done | failed
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Earliest time the job may run (backoff on retry). */
    runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);

/**
 * User-facing projection of long-running workspace work (issue #142). The `jobs` table above stays
 * the ops primitive — durable queue, retries, worker claim; this table is the small, project-scoped
 * record the publish control and task indicator read and poll. One row per triggered action
 * (a publish): the runner records its structured `steps` here and resolves the row to a terminal
 * `status` (succeeded|failed) with a `resultUrl`/`error`. The indicator renders running + recent
 * terminal rows for the current project until the user dismisses a terminal one. Kept separate from
 * `jobs` so the queue can carry ops concerns (retry/backoff, arbitrary kinds) without leaking them
 * into the UI, and so a job that internally treats a build failure as a *successful* run (the
 * user's change simply didn't build) can still surface that as a `failed` task.
 */
export const workspaceTasks = pgTable(
  "workspace_tasks",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // publish (extensible)
    kind: text("kind").notNull(),
    // Dedupe/running-state key for the trigger surface, e.g. "publish" (one per project).
    subjectKey: text("subject_key").notNull(),
    // Human title, e.g. `Publishing 3 changes`
    label: text("label").notNull(),
    /**
     * The pipeline's ordered step list (check → build → commit → version → deploy), updated in
     * place as it runs. ONE source of truth for progress: the compact header control derives its
     * one-liner from the running step, the publish panel renders the full stepper.
     */
    steps: jsonb("steps").$type<PipelineStep[]>(),
    // running | succeeded | failed
    status: text("status").notNull().default("running"),
    originUrl: text("origin_url").notNull(),
    resultUrl: text("result_url"),
    error: text("error"),
    jobId: varchar("job_id", { length: 12 }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("workspace_tasks_project_status_idx").on(t.projectId, t.status),
    // §2.9's one-publish-per-project gate, enforced where it must be: two concurrent triggers
    // (double-submit, UI + MCP) can both pass the find-running read, and only the database can
    // make the insert atomic. Terminal rows are unconstrained.
    uniqueIndex("workspace_tasks_running_subject_uq")
      .on(t.projectId, t.subjectKey)
      .where(sql`${t.status} = 'running'`),
  ],
);

/** Workspace default model inherited by the authoring assistant and agents with no local model. */
export const workspaceSettings = pgTable("workspace_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Connection-qualified workspace default model id. */
  assistantModel: text("assistant_model"),
  /** Explicit provider-agnostic reasoning effort; null delegates to the provider default. */
  assistantEffort: text("assistant_effort"),
  updatedAt: updatedAt(),
});

/**
 * Per-agent (and per-declared-subagent) model overrides — the workspace's explicit exceptions to
 * the default model.
 *
 * An agent whose `agent.ts` resolves through the generated `harnesst/model.ts`
 * (`model: harnesstAgentModel('<agent-name>')`) asks harnesst at runtime which model to run. The
 * answer is the row for its target when one exists, else the nearest ancestor's row, else the
 * workspace default (`workspace_settings.assistant_model`). Removing a row falls that target back
 * to what it inherits — no repo change, no redeploy, the running agent picks it up on its next
 * step.
 *
 * A target is `(project_id, agent_name, subagent_path)`: `subagent_path = ''` is the top-level
 * agent, `researcher/fact-checker` is a declared subagent nested under it (issue #344). Legacy
 * deployments pass only the agent name, so they land on `''` and inherit exactly as before.
 *
 * `project_id` is PART OF THE KEY, not a nullable annotation: two repos in one workspace routinely
 * hold same-named members and subagents, and with the repo outside the key one repo's save
 * overwrote the other's row. `''` is the legacy/unattributed row (written before the column
 * existed, or by a name-only call site) and answers for any repo that has no row of its own; every
 * write from a repo surface keys that repo. There is deliberately NO foreign key — `''` is not a
 * project id — so deleting a project prunes its rows explicitly (see `removeProjectModelOverrides`)
 * rather than by cascade. The org FK still cascades.
 */
export const agentModelOverrides = pgTable(
  "agent_model_overrides",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The eve agent name (`harnesstAgentModel('<name>')` argument), not a harnesst row id. */
    agentName: text("agent_name").notNull(),
    /**
     * `/`-joined declared-subagent segments relative to the member's agent root — `''` for the
     * agent itself, `researcher` / `researcher/fact-checker` for a nested subagent.
     */
    subagentPath: text("subagent_path").notNull().default(""),
    /** The repo this target lives in; `''` for legacy rows resolved by name alone. */
    projectId: varchar("project_id", { length: 12 }).notNull().default(""),
    /** Connection-qualified model ref, e.g. `anthropic/<connectionId>/<model>`. */
    model: text("model").notNull(),
    /** Explicit provider-agnostic reasoning effort; null delegates to the provider default. */
    effort: text("effort"),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Named explicitly: the derived name for four columns exceeds Postgres' 63-byte identifier
    // limit and would be silently truncated.
    primaryKey({
      name: "agent_model_overrides_pk",
      columns: [t.orgId, t.projectId, t.agentName, t.subagentPath],
    }),
    // The legacy, name-only lookup (a deployment that sends no project) reads across repos.
    index("agent_model_overrides_agent_idx").on(t.orgId, t.agentName),
  ],
);

/**
 * Connectable model providers (issue #28). API-key providers (OpenRouter, Anthropic, and OpenAI
 * Platform) keep a sealed key; Codex keeps its device-code OAuth token pair. A workspace may hold
 * several connections, including multiple accounts for one provider, each with a human label.
 * Model references identify the exact connection as `<provider>/<connectionId>/<upstream-id>`.
 *
 * Credentials are write-only, AES-256-GCM sealed with the same secretbox as `secret_values`.
 * Loader-facing code returns display metadata only; catalog, deploy, gateway, and refresh paths
 * are the only consumers that unseal credentials. `accountId` is a Codex request header rather
 * than a secret, so it remains plain.
 */
export const modelProviderConnections = pgTable(
  "model_provider_connections",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `openrouter` | `anthropic` | `openai` | `codex`. */
    provider: varchar("provider", { length: 32 }).notNull(),
    /** Human-readable label shown in the connections list + model picker suffixes. */
    label: text("label").notNull(),
    /** Connected account email (from the id_token), for display. Best-effort, nullable. */
    accountEmail: text("account_email"),
    /** ChatGPT account id — sent as the `ChatGPT-Account-ID` request header (not a secret). */
    accountId: text("account_id"),
    /** Sealed API key for key-authenticated providers. */
    apiKeyCiphertext: text("api_key_ciphertext"),
    apiKeyIv: text("api_key_iv"),
    apiKeyAuthTag: text("api_key_auth_tag"),
    /** Sealed OAuth access token (AES-256-GCM, same secretbox as secret_values). */
    accessTokenCiphertext: text("access_token_ciphertext"),
    accessTokenIv: text("access_token_iv"),
    accessTokenAuthTag: text("access_token_auth_tag"),
    /** Sealed OAuth refresh token. */
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenAuthTag: text("refresh_token_auth_tag"),
    /** When the sealed access token expires (drives the central refresh). */
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    /** "active" | "expired" | "revoked" — display + gateway-guard state, not a secret. */
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("model_provider_connections_org_idx").on(t.orgId)],
);

/**
 * Channel-homed resume descriptor — the ONE place that answers "how do we deliver an answer
 * back into this session?" for a session eve homed on a channel (GitHub today, Discord/Slack
 * later) rather than on its plain HTTP session route.
 *
 * Why it exists: eve namespaces a channel session's continuation token (`github:repo:…`) and
 * resolves it only through the channel that owns it. Proven at runtime — POSTing a
 * GitHub-homed session's own stored token to eve's built-in `POST /eve/v1/session/:id` with
 * `inputResponses` returns 500 "Cannot deliver inputResponses — the target session was not
 * found via continuation token". So the answer must be delivered to a route registered ON the
 * channel, which holds that channel's own `send`.
 *
 * `rawToken` is the token with the `"<channel>:"` namespace STRIPPED: eve's `send()` re-prefixes
 * the channel name, so handing back the namespaced form yields `github:github:…` and fails.
 * `state` is the channel's own durable state (eve `GitHubChannelState` for github) — compile-time
 * mandatory on `SendOptions` for a stateful channel, so it must survive the park.
 */
export type SessionResumeVia = {
  /** Channel name as eve namespaces it, e.g. "github". */
  channel: string;
  /** Absolute path of the channel-registered answer route on the instance. */
  routePath: string;
  /** Continuation token with the `"<channel>:"` prefix stripped. */
  rawToken: string;
  /** The channel's durable state, round-tripped verbatim. */
  state: Record<string, unknown>;
};

/**
 * harnesst's index of Eve playground sessions. The transcript itself lives in Eve's durable
 * event stream; this table stores the app-owned thread/cursor needed to list and resume
 * sessions for a project/agent/user.
 */
export const playgroundSessions = pgTable(
  "playground_sessions",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    environmentId: varchar("environment_id", { length: 12 }).references(
      () => environments.id,
      {
        onDelete: "cascade",
      },
    ),
    /** Same value passed to DeployRequest.worldKey; currently the environment id. */
    worldKey: text("world_key"),
    /**
     * Null for agent-opened sessions (a delegation parked on a human question — see
     * `openedByAgentId`); every human-opened session records its creator.
     */
    createdBy: text("created_by").references(() => user.id, {
      onDelete: "cascade",
    }),
    /**
     * Which chat surface owns this conversation: 'playground' | 'assistant' | 'foh'. The three
     * surfaces are fully disjoint — every query matches its own surface exactly (see
     * `surfaceScope`). Rows predating this column were stamped 'playground' by the 0015
     * default; migration 0018 backfilled legacy assistant conversations (rows on
     * kind-'assistant' agents) to 'assistant' so the exact match holds.
     */
    surface: text("surface").notNull().default("playground"),
    /**
     * Set while the session is parked on an eve `input.requested` waiting for a human
     * (needs-you). Written/cleared only at the drain/reconcile/relay chokepoints and the send
     * path — `status = 'waiting'` alone does NOT mean parked.
     */
    pendingInputAt: timestamp("pending_input_at", { withTimezone: true }),
    /** For agent-opened FOH sessions: the peer agent whose parked question opened this session. */
    openedByAgentId: varchar("opened_by_agent_id", { length: 12 }).references(
      () => agents.id,
      { onDelete: "set null" },
    ),
    /** For agent-opened FOH sessions: the delegation that parked on a human question. */
    delegationId: varchar("delegation_id", { length: 12 }).references(
      () => delegations.id,
      { onDelete: "set null" },
    ),
    /** Eve runtime-owned stream/inspect handle. */
    externalSessionId: text("external_session_id"),
    /**
     * The eve session this conversation SUCCEEDED (#288 3b): set exactly once, when a
     * channel-homed row is rebound to its fresh HTTP-homed successor, to the predecessor's
     * `external_session_id`. Read-only stitch for rendering — the replay concatenates the
     * predecessor's events ahead of the successor's. A conversation spans at most two eve
     * sessions, so the first succession wins and the pointer never moves again.
     */
    predecessorExternalSessionId: text("predecessor_external_session_id"),
    /** Eve channel-owned resume handle. */
    continuationToken: text("continuation_token"),
    /**
     * Channel-homed resume descriptor (see `SessionResumeVia`). Null for ordinary rows whose
     * eve session lives on the HTTP session route. When set, the answer path delivers through
     * the agent's channel route instead of `/eve/v1/session/:id`.
     */
    resumeVia: jsonb("resume_via").$type<SessionResumeVia>(),
    /**
     * Fencing token for the active turn (issue #221 finding 5): set by the atomic
     * new/waiting/stopped→running claim in `claimPlaygroundSessionForTurn`; the drain's
     * progress/cursor writes carry it so a superseded drain's late writes hit zero rows.
     */
    turnClaimId: text("turn_claim_id"),
    /** Number of Eve stream events consumed from the durable event stream. */
    streamIndex: integer("stream_index").notNull().default(0),
    /**
     * Agent-initiated conversations (#288 3c): the `notify-user` notification that opened this
     * row. Such a row has NO eve session until a human replies — the transcript renders this
     * message as the agent's opening entry, and the first reply seeds the fresh HTTP-homed
     * session with it as strippable context. Null for every other row.
     */
    openingMessage: text("opening_message"),
    title: text("title"),
    /**
     * A human-edited title is authoritative. Turn drains and channel/delegation adoption can
     * finish after the rename, so every inferred-title writer checks this bit before updating.
     */
    titleManuallySet: boolean("title_manually_set").notNull().default(false),
    /** new | running | waiting | completed | failed */
    status: text("status").notNull().default("new"),
    /** Version label of the release that last served this conversation (turn-meta display). */
    lastVersion: text("last_version"),
    /**
     * Per-conversation connection-qualified model override applied to subsequent turns via the
     * playground model directive; null = the deployed default model.
     */
    modelId: text("model_id"),
    /** Explicit reasoning effort paired with modelId; null delegates to the provider default. */
    effort: text("effort"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    /**
     * Front-of-house tidy-up: set when someone archives the conversation, cleared when it is
     * restored or when an agent parks a fresh question onto it. Archiving is REVERSIBLE and
     * hides the row from every FOH read; only a back-of-house admin can delete it for real.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * Who archived it, for the back-of-house listing. `set null` (not cascade): removing a
     * person from the org must never take the conversations they tidied with them.
     */
    archivedBy: text("archived_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("playground_sessions_scope_updated_idx").on(
      t.projectId,
      t.agentId,
      t.createdBy,
      t.updatedAt,
    ),
    // Project-scoped ON PURPOSE, and it is what makes a cross-agent park REFUSABLE (WS1):
    // `adoptChannelHomedSession` upserts on this index from a deployed container, so a park
    // naming another agent's live `external_session_id` lands on the owner's row, fails the
    // `agent_id` predicate in `setWhere`, writes nothing, and is answered "that eve session
    // belongs to a different agent". Adding `agent_id` to the key would make that conflict
    // disappear — the intruder would quietly INSERT a second row against the same eve session,
    // whose resume descriptor points at a container where the token resolves to nothing.
    uniqueIndex("playground_sessions_external_uq").on(
      t.projectId,
      t.externalSessionId,
    ),
    index("playground_sessions_surface_idx").on(
      t.projectId,
      t.surface,
      t.updatedAt,
    ),
    // Serves the back-of-house archived listing (one repo, newest archived first). The FOH
    // reads keep using the scope index above — `archived_at IS NULL` there is a cheap filter
    // on rows the scope key already narrowed.
    index("playground_sessions_archived_idx").on(t.projectId, t.archivedAt),
  ],
);

/**
 * Assistant coding-agent checkouts. One row per
 * assistant conversation (a `playground_sessions` row on the assistant channel) that has grown a
 * repo checkout. The assistant edits a per-conversation git checkout on the shared home volume;
 * after each turn the control plane mirrors that checkout onto the branch `harnesst/conv-<id>` — an
 * internal durability mechanism only (volume/instance loss is recovered by re-cloning the remote
 * branch). This table is the only durable link from a conversation to its branch.
 * `lastSyncedHash` lets the sync engine skip a no-op turn (tree unchanged).
 */
export const assistantCheckouts = pgTable(
  "assistant_checkouts",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    /** The conversation == the assistant `playground_sessions` row (1:1). */
    conversationId: varchar("conversation_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Working branch the conversation's checkout is mirrored onto (`harnesst/conv-<id>`). */
    branch: text("branch").notNull(),
    /** Base branch the working branch is cut from (the project default at first sync). */
    baseBranch: text("base_branch").notNull(),
    /** Content hash of the last mirrored tree state — a matching hash means "skip, no change". */
    lastSyncedHash: text("last_synced_hash"),
    /**
     * Human-readable notes from the last sync (paths stripped by the path policy, binary/oversize
     * skips, symlinks refused). Injected into the model's next turn and surfaced on the assistant
     * page, so a silently-excluded edit is never mistaken for a landed one.
     */
    warnings: jsonb("warnings").$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assistant_checkouts_conversation_uq").on(t.conversationId),
  ],
);

/**
 * Short-lived authorizations for model-backed evals launched by the built-in assistant.
 *
 * The eval process receives only a signed reference to one row. The row pins the project,
 * member, and exact model and carries hard expiry/concurrency/request/token ceilings. A unique
 * project id allows at most one assistant eval process per project; the runner deletes the row
 * when the process exits, while the expiry makes an abandoned row/token harmless.
 */
export const assistantEvalGrants = pgTable(
  "assistant_eval_grants",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: varchar("conversation_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    memberName: text("member_name").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    modelSource: text("model_source").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxConcurrentCalls: integer("max_concurrent_calls").notNull(),
    activeCalls: integer("active_calls").notNull().default(0),
    maxCalls: integer("max_calls").notNull(),
    usedCalls: integer("used_calls").notNull().default(0),
    maxTokens: integer("max_tokens").notNull(),
    reservedTokens: integer("reserved_tokens").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("assistant_eval_grants_project_uq").on(t.projectId),
    index("assistant_eval_grants_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * Directed teammate-collaboration overrides (Team delegation, PRD §7.9 runtime half — D4).
 * A row exists ONLY for a (from → to) pair the human has touched; an ABSENT row means the ask
 * is allowed (default-allow). This avoids seeding on roster sync, avoids a backfill migration,
 * and never resurrects a deleted override when a member self-heals — new members collaborate
 * immediately. `enabled=false` is the one thing this table records: a pair the human turned off.
 * The relay checks it live on every ask, so a toggle takes effect with no redeploy.
 */
export const agentLinks = pgTable(
  "agent_links",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromAgentId: varchar("from_agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: varchar("to_agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("agent_links_pair_uq").on(t.fromAgentId, t.toAgentId)],
);

/**
 * One row per teammate ask — the cross-agent correlation record (Team delegation — D6). The
 * relay writes it `running` before it forwards the message and finalizes it (completed|failed)
 * once the peer's turn settles, recording the peer eve session, the peer's harnesst run row, and
 * timing. Concurrency caps count `running` rows younger than (timeout + slack), so a crashed
 * relay can never wedge the caps. Agent FKs `set null` on member removal — the correlation
 * record survives the roster change that outlived it.
 */
export const delegations = pgTable(
  "delegations",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromAgentId: varchar("from_agent_id", { length: 12 }).references(
      () => agents.id,
      {
        onDelete: "set null",
      },
    ),
    fromEnvironmentId: varchar("from_environment_id", { length: 12 }),
    toAgentId: varchar("to_agent_id", { length: 12 }).references(
      () => agents.id,
      {
        onDelete: "set null",
      },
    ),
    toEnvironmentId: varchar("to_environment_id", { length: 12 }),
    /** The peer eve session the relay opened for this ask. */
    externalSessionId: text("external_session_id"),
    /** The peer's harnesst run row (runs.id), for linked traces. */
    runId: varchar("run_id", { length: 12 }),
    // running | completed | failed
    status: text("status").notNull().default("running"),
    error: text("error"),
    startedAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("delegations_project_started_idx").on(t.projectId, t.startedAt),
  ],
);

/**
 * Per-viewer read cursor for FOH conversations (D3). Unread is a timestamp comparison —
 * `playground_sessions.last_event_at > last_read_at` — never a `stream_index` comparison:
 * the cursor counts eve-stream consumption and resets when a session's handles are cleared,
 * while `last_event_at` is bumped by every drain flush.
 */
export const conversationReads = pgTable(
  "conversation_reads",
  {
    sessionId: varchar("session_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
);

/**
 * Front of House inbox — one row per moment a session needs (or finished for) a human:
 * a parked question/approval (eve `input.requested`) or a completed turn. Written only at the
 * needs-you chokepoints (drain, reconcile, relay); resolved on continuation send, terminal
 * failure, or supersession by a newer turn. Viewing acknowledges the notification separately so
 * a parked ask can leave every badge while remaining pending for answer lifecycle.
 * `user_id` NULL (agent-opened sessions) means visible to every user with access to the project
 * (D5), so the first one to open it acknowledges the shared notification.
 */
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    /** Soft ref (no FK): best-effort link to the delegation that parked. */
    delegationId: varchar("delegation_id", { length: 12 }),
    /** Soft ref (no FK): best-effort link to the peer's harnesst run. */
    runId: varchar("run_id", { length: 12 }),
    /** The agent asking (or finishing) — for "ivy needs an answer" copy. */
    agentId: varchar("agent_id", { length: 12 }).references(() => agents.id, {
      onDelete: "set null",
    }),
    /** Recipient; NULL = anyone with access to the project (agent-opened sessions, D5). */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    // question | approval | finished | notice
    kind: text("kind").notNull(),
    /** The question text / finish summary shown in the inbox flyout. */
    prompt: text("prompt"),
    /** Eve input request id — dedupes re-drained/reconciled requests. */
    requestId: text("request_id"),
    // pending | resolved
    status: text("status").notNull().default("pending"),
    /** Viewed but not necessarily handled: hides a parked ask without pretending it was answered. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("inbox_items_project_status_idx").on(t.projectId, t.status),
    index("inbox_items_user_status_idx").on(t.userId, t.status),
    // Request identity (issue #221 finding 4): concurrent drain/reconcile writers must not
    // file duplicate pending question/approval items for the same eve request. Partial so
    // resolved history keeps every occurrence and `finished` items (request_id NULL) are
    // unconstrained; the insert path pairs it with ON CONFLICT DO NOTHING.
    uniqueIndex("inbox_items_session_request_pending_uq")
      .on(t.sessionId, t.requestId)
      .where(sql`${t.status} = 'pending' and ${t.requestId} is not null`),
  ],
);

/**
 * Published artifacts (issue #290) — one row per NAMED artifact an agent published out of its home
 * volume into the control plane's own store. The bytes are COPIED at publish time (`storage_path`,
 * on the control plane's artifact disk) rather than proxied from the instance: a deployment's URL
 * is reallocated on every wake and its container is disposable, so an artifact whose lifetime was
 * tied to either would break the moment the agent scaled to zero.
 *
 * A row is a transcript element, not a file record: it is keyed to the FOH session it was
 * published into plus the `stream_index` position the cache had reached, so the card renders in
 * the turn it belongs to (see `mergeArtifactEntries`) and survives every reload.
 *
 * THE UNIT IS "A NAMED ARTIFACT IN A CONVERSATION", NOT A FILE (issue #292). Republishing the same
 * name appends a row to `artifact_versions` and leaves this row's id — and therefore the card — in
 * place, which is what makes the refine loop ("make it bolder", republish) update the card the user
 * is already looking at instead of stacking a second one. The content columns below (`entry_path`,
 * `content_type`, `byte_size`, `sha256`, `storage_path`) are the LATEST version's, denormalized so
 * the transcript read stays one indexed select; the versions table is the record.
 *
 * `content_type` is the type SNIFFED from the bytes against the image allowlist, never the
 * agent's claim — it is what the serving route puts on the wire.
 */
export const artifacts = pgTable(
  "artifacts",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The agent that published — the card's attribution. */
    agentId: varchar("agent_id", { length: 12 })
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 12 })
      .notNull()
      .references(() => playgroundSessions.id, { onDelete: "cascade" }),
    /** Soft ref (no FK): which deployment published it. Provenance only — deployments come and go. */
    deploymentId: varchar("deployment_id", { length: 12 }),
    /** File name as the agent published it (basename only — never a path). */
    name: text("name").notNull(),
    /** Optional agent-supplied caption for the card. */
    title: text("title"),
    /**
     * `image` (#290), `document`, or `html` (#291). Images and documents are sniffed files served
     * by the cookie-authenticated artifact route; `html` is a page BUNDLE whose files live in
     * `artifact_files` and are only ever served through the sandboxed preview route. Defaulted so
     * every row that predates bundles reads correctly without a backfill.
     */
    kind: text("kind").notNull().default("image"),
    /** Bundle only: the member the preview opens at, relative to the bundle root (`index.html`). */
    entryPath: text("entry_path"),
    contentType: text("content_type").notNull(),
    /**
     * Bytes this artifact cost: the file's own size for an image, and the SUM of the bundle's
     * members for a page — the budget in `artifactUsage` reads this column, so anything else would
     * let a bundle spend the daily disk ceiling one member at a time.
     */
    byteSize: integer("byte_size").notNull(),
    /**
     * The LATEST version's content identity. For a single file it is the sha256 of the bytes; for a
     * bundle it is a sha256 over the members' `(rel_path, sha256)` manifest, so republishing a page
     * whose stylesheet changed is a new VERSION even though `index.html` did not move — the entry
     * file's own sha would have read as "nothing changed" and left the stale bytes on the card.
     */
    sha256: text("sha256").notNull(),
    /**
     * Where the latest version's bytes live, relative to the control plane's artifact directory.
     * For a bundle this is the ENTRY member's stored path; every member (the entry included) also
     * has its own `artifact_files` row, which is what the preview route reads.
     */
    storagePath: text("storage_path").notNull(),
    /**
     * Cache-space transcript position (see `playground_events.stream_index`) the card sorts after.
     * FROZEN at first publish (#292): a republish that moved it would slide the card down past the
     * turns that happened in between, which is the opposite of updating in place. Each version
     * keeps its own publish position on its own row.
     */
    streamIndex: integer("stream_index").notNull(),
    /**
     * The latest `artifact_versions` row — a soft ref (no FK; the two tables reference each other
     * and one direction has to be plain). It is what the single-file URL in transcript data points at, so
     * that URL stays immutably cacheable while the artifact itself keeps changing.
     */
    latestVersionId: varchar("latest_version_id", { length: 12 }),
    /** The latest version's ordinal — the card's "v3". Rises forever; retention never rewinds it. */
    versionNumber: integer("version_number").notNull().default(1),
    /**
     * How many versions are still STORED (≤ the retention cap). Denormalized for a future listing
     * read; the preview panel's picker does NOT come from here — it is minted with the token, from
     * the versions themselves, because the card's copy is a poll behind.
     */
    versionCount: integer("version_count").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    index("artifacts_session_idx").on(t.sessionId, t.streamIndex),
    // Identity (#292). Republishing a name resolves to THIS row and appends a version, so the
    // conversation gets one card per name however many times the agent refines it. It replaced a
    // unique index on `(session_id, sha256)`: content identity belongs to the version now, and
    // keeping it here would have collided two versions that reverted to earlier bytes.
    uniqueIndex("artifacts_session_name_uq").on(t.sessionId, t.name),
  ],
);

/**
 * One published version of an artifact (issue #292). Everything that is a property of the BYTES
 * lives here; the parent row holds what is a property of the artifact's identity (conversation,
 * name, kind, transcript position).
 *
 * `(artifact_id, version_number)` is unique and dense from 1, which is what makes an append safe
 * without a transaction: two racing publishes contend on the index, the loser re-reads and either
 * dedupes onto the winner (identical bytes — the retried tool POST) or takes the next number.
 *
 * `project_id` and `created_at` are denormalized off the parent so the daily per-repo byte budget
 * stays one indexed scan. It has to read VERSIONS: with the budget on the parent, an agent
 * republishing a 20 MB page five hundred times would have been charged 20 MB once.
 */
export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    artifactId: varchar("artifact_id", { length: 12 })
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** Denormalized from the parent — the budget aggregate's index key. */
    projectId: varchar("project_id", { length: 12 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** 1-based, dense, and never reused: a pruned ordinal stays gone. */
    versionNumber: integer("version_number").notNull(),
    /** Bundle only: the member the preview opens at, relative to the bundle root. */
    entryPath: text("entry_path"),
    contentType: text("content_type").notNull(),
    /** This version's cost: the file for an image, the SUM of the members for a page. */
    byteSize: integer("byte_size").notNull(),
    /** Content identity — see the parent's column. Equal to the previous version's = no append. */
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    /** Where the conversation had reached when THIS version was published (the picker's ordering). */
    streamIndex: integer("stream_index").notNull(),
    /** Soft ref (no FK): which deployment published this version. Provenance only. */
    deploymentId: varchar("deployment_id", { length: 12 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("artifact_versions_number_uq").on(
      t.artifactId,
      t.versionNumber,
    ),
    index("artifact_versions_project_idx").on(t.projectId, t.createdAt),
  ],
);

/**
 * The files of one page-bundle VERSION (issues #291, #292). A child table rather than more
 * `artifacts` rows for two reasons: a bundle is ONE card in the transcript and one budget charge,
 * and the artifact-level content index would collide the moment two members held identical bytes
 * (two empty files, the same logo twice) — a normal thing in a static page and not an error.
 *
 * Members hang off the VERSION, not the artifact: keyed to the artifact, v2's `index.html` would
 * hit `artifact_files_path_uq`, be swallowed by the insert's ON CONFLICT DO NOTHING, and the
 * preview would go on serving v1's bytes forever with nothing to show for it.
 *
 * Bytes stay in the same flat content-addressed store as an image's: nothing about `rel_path`
 * reaches the filesystem, so an agent-supplied path can never shape one. The path is a lookup key
 * the preview route matches a request against, and only a normalized one is ever written
 * (`normalizeBundleRelPath`).
 */
export const artifactFiles = pgTable(
  "artifact_files",
  {
    id: varchar("id", { length: 12 }).primaryKey().$defaultFn(newId),
    artifactId: varchar("artifact_id", { length: 12 })
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    /** The version these bytes belong to — what the preview route looks a request up by. */
    versionId: varchar("version_id", { length: 12 })
      .notNull()
      .references(() => artifactVersions.id, { onDelete: "cascade" }),
    /** Bundle-relative path (`index.html`, `assets/app.css`) — normalized, never raw. */
    relPath: text("rel_path").notNull(),
    /** The type the member's extension declares, from the bundle allowlist. */
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // The preview route's only lookup, and the idempotency key a retried publish lands on.
    uniqueIndex("artifact_files_path_uq").on(t.versionId, t.relPath),
  ],
);
