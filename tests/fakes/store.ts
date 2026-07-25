/**
 * In-memory DataStore for unit tests — the fake behind the repository seam (app/data/ports.ts).
 * Lets the deploy controller and queue be tested with zero I/O: no Postgres, no docker, no
 * clock. It models the shapes and the observable contract (uniqueness, ordering, claim-once);
 * guarantees that only the engine can provide (real row locking) are trusted at the schema
 * level, per the test strategy.
 */
import type {
  Agent,
  AgentLink,
  ConversationRead,
  DataStore,
  Delegation,
  Deployment,
  DraftChange,
  Environment,
  InboxItem,
  Job,
  Project,
  Release,
  Run,
  WorkspaceTask,
} from "~/data/ports";

/** A collision error shaped like the Postgres one isVersionLabelCollision looks for. */
function versionCollision(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: "releases_agent_version_uq",
  });
}

/** An in-flight deployment (pending/building) per environment. */
const IN_FLIGHT_STATUSES = new Set(["pending", "building"]);

/** The Postgres unique-violation raised by the deployments_env_inflight_uq partial index. */
function inflightDeploymentCollision(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: "deployments_env_inflight_uq",
  });
}

export interface FakeStore extends DataStore {
  /** Test seams: pre-populate rows the logic reads but doesn't create. */
  seedProject(p: Partial<Project> & { id: string; orgId: string }): Project;
  seedAgent(a: {
    id: string;
    projectId: string;
    name?: string;
    root?: string;
    kind?: string;
    pendingName?: string | null;
  }): Agent;
  seedEnvironment(e: {
    id: string;
    projectId: string;
    agentId?: string;
    name?: string;
  }): Environment;
  seedRun(r: Partial<Run> & { id: string; projectId: string }): Run;
  /** Inspect a run seeded into this fake after repository operations. */
  getRun(id: string): Run | null;
  seedInboxItem(
    i: Partial<InboxItem> & { id: string; projectId: string; sessionId: string; kind: string },
  ): InboxItem;
  /** Inspect an inbox item (including resolved ones the pending queries hide). */
  getInboxItem(id: string): InboxItem | null;
  /** Inspect a viewer's read cursor for a session. */
  getConversationRead(sessionId: string, userId: string): ConversationRead | null;
  /** Force the next N release inserts to raise a version-collision (exercises retry). */
  forceReleaseCollisions(n: number): void;
  /** Inspect recorded audit entries (meta included — pipeline audits assert on it). */
  readonly auditEntries: {
    action: string;
    target?: string | null;
    orgId: string;
    meta?: Record<string, unknown> | null;
  }[];
}

export function makeFakeStore(): FakeStore {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const projects = new Map<string, Project>();
  const agents = new Map<string, Agent>();
  const environments = new Map<string, Environment>();
  const releases = new Map<string, Release>();
  const deployments = new Map<string, Deployment>();
  const jobs = new Map<string, Job>();
  const workspaceTasks = new Map<string, WorkspaceTask>();
  const drafts = new Map<string, DraftChange>(); // key: projectId|path
  const agentLinks = new Map<string, AgentLink>(); // key: fromAgentId|toAgentId
  const delegations = new Map<string, Delegation>();
  const runs = new Map<string, Run>();
  const inboxItems = new Map<string, InboxItem>();
  const conversationReads = new Map<string, ConversationRead>(); // key: sessionId|userId
  const auditEntries: {
    action: string;
    target?: string | null;
    orgId: string;
    meta?: Record<string, unknown> | null;
  }[] = [];
  let forcedCollisions = 0;

  const cascadeAgent = (agentId: string) => {
    agents.delete(agentId);
    for (const [environmentId, environment] of environments) {
      if (environment.agentId !== agentId) continue;
      environments.delete(environmentId);
      for (const [deploymentId, deployment] of deployments) {
        if (deployment.environmentId === environmentId) deployments.delete(deploymentId);
      }
    }
    for (const [releaseId, release] of releases) {
      if (release.agentId === agentId) releases.delete(releaseId);
    }
  };

  return {
    auditEntries,

    seedProject(p) {
      const row: Project = {
        id: p.id,
        orgId: p.orgId,
        name: p.name ?? "Agent",
        slug: p.slug ?? "agent",
        layout: p.layout ?? "single",
        teamId: p.teamId ?? null,
        repoOwner: p.repoOwner ?? null,
        repoName: p.repoName ?? null,
        repoInstallationId: p.repoInstallationId ?? null,
        defaultBranch: p.defaultBranch ?? "main",
        liveEnvironmentName: p.liveEnvironmentName ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      projects.set(row.id, row);
      return row;
    },
    seedAgent(a) {
      const row: Agent = {
        id: a.id,
        projectId: a.projectId,
        name: a.name ?? "agent",
        root: a.root ?? "agent",
        kind: a.kind ?? "member",
        pendingName: a.pendingName ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      agents.set(row.id, row);
      return row;
    },
    seedEnvironment(e) {
      const row: Environment = {
        id: e.id,
        projectId: e.projectId,
        agentId: e.agentId ?? `agent-for-${e.projectId}`,
        name: e.name ?? "production",
        createdAt: new Date(0),
      };
      environments.set(row.id, row);
      return row;
    },
    seedRun(r) {
      const row: Run = {
        id: r.id,
        projectId: r.projectId,
        agentId: r.agentId ?? null,
        deploymentId: r.deploymentId ?? null,
        releaseId: r.releaseId ?? null,
        sessionId: r.sessionId ?? null,
        externalRunId: r.externalRunId ?? null,
        channel: r.channel ?? null,
        status: r.status ?? "running",
        tokensInput: r.tokensInput ?? null,
        tokensOutput: r.tokensOutput ?? null,
        wallClockMs: r.wallClockMs ?? null,
        error: r.error ?? null,
        metadata: r.metadata ?? {},
        startedAt: r.startedAt ?? new Date(0),
        finishedAt: r.finishedAt ?? null,
      };
      runs.set(row.id, row);
      return row;
    },
    getRun(rid) {
      return runs.get(rid) ?? null;
    },
    seedInboxItem(i) {
      const now = new Date(++seq);
      const row: InboxItem = {
        id: i.id,
        projectId: i.projectId,
        sessionId: i.sessionId,
        delegationId: i.delegationId ?? null,
        runId: i.runId ?? null,
        agentId: i.agentId ?? null,
        userId: i.userId ?? null,
        kind: i.kind,
        prompt: i.prompt ?? null,
        requestId: i.requestId ?? null,
        status: i.status ?? "pending",
        resolvedAt: i.resolvedAt ?? null,
        createdAt: i.createdAt ?? now,
        updatedAt: i.updatedAt ?? now,
      };
      inboxItems.set(row.id, row);
      return row;
    },
    getInboxItem(iid) {
      return inboxItems.get(iid) ?? null;
    },
    getConversationRead(sessionId, userId) {
      return conversationReads.get(`${sessionId}|${userId}`) ?? null;
    },
    forceReleaseCollisions(n) {
      forcedCollisions = n;
    },

    agents: {
      async findById(aid) {
        return agents.get(aid) ?? null;
      },
      async listByProject(projectId) {
        return [...agents.values()]
          .filter((a) => a.projectId === projectId)
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async syncRoster(projectId, roster, options) {
        if (roster.length > 0) {
          const keep = new Set(roster.map((m) => m.name));
          for (const [aid, a] of agents) {
            // Only prune tree-detected members; internal rows (assistant) survive sync.
            if (a.projectId === projectId && a.kind === "member" && !keep.has(a.name))
              cascadeAgent(aid);
          }
          for (const m of roster) {
            const existing = [...agents.values()].find(
              (a) => a.projectId === projectId && a.name === m.name,
            );
            if (existing) {
              agents.set(existing.id, { ...existing, root: m.root, updatedAt: new Date(++seq) });
            } else {
              const aid = id("agent");
              agents.set(aid, {
                id: aid,
                projectId,
                name: m.name,
                root: m.root,
                kind: "member",
                pendingName: null,
                createdAt: new Date(++seq),
                updatedAt: new Date(seq),
              });
            }
          }
        } else if (options?.allowEmpty) {
          for (const [aid, a] of agents) {
            if (a.projectId === projectId && a.kind === "member") cascadeAgent(aid);
          }
        }
        return [...agents.values()]
          .filter((a) => a.projectId === projectId)
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async rename(aid, patch) {
        const existing = agents.get(aid);
        if (!existing) throw new Error("agent not found");
        const row = {
          ...existing,
          name: patch.name,
          root: patch.root,
          pendingName: null,
          updatedAt: new Date(++seq),
        };
        agents.set(aid, row);
        return row;
      },
      async setPendingName(aid, pendingName) {
        const existing = agents.get(aid);
        if (!existing) return;
        agents.set(aid, { ...existing, pendingName, updatedAt: new Date(++seq) });
      },
      async findAssistant(projectId) {
        return (
          [...agents.values()].find(
            (a) => a.projectId === projectId && a.kind === "assistant",
          ) ?? null
        );
      },
      async createAssistant(input) {
        const aid = id("agent");
        const row: Agent = {
          id: aid,
          projectId: input.projectId,
          name: input.name,
          root: input.root,
          kind: "assistant",
          pendingName: null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        agents.set(aid, row);
        return row;
      },
    },

    releases: {
      async countByAgent(agentId) {
        return [...releases.values()].filter((r) => r.agentId === agentId).length;
      },
      async insert(input) {
        if (forcedCollisions > 0) {
          forcedCollisions--;
          throw versionCollision();
        }
        const dup = [...releases.values()].some(
          (r) => r.agentId === input.agentId && r.version === input.version,
        );
        if (dup) throw versionCollision();
        const row: Release = {
          id: id("rel"),
          projectId: input.projectId,
          agentId: input.agentId,
          version: input.version,
          gitSha: input.gitSha,
          imageRef: null,
          changelog: input.changelog ?? null,
          createdBy: input.createdBy ?? null,
          createdAt: new Date(seq),
        };
        releases.set(row.id, row);
        return row;
      },
      async findById(rid) {
        return releases.get(rid) ?? null;
      },
      async findByCommit(agentId, gitSha) {
        return (
          [...releases.values()].find(
            (r) => r.agentId === agentId && r.gitSha === gitSha,
          ) ?? null
        );
      },
      async setImageRef(rid, imageRef) {
        const r = releases.get(rid);
        if (r) releases.set(rid, { ...r, imageRef });
      },
      async listByProject(projectId) {
        return [...releases.values()]
          .filter((r) => r.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
    },

    deployments: {
      async findById(did) {
        return deployments.get(did) ?? null;
      },
      async insert(input) {
        // Model deployments_env_inflight_uq: at most one pending/building row per environment,
        // so the concurrent-provision race (#31) is exercisable without Postgres.
        if (
          IN_FLIGHT_STATUSES.has(input.status) &&
          [...deployments.values()].some(
            (d) => d.environmentId === input.environmentId && IN_FLIGHT_STATUSES.has(d.status),
          )
        ) {
          throw inflightDeploymentCollision();
        }
        const row: Deployment = {
          id: id("dep"),
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          status: input.status,
          trafficWeight: input.trafficWeight,
          url: null,
          errorDetail: null,
          createdBy: input.createdBy ?? null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        deployments.set(row.id, row);
        return row;
      },
      async update(did, patch) {
        const cur = deployments.get(did);
        if (!cur) throw new Error("deployment not found");
        const next = { ...cur, ...patch, updatedAt: new Date(++seq) };
        // The partial unique index also rejects an UPDATE that moves a second row in-flight.
        if (
          patch.status !== undefined &&
          IN_FLIGHT_STATUSES.has(next.status) &&
          [...deployments.values()].some(
            (d) =>
              d.id !== did &&
              d.environmentId === cur.environmentId &&
              IN_FLIGHT_STATUSES.has(d.status),
          )
        ) {
          throw inflightDeploymentCollision();
        }
        deployments.set(did, next);
        return next;
      },
      async listByEnvironment(environmentId) {
        return [...deployments.values()]
          .filter((d) => d.environmentId === environmentId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((d) => {
            const rel = releases.get(d.releaseId);
            return {
              id: d.id,
              status: d.status,
              trafficWeight: d.trafficWeight,
              url: d.url,
              errorDetail: d.errorDetail,
              createdAt: d.createdAt,
              releaseId: d.releaseId,
              version: rel?.version ?? "?",
              gitSha: rel?.gitSha ?? "?",
            };
          });
      },
      async drainLive(environmentId) {
        for (const [did, d] of deployments) {
          if (d.environmentId === environmentId && d.status === "live") {
            deployments.set(did, { ...d, status: "draining", trafficWeight: 0 });
          }
        }
      },
      async deleteFailed(environmentId) {
        for (const [did, d] of deployments) {
          if (d.environmentId === environmentId && d.status === "failed") {
            deployments.delete(did);
          }
        }
      },
      async setWeights(environmentId, weights) {
        for (const w of weights) {
          const d = deployments.get(w.deploymentId);
          if (d && d.environmentId === environmentId) {
            deployments.set(d.id, { ...d, trafficWeight: Math.max(0, Math.round(w.weight)) });
          }
        }
      },
    },

    environments: {
      async findById(eid) {
        return environments.get(eid) ?? null;
      },
      async listByProject(projectId) {
        return [...environments.values()]
          .filter((e) => e.projectId === projectId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
      },
      async listByAgent(agentId) {
        return [...environments.values()]
          .filter((e) => e.agentId === agentId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
      },
      async listAll() {
        return [...environments.values()];
      },
      async ensureDefault(projectId, agentId) {
        const has = [...environments.values()].some((e) => e.agentId === agentId);
        if (has) return;
        const eid = id("env");
        environments.set(eid, {
          id: eid,
          projectId,
          agentId,
          name: "default",
          createdAt: new Date(++seq),
        });
      },
      async create(input) {
        const dup = [...environments.values()].some(
          (e) => e.agentId === input.agentId && e.name === input.name,
        );
        if (dup) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint_name: "environments_agent_name_uq",
          });
        }
        const eid = id("env");
        const row = { id: eid, ...input, createdAt: new Date(++seq) };
        environments.set(eid, row);
        return row;
      },
      async rename(eid, name) {
        const env = environments.get(eid);
        if (!env) return;
        const dup = [...environments.values()].some(
          (e) => e.agentId === env.agentId && e.name === name && e.id !== eid,
        );
        if (dup) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint_name: "environments_agent_name_uq",
          });
        }
        environments.set(eid, { ...env, name });
      },
      async deleteById(eid) {
        const env = environments.get(eid);
        if (!env) return false;
        const siblings = [...environments.values()].filter(
          (e) => e.agentId === env.agentId,
        );
        if (siblings.length <= 1) return false;
        environments.delete(eid);
        // Mirror the FK cascade: the env's deployments go with it.
        for (const [did, d] of deployments) {
          if (d.environmentId === eid) deployments.delete(did);
        }
        return true;
      },
    },

    projects: {
      async findById(pid) {
        return projects.get(pid) ?? null;
      },
      async findByRepo(owner, repo) {
        return (
          [...projects.values()].find(
            (p) => p.repoOwner === owner && p.repoName === repo,
          ) ?? null
        );
      },
      async getByOrg(orgId, pid) {
        const p = projects.get(pid);
        return p && p.orgId === orgId ? p : null;
      },
      async listByOrg(orgId) {
        return [...projects.values()]
          .filter((p) => p.orgId === orgId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async slugExists(orgId, slug) {
        return [...projects.values()].some((p) => p.orgId === orgId && p.slug === slug);
      },
      async create(input) {
        const row: Project = {
          id: id("proj"),
          orgId: input.orgId,
          name: input.name,
          slug: input.slug,
          layout: input.layout ?? "single",
          // Repo teams (FOH D9) are minted by ensureProjectTeam, never at insert.
          teamId: null,
          repoOwner: input.repoOwner ?? null,
          repoName: input.repoName ?? null,
          repoInstallationId: input.repoInstallationId ?? null,
          defaultBranch: input.defaultBranch ?? "main",
          liveEnvironmentName: null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        projects.set(row.id, row);
        return row;
      },
      async setLiveEnvironmentName(pid, name) {
        const p = projects.get(pid);
        if (p) projects.set(pid, { ...p, liveEnvironmentName: name, updatedAt: new Date(++seq) });
      },
      async deleteById(pid) {
        projects.delete(pid);
        // Mirror the FK cascade the schema enforces.
        for (const [aid, a] of agents) if (a.projectId === pid) agents.delete(aid);
        for (const [eid, e] of environments) {
          if (e.projectId === pid) {
            environments.delete(eid);
            for (const [did, d] of deployments) {
              if (d.environmentId === eid) deployments.delete(did);
            }
          }
        }
        for (const [rid, r] of releases) if (r.projectId === pid) releases.delete(rid);
        for (const [k, d] of drafts) if (d.projectId === pid) drafts.delete(k);
      },
    },

    jobs: {
      async insert(input) {
        const jid = id("job");
        jobs.set(jid, {
          id: jid,
          kind: input.kind,
          payload: input.payload,
          status: "queued",
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
          runAt: input.runAt ?? new Date(0),
          error: null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        });
        return jid;
      },
      async claimNext(now) {
        const due = [...jobs.values()]
          .filter((j) => j.status === "queued" && j.runAt.getTime() <= now.getTime())
          .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
        const job = due[0];
        if (!job) return null;
        const claimed = { ...job, status: "running", attempts: job.attempts + 1 };
        jobs.set(job.id, claimed);
        return claimed;
      },
      async update(jid, patch) {
        const cur = jobs.get(jid);
        if (cur) jobs.set(jid, { ...cur, ...patch, updatedAt: new Date(++seq) });
      },
      async requeueRunning() {
        let n = 0;
        for (const [jid, j] of jobs) {
          if (j.status === "running") {
            jobs.set(jid, { ...j, status: "queued", runAt: new Date(0) });
            n++;
          }
        }
        return n;
      },
      async statsByStatus() {
        const out: Record<string, number> = {};
        for (const j of jobs.values()) out[j.status] = (out[j.status] ?? 0) + 1;
        return out;
      },
    },

    workspaceTasks: {
      async insert(input) {
        const tid = id("wtask");
        const now = new Date(++seq);
        const row: WorkspaceTask = {
          id: tid,
          projectId: input.projectId,
          kind: input.kind,
          subjectKey: input.subjectKey,
          label: input.label,
          steps: input.steps ?? null,
          status: "running",
          originUrl: input.originUrl,
          resultUrl: null,
          error: null,
          jobId: input.jobId ?? null,
          dismissedAt: null,
          createdBy: input.createdBy ?? null,
          createdAt: now,
          updatedAt: now,
        };
        workspaceTasks.set(tid, row);
        return row;
      },
      async update(tid, patch) {
        const cur = workspaceTasks.get(tid);
        if (cur) workspaceTasks.set(tid, { ...cur, ...patch, updatedAt: new Date(++seq) });
      },
      async findById(tid) {
        return workspaceTasks.get(tid) ?? null;
      },
      async listActive(projectId, terminalSince) {
        return [...workspaceTasks.values()]
          .filter(
            (t) =>
              t.projectId === projectId &&
              t.dismissedAt === null &&
              (t.status === "running" || t.updatedAt.getTime() >= terminalSince.getTime()),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async findRunningBySubject(projectId, subjectKey) {
        return (
          [...workspaceTasks.values()].find(
            (t) =>
              t.projectId === projectId &&
              t.subjectKey === subjectKey &&
              t.status === "running" &&
              t.dismissedAt === null,
          ) ?? null
        );
      },
    },

    drafts: {
      async upsert(input) {
        const key = `${input.projectId}|${input.path}`;
        const existing = drafts.get(key);
        const row: DraftChange = {
          id: existing?.id ?? id("draft"),
          projectId: input.projectId,
          agentId: input.agentId,
          path: input.path,
          content: input.content,
          baseSha: input.baseSha ?? null,
          createdBy: input.createdBy ?? null,
          createdAt: existing?.createdAt ?? new Date(++seq),
          updatedAt: new Date(++seq),
        };
        drafts.set(key, row);
        return row;
      },
      async get(projectId, path) {
        return drafts.get(`${projectId}|${path}`) ?? null;
      },
      async listByProject(projectId) {
        return [...drafts.values()]
          .filter((d) => d.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async deleteByPaths(projectId, paths) {
        for (const p of paths) drafts.delete(`${projectId}|${p}`);
      },
    },

    audit: {
      async record(input) {
        auditEntries.push({
          action: input.action,
          target: input.target,
          orgId: input.orgId,
          meta: input.meta,
        });
      },
    },

    agentLinks: {
      async listByProject(projectId) {
        return [...agentLinks.values()].filter((l) => l.projectId === projectId);
      },
      async get(fromAgentId, toAgentId) {
        return agentLinks.get(`${fromAgentId}|${toAgentId}`) ?? null;
      },
      async set(input) {
        const key = `${input.fromAgentId}|${input.toAgentId}`;
        const existing = agentLinks.get(key);
        agentLinks.set(key, {
          id: existing?.id ?? id("link"),
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          enabled: input.enabled,
          createdAt: existing?.createdAt ?? new Date(++seq),
          updatedAt: new Date(++seq),
        });
      },
    },

    delegations: {
      async insert(input) {
        const row: Delegation = {
          id: id("deleg"),
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          fromEnvironmentId: input.fromEnvironmentId,
          toAgentId: input.toAgentId,
          toEnvironmentId: input.toEnvironmentId,
          externalSessionId: null,
          runId: null,
          status: "running",
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        };
        delegations.set(row.id, row);
        return row;
      },
      async findById(did) {
        return delegations.get(did) ?? null;
      },
      async finalize(did, patch) {
        const cur = delegations.get(did);
        if (!cur) return;
        delegations.set(did, {
          ...cur,
          status: patch.status,
          error: patch.error ?? null,
          externalSessionId:
            patch.externalSessionId !== undefined
              ? patch.externalSessionId
              : cur.externalSessionId,
          runId: patch.runId !== undefined ? patch.runId : cur.runId,
          finishedAt: patch.finishedAt ?? new Date(),
        });
      },
      async countActiveEdge(fromAgentId, toAgentId, since) {
        return [...delegations.values()].filter(
          (d) =>
            d.fromAgentId === fromAgentId &&
            d.toAgentId === toAgentId &&
            d.status === "running" &&
            d.startedAt.getTime() > since.getTime(),
        ).length;
      },
      async countActiveProject(projectId, since) {
        return [...delegations.values()].filter(
          (d) =>
            d.projectId === projectId &&
            d.status === "running" &&
            d.startedAt.getTime() > since.getTime(),
        ).length;
      },
    },

    runs: {
      async failRunningByDeployment(
        deploymentId,
        error,
        finishedAt = new Date(),
      ) {
        let failed = 0;
        for (const [rid, run] of runs) {
          if (run.deploymentId !== deploymentId || run.status !== "running")
            continue;
          runs.set(rid, {
            ...run,
            status: "failed",
            error,
            finishedAt,
            wallClockMs: Math.min(
              2_147_483_647,
              Math.max(0, finishedAt.getTime() - run.startedAt.getTime()),
            ),
          });
          failed++;
        }
        return failed;
      },
      async countRunningByDeployment(deploymentId) {
        let running = 0;
        for (const run of runs.values()) {
          if (run.deploymentId === deploymentId && run.status === "running") running++;
        }
        return running;
      },
    },

    inboxItems: {
      async insert(input) {
        // Mirror the drizzle repo's conflict-safe request identity (issue #221 finding 4):
        // a pending row for the same (sessionId, requestId) is returned, not duplicated.
        if (input.requestId != null) {
          const existing = [...inboxItems.values()].find(
            (i) =>
              i.sessionId === input.sessionId &&
              i.requestId === input.requestId &&
              i.status === "pending",
          );
          if (existing) return existing;
        }
        const now = new Date(++seq);
        const row: InboxItem = {
          id: id("inbox"),
          projectId: input.projectId,
          sessionId: input.sessionId,
          delegationId: input.delegationId ?? null,
          runId: input.runId ?? null,
          agentId: input.agentId ?? null,
          userId: input.userId ?? null,
          kind: input.kind,
          prompt: input.prompt ?? null,
          requestId: input.requestId ?? null,
          status: "pending",
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        inboxItems.set(row.id, row);
        return row;
      },
      async resolve(iid) {
        const cur = inboxItems.get(iid);
        if (!cur || cur.status !== "pending") return;
        inboxItems.set(iid, {
          ...cur,
          status: "resolved",
          resolvedAt: new Date(++seq),
          updatedAt: new Date(seq),
        });
      },
      async resolveBySession(sessionId, kinds) {
        for (const [iid, item] of inboxItems) {
          if (item.sessionId !== sessionId || item.status !== "pending") continue;
          if (kinds && kinds.length > 0 && !kinds.includes(item.kind)) continue;
          inboxItems.set(iid, {
            ...item,
            status: "resolved",
            resolvedAt: new Date(++seq),
            updatedAt: new Date(seq),
          });
        }
      },
      async findPendingBySession(sessionId) {
        return [...inboxItems.values()]
          .filter((i) => i.sessionId === sessionId && i.status === "pending")
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async listPendingForProjects(projectIds, userId) {
        const scope = new Set(projectIds);
        return [...inboxItems.values()]
          .filter(
            (i) =>
              scope.has(i.projectId) &&
              i.status === "pending" &&
              (i.userId === userId || i.userId === null),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async countPendingForProjects(projectIds, userId) {
        const scope = new Set(projectIds);
        let n = 0;
        for (const i of inboxItems.values()) {
          if (
            scope.has(i.projectId) &&
            i.status === "pending" &&
            (i.userId === userId || i.userId === null)
          )
            n++;
        }
        return n;
      },
    },

    conversationReads: {
      async upsert(sessionId, userId, at) {
        const key = `${sessionId}|${userId}`;
        const existing = conversationReads.get(key);
        // Only-advance: a stale tab's late write must not rewind the cursor.
        if (existing && existing.lastReadAt.getTime() >= at.getTime()) return;
        conversationReads.set(key, { sessionId, userId, lastReadAt: at });
      },
      async listForUser(userId, sessionIds) {
        const scope = new Set(sessionIds);
        return [...conversationReads.values()].filter(
          (r) => r.userId === userId && scope.has(r.sessionId),
        );
      },
    },
  };
}
