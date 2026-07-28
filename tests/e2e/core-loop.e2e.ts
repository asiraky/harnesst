/**
 * FOH core loop, end to end (PRD-FRONT-OF-HOUSE §6 "core loop"): a real Better Auth user
 * sends a message through the REAL /api/foh/:projectId/stream action into a fresh FOH
 * session against a protocol-faithful fake eve — then ABANDONS the response reader mid-turn
 * (the away-mid-turn criterion). The detached drain must still consume eve to `done`,
 * persist the durable transcript (playground_events), land the session `waiting`, and file
 * the `finished` inbox item, with no client attached.
 *
 * Opt-in: HARNESST_DB_SMOKE=1 with DATABASE_URL pointing at the live dev database
 * (`set -a; source .env.local; set +a; HARNESST_DB_SMOKE=1 npm run test:e2e`).
 */
import { describe, expect, it } from "vitest";

import { startFakeEve } from "./fake-eve";
import {
  actionArgs,
  cleanupWorkspace,
  createWorkspace,
  LIVE,
  loaderArgs,
  openNdjson,
  seedTeamStack,
  signUp,
  uniqueSuffix,
  until,
  type TestUser,
} from "./harness";

describe.runIf(LIVE)("FOH core loop (real routes + drain + fake eve)", () => {
  it("streams a turn, survives mid-turn abandonment, and settles everything in the DB", async () => {
    const { db } = await import("~/db/client.server");
    const { eq } = await import("drizzle-orm");
    const { playgroundEvents, playgroundSessions } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { action } = await import("~/routes/api.foh.stream");

    const suffix = uniqueSuffix("core");
    const eve = await startFakeEve();
    let orgId: string | undefined;
    const users: TestUser[] = [];
    let ndjson: ReturnType<typeof openNdjson> | null = null;
    try {
      const owner = await signUp("Core Owner", `foh-e2e-${suffix}@smoke.test`);
      users.push(owner);
      orgId = await createWorkspace(owner, "FOH E2E Core", `foh-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({
        orgId,
        suffix,
        eveUrl: eve.url,
      });

      // Phase 1 of the scripted turn: eve accepts and starts working. The completion is
      // deliberately withheld until the client has walked away.
      eve.onTurn((turn) => {
        eve.emit(turn.sessionId, "session.started", {
          runtime: { modelId: "anthropic/claude-sonnet-5" },
        });
        eve.emit(turn.sessionId, "message.received", {
          message: turn.body.message,
          turnId: "turn_1",
        });
        eve.emit(turn.sessionId, "step.started", {
          turnId: "turn_1",
          sequence: 1,
          stepIndex: 0,
        });
      });

      const res: Response = await action(
        actionArgs({
          path: `/api/foh/${project.id}/stream`,
          cookie: owner.cookie,
          params: { projectId: project.id },
          form: { agentId: agent.id, message: "Ship the release notes" },
        }),
      );
      expect(res.headers.get("content-type")).toContain("x-ndjson");

      // The live stream reaches the browser: first event names the session row.
      ndjson = openNdjson(res);
      const first = await until(
        () => ndjson!.next(),
        "the first NDJSON event",
      );
      expect(first).toMatchObject({ type: "session" });
      const playgroundSessionId = String(first.playgroundSessionId);

      // Away-mid-turn: the human closes the tab while the agent is still working.
      await ndjson.abandon();

      // Now eve finishes the turn with nobody watching.
      const sid = eve.turnPosts[0].acceptedSessionId;
      eve.emit(sid, "message.appended", {
        turnId: "turn_1",
        messageSoFar: "Done — shipped.",
      });
      eve.emit(sid, "message.completed", {
        turnId: "turn_1",
        message: "Done — shipped.",
      });
      eve.emit(sid, "step.completed", {
        turnId: "turn_1",
        sequence: 1,
        stepIndex: 0,
        usage: { inputTokens: 12, outputTokens: 7 },
      });
      eve.emit(sid, "turn.completed", { turnId: "turn_1" });
      eve.emit(sid, "session.waiting", {});
      eve.end(sid);

      // The detached drain settles the session with no client attached.
      const settled = await until(async () => {
        const [row] = await db
          .select()
          .from(playgroundSessions)
          .where(eq(playgroundSessions.id, playgroundSessionId));
        return row?.status === "waiting" ? row : null;
      }, "the abandoned session to settle to `waiting`");
      expect(settled.externalSessionId).toBe(sid);
      expect(settled.continuationToken).toBe("tok_e2e_1");
      expect(settled.streamIndex).toBe(8);
      expect(settled.pendingInputAt).toBeNull();
      expect(settled.title).toBe("Ship the release notes");
      expect(settled.lastEventAt).not.toBeNull();

      // Durable transcript: every eve event landed in playground_events.
      const events = await db
        .select()
        .from(playgroundEvents)
        .where(eq(playgroundEvents.sessionId, playgroundSessionId));
      expect(events).toHaveLength(8);
      expect(events.map((event) => event.type)).toContain("message.completed");

      // The finished turn filed the viewer's inbox pointer (D13).
      const inbox = await until(async () => {
        const pending =
          await drizzleDataStore.inboxItems.findPendingBySession(
            playgroundSessionId,
          );
        return pending.length > 0 ? pending : null;
      }, "the finished inbox item");
      expect(inbox).toMatchObject([
        {
          kind: "finished",
          prompt: "Done — shipped.",
          userId: owner.userId,
          projectId: project.id,
        },
      ]);

      expect(eve.scriptErrors).toEqual([]);
    } finally {
      if (ndjson) await ndjson.abandon();
      await eve.close();
      await cleanupWorkspace(orgId, users);
    }
  });
});

/**
 * Save → Publish, end to end (issue #225 §5): a real user saves an edit through the REAL
 * editor action, the REAL publish resource route reports "Publish 1 change" with its diff,
 * and the pipeline runs all five steps against the live database. There is no browser, so
 * the control/panel assertions are loader-payload assertions; and there is no GitHub or
 * docker, so the pipeline runs through its injected-deps seam (fake commit/build, real
 * store, real releases) — exactly the seam the unit suite uses, but over the live DB and
 * real route modules.
 */
describe.runIf(LIVE)("Save & Publish core loop (real routes + pipeline)", () => {
  it("saves one change, shows it on the publish control with a diff, and publishes through all five steps", async () => {
    const { db } = await import("~/db/client.server");
    const { eq } = await import("drizzle-orm");
    const { jobs, projects } = await import("~/db/schema");
    const { drizzleDataStore } = await import("~/data/drizzle.server");
    const { action: saveAction } = await import(
      "~/routes/projects.$projectId.edit.instructions"
    );
    const { loader: publishLoader } = await import("~/routes/api.publish");
    const { createTask } = await import("~/tasks/tasks.server");
    const { initialPublishSteps, runPublish } = await import(
      "~/publish/pipeline.server"
    );
    const { listTeamEnvNames } = await import("~/deploy/environments.server");
    const { ensureReleasesForCommit } = await import(
      "~/deploy/controller.server"
    );
    const { detectAgentRoots } = await import("~/eve/parse");
    const { syncProjectAgents } = await import("~/db/queries.server");

    const suffix = uniqueSuffix("pub");
    const COMMIT_SHA = "d".repeat(40);
    let orgId: string | undefined;
    const users: TestUser[] = [];
    const jobIds: string[] = [];
    try {
      const owner = await signUp("Pub Owner", `pub-e2e-${suffix}@smoke.test`);
      users.push(owner);
      orgId = await createWorkspace(owner, "Pub E2E", `pub-e2e-${suffix}`);
      const { project, agent } = await seedTeamStack({ orgId, suffix });
      // Connect a repo (identifiers only — no GitHub call succeeds against them; every surface
      // under test degrades or runs through the injected seam).
      await db
        .update(projects)
        .set({
          repoInstallationId: `inst-${suffix}`,
          repoOwner: "acme",
          repoName: "agents",
          layout: "team",
        })
        .where(eq(projects.id, project.id));
      const [environment] = await db
        .insert((await import("~/db/schema")).environments)
        .values({ projectId: project.id, agentId: agent.id, name: "production" })
        .returning();

      // 1. Save in an editor — the REAL instructions editor action stages exactly one draft.
      const saved = await saveAction(
        actionArgs({
          path: `/repos/${project.id}/agents/${agent.name}/edit/instructions`,
          cookie: owner.cookie,
          params: { projectId: project.id, agentName: agent.name },
          form: { content: "# Ivy\nBe helpful.", agent: agent.name },
        }),
      );
      expect(saved).toEqual({ ok: true });

      // 2. The publish control shows "Publish 1 change": the GET payload carries the saved
      //    change, grouped under its owning member.
      const state = (await publishLoader(
        loaderArgs({
          path: `/repos/${project.id}/publish`,
          cookie: owner.cookie,
          params: { projectId: project.id },
        }),
      )) as {
        connected: boolean;
        changeCount: number;
        groups: { member: string | null; files: { path: string }[] }[];
      };
      expect(state.connected).toBe(true);
      expect(state.changeCount).toBe(1);
      expect(state.groups).toMatchObject([
        {
          member: agent.name,
          files: [{ path: `${agent.root}/instructions.md` }],
        },
      ]);

      // 3. The panel row expands to a diff (the repo side is unreachable, so it renders the
      //    whole saved file as an addition — the degrade the panel ships with).
      const diff = (await publishLoader(
        loaderArgs({
          path: `/repos/${project.id}/publish?diff=${encodeURIComponent(`${agent.root}/instructions.md`)}`,
          cookie: owner.cookie,
          params: { projectId: project.id },
        }),
      )) as { patch: string | null };
      expect(diff.patch).toContain("+Be helpful.");

      // 4. Publish: run the pipeline over the live DB through its injected seam (fake GitHub
      //    commit + docker build, real store, real releases, deploy recorded as a row).
      const task = await createTask(
        {
          projectId: project.id,
          kind: "publish",
          subjectKey: "publish",
          label: "Publishing 1 change",
          originUrl: `/repos/${project.id}`,
          steps: initialPublishSteps(),
          createdBy: owner.userId,
        },
        drizzleDataStore,
      );
      const outcome = await runPublish(
        { projectId: project.id, taskId: task.id, createdBy: owner.userId },
        {
          checkBuild: async () => ({ ok: true, skipped: true }),
          listRepoPaths: async () => [`${agent.root}/agent.ts`],
          normalizeDrafts: async (input) => input.files,
          getBranchHead: async () => "base0000head0000sha0000000000000000000000",
          commitToDefaultBranch: async () => ({ sha: COMMIT_SHA }),
          fetchAgentSource: async () =>
            ({ paths: [`${agent.root}/agent.ts`], files: {}, ref: "main" }) as never,
          // No `harnesst/` paths in this tree, so the platform-file gate never reads anything.
          readRepoFile: async () => null,
          detectAgentRoots,
          syncProjectAgents,
          invalidateRepoSource: () => {},
          warmAgentSource: () => {},
          ensureReleasesForCommit,
          queueDeploy: async (input, store = drizzleDataStore) =>
            // A row instead of a job: the deploy step's DB effect without leaving a queued
            // docker build behind for the dev worker to trip over.
            store.deployments.insert({
              environmentId: input.environmentId,
              releaseId: input.releaseId,
              status: "pending",
              trafficWeight: 100,
              createdBy: input.createdBy,
            }),
          listTeamEnvNames: (projectId, store) =>
            listTeamEnvNames(projectId, { store }),
          promoteImage: async () => {
            throw new Error("nothing to promote — no provisional tags in this run");
          },
          removeProvisionalImages: async () => {},
          discardConversationCheckouts: async () => {},
          enqueueJob: async (kind, payload, opts?, store?) => {
            const id = await (await import("~/jobs/queue.server")).enqueue(
              kind,
              payload,
              opts,
              store,
            );
            jobIds.push(id);
            return id;
          },
        },
        drizzleDataStore,
      );

      // All five steps completed and the outcome names what landed.
      expect(outcome.status).toBe("succeeded");
      expect(outcome.commitSha).toBe(COMMIT_SHA);
      expect(outcome.releaseIds).toHaveLength(1);
      expect(outcome.deploymentIds).toHaveLength(1);
      const done = await drizzleDataStore.workspaceTasks.findById(task.id);
      expect(done?.status).toBe("succeeded");
      expect(done?.steps?.map((s) => [s.key, s.status])).toEqual([
        ["check", "succeeded"],
        ["build", "succeeded"],
        ["commit", "succeeded"],
        ["version", "succeeded"],
        ["deploy", "succeeded"],
      ]);

      // The agent has a version at the published commit, queued into its live environment.
      const release = await drizzleDataStore.releases.findByCommit(
        agent.id,
        COMMIT_SHA,
      );
      expect(release).not.toBeNull();
      const deploys = await drizzleDataStore.deployments.listByEnvironment(
        environment.id,
      );
      expect(deploys.map((d) => d.releaseId)).toContain(release!.id);
      // §2.8: the single env name was resolved and persisted without asking.
      const [projectRow] = await db
        .select({ live: projects.liveEnvironmentName })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(projectRow.live).toBe("production");

      // Nothing left to publish: the drafts were consumed and the control reads all-clear.
      const after = (await publishLoader(
        loaderArgs({
          path: `/repos/${project.id}/publish`,
          cookie: owner.cookie,
          params: { projectId: project.id },
        }),
      )) as { changeCount: number; succeeded: { taskId: string } | null };
      expect(after.changeCount).toBe(0);
      expect(after.succeeded?.taskId).toBe(task.id);
    } finally {
      // Jobs have no FK to the project — remove any this run enqueued so the dev worker
      // never picks up a stray row after the workspace cascade.
      for (const id of jobIds) await db.delete(jobs).where(eq(jobs.id, id));
      await cleanupWorkspace(orgId, users);
    }
  });
});

describe.runIf(!LIVE)("FOH core loop e2e (skipped)", () => {
  it("runs only with HARNESST_DB_SMOKE=1 against a live database", () => {
    expect(LIVE).toBe(false);
  });
});
