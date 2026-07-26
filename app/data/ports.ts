/**
 * Data-access ports — the repository seam (PRD §8 style: depend on an interface, not on
 * Postgres). Control-plane logic (deploy controller, queue) talks to a `DataStore`, so it can
 * be unit-tested against an in-memory fake with no database, and the Drizzle implementation
 * (drizzle.server.ts) is the one place SQL lives. Interfaces are defined by consumer need, not
 * by mirroring the schema.
 *
 * Row types are the schema's inferred selects, so the fake and the real impl can't drift.
 */
import type {
  agentLinks,
  agents,
  conversationReads,
  delegations,
  deployments,
  draftChanges,
  environments,
  inboxItems,
  jobs,
  projects,
  releases,
  runs,
  workspaceTasks,
} from "~/db/schema";

export type Agent = typeof agents.$inferSelect;
export type DraftChange = typeof draftChanges.$inferSelect;
export type Release = typeof releases.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AgentLink = typeof agentLinks.$inferSelect;
export type Delegation = typeof delegations.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type WorkspaceTask = typeof workspaceTasks.$inferSelect;
export type InboxItem = typeof inboxItems.$inferSelect;
export type ConversationRead = typeof conversationReads.$inferSelect;

/** A deployment row joined to its release's version/commit (the list/split view). */
export interface DeploymentWithRelease {
  id: string;
  status: string;
  trafficWeight: number;
  url: string | null;
  errorDetail: string | null;
  createdAt: Date;
  releaseId: string;
  version: string;
  gitSha: string;
}

export interface AgentRepo {
  findById(id: string): Promise<Agent | null>;
  /**
   * A project's FULL agent set (every `kind`), by name. Callers that want only the roster of
   * user-facing members must filter `kind === 'member'` (or use `listAgents`), but drafts /
   * `agentForPath` need the internal assistant row too, so this never filters.
   */
  listByProject(projectId: string): Promise<Agent[]>;
  /**
   * Reconcile the roster with the repo's detected layout: upsert by (project, name) —
   * updating `root` when a member moved — and delete members no longer present. Only rows with
   * `kind === 'member'` are pruned; internal rows (the assistant) are never in the detected
   * roster and survive every sync.
   */
  syncRoster(
    projectId: string,
    roster: { name: string; root: string }[],
    options?: { allowEmpty?: boolean },
  ): Promise<Agent[]>;
  /**
   * Rename a member IN PLACE — updates `name` (and `root`, which moves with the directory) while
   * preserving the row id, so every FK to it (environments, releases, secrets, drafts) survives.
   * The one safe primitive for a rename: a prune/recreate would cascade the member's history away.
   */
  rename(id: string, patch: { name: string; root: string }): Promise<Agent>;
  /** Set (or clear, with null) the pending-rename target for a member. */
  setPendingName(id: string, pendingName: string | null): Promise<void>;
  /** The project's built-in assistant row (`kind === 'assistant'`), or null. */
  findAssistant(projectId: string): Promise<Agent | null>;
  /** Create the built-in assistant row. Caller ensures single-instance via `findAssistant`. */
  createAssistant(input: {
    projectId: string;
    name: string;
    root: string;
  }): Promise<Agent>;
}

export interface ReleaseRepo {
  /** Existing releases for one agent (version numbering is per agent). */
  countByAgent(agentId: string): Promise<number>;
  /** A project's releases, newest first (version history). */
  listByProject(projectId: string): Promise<Release[]>;
  /** Insert a release; throws an (agent, version) unique-violation like Postgres would. */
  insert(input: {
    projectId: string;
    agentId: string;
    version: string;
    gitSha: string;
    changelog?: string | null;
    createdBy?: string | null;
  }): Promise<Release>;
  findById(id: string): Promise<Release | null>;
  findByCommit(agentId: string, gitSha: string): Promise<Release | null>;
  setImageRef(id: string, imageRef: string): Promise<void>;
}

export interface DeploymentRepo {
  findById(id: string): Promise<Deployment | null>;
  /**
   * Insert a deployment; a second in-flight (pending/building) row for the same environment
   * throws the `deployments_env_inflight_uq` unique-violation like Postgres would.
   */
  insert(input: {
    environmentId: string;
    releaseId: string;
    status: string;
    trafficWeight: number;
    createdBy?: string | null;
  }): Promise<Deployment>;
  update(
    id: string,
    patch: Partial<Pick<Deployment, "status" | "url" | "errorDetail" | "trafficWeight">>,
  ): Promise<Deployment>;
  listByEnvironment(environmentId: string): Promise<DeploymentWithRelease[]>;
  /** Set every currently-live deployment in the env to draining at weight 0 (rollback). */
  drainLive(environmentId: string): Promise<void>;
  /** Delete an environment's failed deployment rows (post-mortem clutter). */
  deleteFailed(environmentId: string): Promise<void>;
  /** Apply weights atomically, scoped to the environment (clamped ≥ 0 by the caller). */
  setWeights(
    environmentId: string,
    weights: { deploymentId: string; weight: number }[],
  ): Promise<void>;
}

export interface EnvironmentRepo {
  findById(id: string): Promise<Environment | null>;
  /** All environments across a project's roster (legacy views; per-agent is the norm). */
  listByProject(projectId: string): Promise<Environment[]>;
  /**
   * Every environment in the control plane, unscoped. Internal maintenance only (the sandbox
   * reaper maps a leaked home-volume name back to its owning environment/project); never a
   * tenant-facing read.
   */
  listAll(): Promise<Environment[]>;
  listByAgent(agentId: string): Promise<Environment[]>;
  /**
   * Guarantee the ≥1-environment invariant: insert an env named "default" ONLY when the
   * member has none. Idempotent on re-sync — agents with environments (whatever their
   * names) are never touched, so user CRUD survives roster self-heals and webhooks.
   */
  ensureDefault(projectId: string, agentId: string): Promise<void>;
  /** Create a named environment; throws the (agent, name) unique violation on duplicates. */
  create(input: { projectId: string; agentId: string; name: string }): Promise<Environment>;
  /** Rename; throws the (agent, name) unique violation on duplicates. */
  rename(id: string, name: string): Promise<void>;
  /**
   * Delete, refusing to remove the member's LAST environment (the check and the delete are
   * one statement, so concurrent deletes can't drop an agent to zero). True = deleted.
   */
  deleteById(id: string): Promise<boolean>;
}

export interface ProjectRepo {
  findById(id: string): Promise<Project | null>;
  findByRepo(owner: string, repo: string): Promise<Project | null>;
  /** Tenant-scoped read: returns the project only if it belongs to `orgId` (D2). */
  getByOrg(orgId: string, id: string): Promise<Project | null>;
  /** A tenant's projects, newest first. */
  listByOrg(orgId: string): Promise<Project[]>;
  /** Does this org already have a project with this slug? (uniqueness within a tenant). */
  slugExists(orgId: string, slug: string): Promise<boolean>;
  create(input: {
    orgId: string;
    name: string;
    slug: string;
    layout?: "single" | "team";
    repoOwner?: string | null;
    repoName?: string | null;
    repoInstallationId?: string | null;
    defaultBranch?: string;
  }): Promise<Project>;
  /**
   * Persist the environment Publish deploys into (§2.8: resolved once — from the only env name,
   * or the user's one-time answer — and never asked again).
   */
  setLiveEnvironmentName(id: string, name: string): Promise<void>;
  /** Delete the project row — the FK cascade takes every dependent row with it (M5.8). */
  deleteById(id: string): Promise<void>;
}

export interface JobRepo {
  insert(input: {
    kind: string;
    payload: Record<string, unknown>;
    runAt?: Date;
    maxAttempts?: number;
  }): Promise<string>;
  /** Atomically claim the oldest due queued job (increment attempts → running). */
  claimNext(now: Date): Promise<Job | null>;
  update(
    id: string,
    patch: Partial<Pick<Job, "status" | "error" | "runAt">>,
  ): Promise<void>;
  /** Requeue jobs stranded in `running` (a process restart killed their worker mid-job). */
  requeueRunning(): Promise<number>;
  /**
   * Fail every `running` job of one kind, returning the failed rows. Boot reconciliation uses
   * this for `publish` jobs, which must NEVER be requeued after a restart — a rerun against a
   * task with recorded progress could land a duplicate commit or misreport a landed publish.
   */
  failRunningByKind(kind: string, error: string): Promise<Job[]>;
  statsByStatus(): Promise<Record<string, number>>;
}

export type PipelineStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/**
 * One step of the publish pipeline (check → build → commit → version → deploy), stored on the
 * workspace task's `steps` jsonb. The single source of truth for publish progress: the compact
 * header control derives its one-liner from the running step's label + detail, the publish panel
 * renders the full stepper.
 */
export interface PipelineStep {
  key: "check" | "build" | "commit" | "version" | "deploy";
  label: string; // "Building your agents"
  status: PipelineStepStatus;
  detail?: string; // "Ivy (2 of 3)"
  reason?: string; // why skipped
  error?: string; // full failure output, preserving newlines
  substeps?: {
    label: string;
    status: PipelineStepStatus;
    error?: string;
    /**
     * Deploy substeps: the queued deployment row. The pipeline succeeds the substep when the
     * deploy is QUEUED; the publish state route re-reads this row and presents the substep as
     * running/failed until the agent is actually live (§3.2 honesty).
     */
    deploymentId?: string;
  }[];
}

/**
 * The user-facing task projection the workspace indicator reads (issue #142). Separate from
 * JobRepo: `jobs` is the ops queue (retry/claim), this is the small per-project record a running
 * publish records its steps into and resolves to a terminal state.
 */
export interface WorkspaceTaskRepo {
  insert(input: {
    projectId: string;
    kind: string;
    subjectKey: string;
    label: string;
    originUrl: string;
    steps?: PipelineStep[] | null;
    jobId?: string | null;
    createdBy?: string | null;
  }): Promise<WorkspaceTask>;
  update(
    id: string,
    patch: Partial<
      Pick<WorkspaceTask, "steps" | "status" | "resultUrl" | "error" | "jobId" | "dismissedAt">
    >,
  ): Promise<void>;
  findById(id: string): Promise<WorkspaceTask | null>;
  /**
   * The indicator's read set for a project: every `running` task (never dismissed), plus terminal
   * (succeeded|failed) tasks that are not dismissed and whose `updatedAt >= terminalSince` (recent
   * outcomes linger until dismissed or they age out). Oldest-first by createdAt so the stack is
   * stable as rows resolve.
   */
  listActive(projectId: string, terminalSince: Date): Promise<WorkspaceTask[]>;
  /** The running task for a trigger surface, for dedupe (one publish per project at a time). */
  findRunningBySubject(projectId: string, subjectKey: string): Promise<WorkspaceTask | null>;
  /**
   * Every `running` task of one kind, across all projects. Boot reconciliation reads this to
   * fail publishes stranded by a restart (their in-process pipeline died with the process); a
   * stranded running task would otherwise disable Publish for its project forever.
   */
  listRunningByKind(kind: string): Promise<WorkspaceTask[]>;
}

export interface DraftRepo {
  /** Stage (upsert) a draft: latest content per (project, path) wins. */
  upsert(input: {
    projectId: string;
    /** Owning roster member; null for project-shared files (root package.json). */
    agentId: string | null;
    path: string;
    /** Full file contents; null stages a DELETION of the path. */
    content: string | null;
    baseSha?: string | null;
    createdBy?: string | null;
  }): Promise<DraftChange>;
  get(projectId: string, path: string): Promise<DraftChange | null>;
  /** A project's saved drafts, oldest first (stable order in the publish panel). */
  listByProject(projectId: string): Promise<DraftChange[]>;
  /** Remove drafts by path (an explicit discard). */
  deleteByPaths(projectId: string, paths: string[]): Promise<void>;
  /**
   * Remove drafts a publish landed — but never a row saved AFTER the pipeline captured it
   * (row `updatedAt` newer than the captured one): a save that raced the multi-minute
   * build/commit window was not published and must stay saved for the next publish.
   *
   * "Newer" is judged at MILLISECOND resolution, because `updatedAt` reaches callers as a JS
   * Date and the store's timestamps are finer-grained than that (see the drizzle
   * implementation): a captured row must always be deleted, even though its stored timestamp
   * carries digits the Date dropped.
   */
  deletePublished(
    projectId: string,
    entries: { path: string; updatedAt: Date }[],
  ): Promise<void>;
}

export interface AuditRepo {
  record(input: {
    orgId: string;
    actorUserId?: string | null;
    action: string;
    target?: string | null;
    meta?: Record<string, unknown>;
  }): Promise<void>;
}

/** The full data seam handed to control-plane logic. */
/**
 * Directed teammate-collaboration overrides (Team delegation — D4). Default-allow: an ABSENT
 * row means the ask is permitted, so the relay's authz check reads a single row (or its
 * absence). Only pairs the human has touched exist here.
 */
export interface AgentLinkRepo {
  /** Every override row for a project — the Settings matrix reads this. */
  listByProject(projectId: string): Promise<AgentLink[]>;
  /** The override for one directed edge, or null (null = default-allow). */
  get(fromAgentId: string, toAgentId: string): Promise<AgentLink | null>;
  /** Upsert one directed edge's enabled flag (the matrix toggle). */
  set(input: {
    projectId: string;
    fromAgentId: string;
    toAgentId: string;
    enabled: boolean;
  }): Promise<void>;
}

/** The cross-agent correlation record for teammate asks (Team delegation — D6). */
export interface DelegationRepo {
  insert(input: {
    projectId: string;
    fromAgentId: string;
    fromEnvironmentId: string | null;
    toAgentId: string;
    toEnvironmentId: string | null;
  }): Promise<Delegation>;
  /** One delegation row — the resume hook checks it's still `waiting` before settling it. */
  findById(id: string): Promise<Delegation | null>;
  /** Settle a delegation row once the peer turn finishes (or fails). */
  finalize(
    id: string,
    patch: {
      status: string;
      error?: string | null;
      externalSessionId?: string | null;
      runId?: string | null;
      finishedAt?: Date;
    },
  ): Promise<void>;
  /** Active (running, not stale) delegations on one directed edge — the per-edge cap. */
  countActiveEdge(fromAgentId: string, toAgentId: string, since: Date): Promise<number>;
  /** Active (running, not stale) delegations across a project — the project-wide cap. */
  countActiveProject(projectId: string, since: Date): Promise<number>;
}

/**
 * Front of House inbox rows (mirrors WorkspaceTaskRepo: a small user-facing projection a
 * badge polls). Recipient model (D5): `userId` set = that user's item; `userId` NULL = visible
 * to every user with access to the item's project.
 */
export interface InboxItemRepo {
  /**
   * File one inbox item. Conflict-safe on request identity (issue #221 finding 4): when
   * `requestId` is set and a pending row for (sessionId, requestId) already exists —
   * including one a concurrent writer just inserted — the existing pending row is returned
   * instead of a duplicate. Items without a requestId (`finished`) always insert.
   */
  insert(input: {
    projectId: string;
    sessionId: string;
    kind: string;
    prompt?: string | null;
    requestId?: string | null;
    agentId?: string | null;
    userId?: string | null;
    delegationId?: string | null;
    runId?: string | null;
  }): Promise<InboxItem>;
  /** Mark one item resolved (idempotent on already-resolved rows). */
  resolve(id: string): Promise<void>;
  /** Resolve every pending item for a session, optionally only the given kinds. */
  resolveBySession(sessionId: string, kinds?: string[]): Promise<void>;
  /** A session's pending items, oldest first (dedupe by requestId happens here). */
  findPendingBySession(sessionId: string): Promise<InboxItem[]>;
  /**
   * The viewer's pending items across their scoped projects, newest first: items addressed to
   * them (`user_id = userId`) plus team-wide items (`user_id IS NULL`) — D5 visibility.
   */
  listPendingForProjects(projectIds: string[], userId: string): Promise<InboxItem[]>;
  /** Badge count over the same visibility rule as listPendingForProjects. */
  countPendingForProjects(projectIds: string[], userId: string): Promise<number>;
}

/** Per-viewer FOH read cursors (D3): unread = session.lastEventAt > lastReadAt. */
export interface ConversationReadRepo {
  /** Record the viewer's read cursor; later of (existing, at) wins so cursors only advance. */
  upsert(sessionId: string, userId: string, at: Date): Promise<void>;
  listForUser(userId: string, sessionIds: string[]): Promise<ConversationRead[]>;
}

export interface RunRepo {
  /**
   * Settle runs interrupted when one deployment is stopped or replaced. The status guard makes
   * this safe to call after a turn has already reported its own terminal result.
   */
  failRunningByDeployment(
    deploymentId: string,
    error: string,
    finishedAt?: Date,
  ): Promise<number>;
  /** In-flight (`running`) runs currently attributed to one deployment — the drain watcher's idle signal. */
  countRunningByDeployment(deploymentId: string): Promise<number>;
}

export interface DataStore {
  agents: AgentRepo;
  releases: ReleaseRepo;
  deployments: DeploymentRepo;
  environments: EnvironmentRepo;
  projects: ProjectRepo;
  jobs: JobRepo;
  workspaceTasks: WorkspaceTaskRepo;
  drafts: DraftRepo;
  audit: AuditRepo;
  agentLinks: AgentLinkRepo;
  delegations: DelegationRepo;
  runs: RunRepo;
  inboxItems: InboxItemRepo;
  conversationReads: ConversationReadRepo;
}
