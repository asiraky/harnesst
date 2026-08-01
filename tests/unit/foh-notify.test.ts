/**
 * #288 3c — `notifyHumans` against in-memory fakes (the `runAsk`/`parkChannelQuestion` deps
 * pattern: zero I/O).
 *
 * What matters here: identity comes ONLY from the token's deployment id, byte caps refuse
 * absurd payloads before any write, the per-agent open-conversation ceiling refuses spam as a
 * readable business outcome, and a successful notify opens a team-wide FOH row with NO eve
 * handles and NO pending-input park (a notice is not a blocking ask) plus a `notice` inbox
 * item behind the bell. No idempotency, by design — the tool is fire-and-forget.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordInboxNotice } from "~/foh/inbox.server";
import { notifyHumans, type NotifyDeps } from "~/foh/notify.server";
import { titleFromMessage } from "~/foh/session-title";
import type { PlaygroundSession } from "~/playground/sessions.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const NOW = new Date(1_700_000_000_000);

let store: FakeStore;

/** Seed project → agent → environment → live deployment, and return the deployment id. */
async function seedDeployment(): Promise<string> {
  store.seedProject({ id: PROJECT, orgId: "org_1" });
  store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
  store.seedEnvironment({
    id: "env_1",
    projectId: PROJECT,
    agentId: "agent_1",
    name: "production",
  });
  const release = await store.releases.insert({
    projectId: PROJECT,
    agentId: "agent_1",
    version: "v1",
    gitSha: "a".repeat(40),
  });
  const dep = await store.deployments.insert({
    environmentId: "env_1",
    releaseId: release.id,
    status: "live",
    trafficWeight: 100,
  });
  return dep.id;
}

function makeDeps(over: Partial<NotifyDeps> = {}): NotifyDeps & {
  created: Array<Parameters<NotifyDeps["createSession"]>[0]>;
  deleted: string[];
} {
  const created: Array<Parameters<NotifyDeps["createSession"]>[0]> = [];
  const deleted: string[] = [];
  let seq = 0;
  return {
    store,
    created,
    deleted,
    createSession: async (input) => {
      created.push(input);
      return {
        id: `ps_${++seq}`,
        projectId: input.projectId,
        agentId: input.agentId,
        createdBy: input.userId,
        surface: input.surface ?? "playground",
        environmentId: input.environmentId ?? null,
        externalSessionId: input.externalSessionId ?? null,
        continuationToken: input.continuationToken ?? null,
        resumeVia: input.resumeVia ?? null,
        title: input.title ?? null,
        openingMessage: input.openingMessage ?? null,
        status: input.status ?? "new",
        pendingInputAt: input.pendingInputAt ?? null,
        lastEventAt: input.lastEventAt ?? null,
        streamIndex: 0,
      } as unknown as PlaygroundSession;
    },
    countOpenAgentSessions: async () => 0,
    openNotice: recordInboxNotice,
    deleteBareSession: async (id) => {
      deleted.push(id);
    },
    inferTitle: async ({ message }) => titleFromMessage(message),
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  store = makeFakeStore();
});

describe("notifyHumans", () => {
  it("opens a team-wide FOH row with the message stored and a notice inbox item", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans(
      { deploymentId, message: "The nightly import finished with 3 warnings." },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.created).toHaveLength(1);
    const created = deps.created[0];
    // `created_by IS NULL` is what makes the row visible to every FOH member (D5): an
    // agent's notification belongs to whoever is around to read it.
    expect(created.userId).toBeNull();
    // The agent-opened badges (list + session header) key on this field alone.
    expect(created.openedByAgentId).toBe("agent_1");
    expect(created.surface).toBe("foh");
    expect(created.projectId).toBe(PROJECT);
    expect(created.agentId).toBe("agent_1");
    expect(created.environmentId).toBe("env_1");
    expect(created.version).toBe("v1");
    expect(created.openingMessage).toBe(
      "The nightly import finished with 3 warnings.",
    );
    // NO eve handles — the row has no eve session until a human replies.
    expect(created.externalSessionId).toBeUndefined();
    expect(created.continuationToken).toBeUndefined();
    // A notice is not a blocking ask: no park; lastEventAt drives the unread badge.
    expect(created.pendingInputAt).toBeUndefined();
    expect(created.lastEventAt).toEqual(NOW);
    const item = store.getInboxItem(result.inboxItemId)!;
    expect(item).toMatchObject({
      projectId: PROJECT,
      sessionId: result.sessionId,
      agentId: "agent_1",
      userId: null,
      kind: "notice",
      prompt: "The nightly import finished with 3 warnings.",
    });
  });

  it("uses the provided title for the row and the bell, else titles from the message", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans(
      { deploymentId, message: "Long report body…", title: "Nightly import report" },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.created[0].title).toBe("Nightly import report");
    expect(store.getInboxItem(result.inboxItemId)!.prompt).toBe(
      "Nightly import report",
    );

    await notifyHumans({ deploymentId, message: "Short and titled by itself." }, deps);
    expect(deps.created[1].title).toBe("Short and titled by itself.");
  });

  it("uses async issue-title inference when no explicit title was sent", async () => {
    const deploymentId = await seedDeployment();
    const inferTitle = vi.fn(async () => "Fix empty session heading");
    const deps = makeDeps({ inferTitle });
    const message =
      "Please work on https://github.com/acme/widgets/issues/286";

    const result = await notifyHumans({ deploymentId, message }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(inferTitle).toHaveBeenCalledWith({
      message,
      project: expect.objectContaining({ id: PROJECT }),
    });
    expect(deps.created[0].title).toBe("Fix empty session heading");
    expect(store.getInboxItem(result.inboxItemId)!.prompt).toBe(
      "Fix empty session heading",
    );
  });

  it("refuses an empty message", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans({ deploymentId, message: "   " }, deps);

    expect(result).toEqual({ ok: false, error: "Send a non-empty message." });
    expect(deps.created).toHaveLength(0);
  });

  it("refuses a message over the 20KB byte cap before any write", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans(
      { deploymentId, message: "x".repeat(20_001) },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too long/);
    expect(deps.created).toHaveLength(0);
  });

  it("refuses a title over the 500-byte cap before any write", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans(
      { deploymentId, message: "hello", title: "t".repeat(501) },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/title is too long/);
    expect(deps.created).toHaveLength(0);
  });

  it("caps open agent-initiated conversations per agent at 100", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({ countOpenAgentSessions: async () => 100 });

    const result = await notifyHumans({ deploymentId, message: "another one" }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/too many open conversations/);
    expect(deps.created).toHaveLength(0);
  });

  it("admits the 99th conversation — the ceiling is >= 100", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({ countOpenAgentSessions: async () => 99 });

    const result = await notifyHumans({ deploymentId, message: "still fits" }, deps);

    expect(result.ok).toBe(true);
  });

  it("reaps the bare session and rethrows when the notice insert fails", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      openNotice: async () => {
        throw new Error("inbox is down");
      },
    });

    // The two writes share no transaction, so a failed bell write must delete the row it
    // orphaned — otherwise a retry doubles the conversation while nobody was ever notified.
    await expect(
      notifyHumans({ deploymentId, message: "the import finished" }, deps),
    ).rejects.toThrow("inbox is down");
    expect(deps.created).toHaveLength(1);
    expect(deps.deleted).toEqual(["ps_1"]);
  });

  it("surfaces the notice failure even when the compensation delete fails too", async () => {
    const deploymentId = await seedDeployment();
    const deps = makeDeps({
      openNotice: async () => {
        throw new Error("inbox is down");
      },
      deleteBareSession: async () => {
        throw new Error("delete also failed");
      },
    });

    await expect(
      notifyHumans({ deploymentId, message: "the import finished" }, deps),
    ).rejects.toThrow("inbox is down");
  });

  it("denies an unknown deployment — identity comes only from the token's id", async () => {
    await seedDeployment();
    const deps = makeDeps();

    const result = await notifyHumans(
      { deploymentId: "dep_ghost", message: "hi" },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: "Your deployment is no longer known to harnesst.",
    });
  });

  it("denies when the environment's agent no longer exists", async () => {
    store.seedProject({ id: PROJECT, orgId: "org_1" });
    store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "dev" });
    store.seedEnvironment({
      id: "env_1",
      projectId: PROJECT,
      // The environment can outlive its agent; the notify must refuse rather than file the
      // conversation under an agent it cannot resolve.
      agentId: "agent_gone",
      name: "production",
    });
    const release = await store.releases.insert({
      projectId: PROJECT,
      agentId: "agent_1",
      version: "v1",
      gitSha: "a".repeat(40),
    });
    const dep = await store.deployments.insert({
      environmentId: "env_1",
      releaseId: release.id,
      status: "live",
      trafficWeight: 100,
    });
    const deps = makeDeps();

    const result = await notifyHumans({ deploymentId: dep.id, message: "hi" }, deps);

    expect(result).toEqual({
      ok: false,
      error: "Your agent is no longer part of this repository.",
    });
  });
});
