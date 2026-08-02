/**
 * FOH inbox helpers (app/foh/inbox.server.ts) + the InboxItemRepo contract, against the
 * in-memory fake store. Pins the substrate behaviors later WPs build on: requestId dedupe
 * (drain and reconcile can both observe the same eve request), D19 kind mapping
 * (confirmation → approval), D5 visibility (user-addressed vs team-wide NULL recipient),
 * and D13 notification acknowledgement on read.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { ChatInputRequest } from "~/chat/types";
import {
  inboxKindForRequest,
  listInboxForViewer,
  openInboxQuestion,
  recordInboxFinished,
  resolveInboxForArchivedSession,
  resolveInboxForSession,
  acknowledgeVisibleInboxOnRead,
} from "~/foh/inbox.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const SESSION = "sess_1";
const USER = "user_1";

let store: FakeStore;

function request(overrides: Partial<ChatInputRequest> = {}): ChatInputRequest {
  return { requestId: "req_1", prompt: "Which account?", ...overrides };
}

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: "org_1" });
});

describe("inboxKindForRequest (D19)", () => {
  it("maps confirmation to approval, everything else to question", () => {
    expect(inboxKindForRequest({ display: "confirmation" })).toBe("approval");
    expect(inboxKindForRequest({ display: "select" })).toBe("question");
    expect(inboxKindForRequest({ display: "text" })).toBe("question");
    expect(inboxKindForRequest({ display: null })).toBe("question");
    expect(inboxKindForRequest({})).toBe("question");
  });
});

describe("openInboxQuestion", () => {
  it("inserts a pending item carrying the request's prompt, refs, and recipient", async () => {
    const item = await openInboxQuestion(
      {
        projectId: PROJECT,
        sessionId: SESSION,
        agentId: "agent_1",
        userId: USER,
        delegationId: "deleg_1",
        runId: "run_1",
        request: request(),
      },
      store,
    );
    expect(item).toMatchObject({
      projectId: PROJECT,
      sessionId: SESSION,
      agentId: "agent_1",
      userId: USER,
      delegationId: "deleg_1",
      runId: "run_1",
      kind: "question",
      prompt: "Which account?",
      requestId: "req_1",
      status: "pending",
    });
  });

  it("dedupes by requestId: the drain and reconcile observing the same request share one item", async () => {
    const input = {
      projectId: PROJECT,
      sessionId: SESSION,
      userId: USER,
      request: request(),
    };
    const first = await openInboxQuestion(input, store);
    const second = await openInboxQuestion(input, store);
    expect(second.id).toBe(first.id);
    expect(await store.inboxItems.findPendingBySession(SESSION)).toHaveLength(1);
  });

  it("does NOT dedupe across sessions or once the earlier item resolved", async () => {
    const first = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    // Other session, same requestId: distinct item.
    const other = await openInboxQuestion(
      { projectId: PROJECT, sessionId: "sess_2", userId: USER, request: request() },
      store,
    );
    expect(other.id).not.toBe(first.id);
    // Resolved item no longer blocks a fresh park on the same request id.
    await store.inboxItems.resolve(first.id);
    const reopened = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    expect(reopened.id).not.toBe(first.id);
  });

  it("records an approval for confirmation requests", async () => {
    const item = await openInboxQuestion(
      {
        projectId: PROJECT,
        sessionId: SESSION,
        userId: null,
        request: request({ display: "confirmation", prompt: "Run rm -rf tmp?" }),
      },
      store,
    );
    expect(item).toMatchObject({ kind: "approval", userId: null });
  });
});

describe("resolveInboxForSession", () => {
  it("resolves pending question/approval items but leaves finished items alone", async () => {
    const q = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    const a = await openInboxQuestion(
      {
        projectId: PROJECT,
        sessionId: SESSION,
        userId: USER,
        request: request({ requestId: "req_2", display: "confirmation" }),
      },
      store,
    );
    const fin = await recordInboxFinished(
      { projectId: PROJECT, sessionId: SESSION, userId: USER },
      store,
    );
    await resolveInboxForSession(SESSION, store);
    expect(store.getInboxItem(q.id)?.status).toBe("resolved");
    expect(store.getInboxItem(a.id)?.status).toBe("resolved");
    expect(store.getInboxItem(fin.id)?.status).toBe("pending");
  });

  it("scopes to the session", async () => {
    const otherSession = await openInboxQuestion(
      { projectId: PROJECT, sessionId: "sess_2", userId: USER, request: request() },
      store,
    );
    await resolveInboxForSession(SESSION, store);
    expect(store.getInboxItem(otherSession.id)?.status).toBe("pending");
  });
});

describe("resolveInboxForArchivedSession (#278)", () => {
  it("resolves finished items too — an archived session can never be opened to read them", async () => {
    const q = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    const fin = await recordInboxFinished(
      { projectId: PROJECT, sessionId: SESSION, userId: USER },
      store,
    );
    const otherSession = await recordInboxFinished(
      { projectId: PROJECT, sessionId: "sess_2", userId: USER },
      store,
    );

    await resolveInboxForArchivedSession(SESSION, new Date(8_640_000_000_000), store);

    expect(store.getInboxItem(q.id)?.status).toBe("resolved");
    expect(store.getInboxItem(fin.id)?.status).toBe("resolved");
    expect(store.getInboxItem(otherSession.id)?.status).toBe("pending");
  });

  it("leaves alone an item filed AFTER the archive — a park that resurrected the row", async () => {
    const before = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    const archivedAt = new Date(Date.now() + 1_000);
    const after = await openInboxQuestion(
      {
        projectId: PROJECT,
        sessionId: SESSION,
        userId: USER,
        request: request({ requestId: "req_2" }),
      },
      store,
    );
    // The fake stamps createdAt from a monotonic counter, so force the ordering the race produces.
    store.setInboxItemCreatedAt(after.id, new Date(archivedAt.getTime() + 1_000));

    await resolveInboxForArchivedSession(SESSION, archivedAt, store);

    // A channel park between the archive UPDATE and this call un-archives the session and files a
    // fresh question. Resolving it would leave a LIVE conversation parked with no bell entry.
    expect(store.getInboxItem(before.id)?.status).toBe("resolved");
    expect(store.getInboxItem(after.id)?.status).toBe("pending");
  });
});

describe("acknowledgeVisibleInboxOnRead (D13)", () => {
  it("resolves read-only items, acknowledges asks, and leaves another user's item alone", async () => {
    const mine = await recordInboxFinished(
      { projectId: PROJECT, sessionId: SESSION, userId: USER },
      store,
    );
    const teamWide = await recordInboxFinished(
      { projectId: PROJECT, sessionId: SESSION, userId: null },
      store,
    );
    const theirs = await recordInboxFinished(
      { projectId: PROJECT, sessionId: SESSION, userId: "user_2" },
      store,
    );
    const question = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );

    await acknowledgeVisibleInboxOnRead(SESSION, USER, store);

    expect(store.getInboxItem(mine.id)?.status).toBe("resolved");
    expect(store.getInboxItem(teamWide.id)?.status).toBe("resolved");
    // An admin opening a member's session must not eat the member's item.
    expect(store.getInboxItem(theirs.id)?.status).toBe("pending");
    // The ask stays pending for request-id dedupe and answer lifecycle, but leaves visible lists.
    expect(store.getInboxItem(question.id)).toMatchObject({
      status: "pending",
      acknowledgedAt: expect.any(Date),
    });
    expect(
      await store.inboxItems.listPendingForProjects([PROJECT], USER),
    ).not.toContainEqual(expect.objectContaining({ id: question.id }));

    // A drain/reconcile retry can observe the same still-parked Eve request after it was read.
    // It must reuse the acknowledged pending row instead of minting the badge again.
    const retried = await openInboxQuestion(
      { projectId: PROJECT, sessionId: SESSION, userId: USER, request: request() },
      store,
    );
    expect(retried.id).toBe(question.id);
    expect(
      await store.inboxItems.listPendingForProjects([PROJECT], USER),
    ).not.toContainEqual(expect.objectContaining({ id: question.id }));
  });
});

describe("D5 visibility (listPendingForProjects / countPendingForProjects)", () => {
  it("a viewer sees their items plus team-wide NULL-recipient items in scoped projects only", async () => {
    store.seedProject({ id: "proj_2", orgId: "org_1" });
    const mine = store.seedInboxItem({
      id: "i_mine",
      projectId: PROJECT,
      sessionId: SESSION,
      kind: "question",
      userId: USER,
    });
    const teamWide = store.seedInboxItem({
      id: "i_team",
      projectId: PROJECT,
      sessionId: "sess_2",
      kind: "question",
      userId: null,
    });
    store.seedInboxItem({
      id: "i_other_user",
      projectId: PROJECT,
      sessionId: SESSION,
      kind: "question",
      userId: "user_2",
    });
    store.seedInboxItem({
      id: "i_out_of_scope",
      projectId: "proj_2",
      sessionId: "sess_3",
      kind: "question",
      userId: USER,
    });
    store.seedInboxItem({
      id: "i_resolved",
      projectId: PROJECT,
      sessionId: SESSION,
      kind: "question",
      userId: USER,
      status: "resolved",
    });

    const listed = await store.inboxItems.listPendingForProjects([PROJECT], USER);
    expect(new Set(listed.map((i) => i.id))).toEqual(
      new Set([mine.id, teamWide.id]),
    );
    expect(await store.inboxItems.countPendingForProjects([PROJECT], USER)).toBe(2);
    expect(await store.inboxItems.countPendingForProjects([], USER)).toBe(0);
    expect(
      await store.inboxItems.countPendingForProjects([PROJECT, "proj_2"], USER),
    ).toBe(3);
  });
});

describe("listInboxForViewer enrichment (#278)", () => {
  it("drops items whose session is archived, like ones whose session vanished", async () => {
    store.seedAgent({ id: "agent_1", projectId: PROJECT, name: "Ada" });
    const live = await recordInboxFinished(
      { projectId: PROJECT, sessionId: "sess_live", userId: USER },
      store,
    );
    await recordInboxFinished(
      { projectId: PROJECT, sessionId: "sess_archived", userId: USER },
      store,
    );
    await recordInboxFinished(
      { projectId: PROJECT, sessionId: "sess_gone", userId: USER },
      store,
    );

    const rows = await listInboxForViewer(
      { userId: USER, projectIds: [PROJECT] },
      store,
      {
        // `sess_gone` is absent from the result entirely — the existing vanished-session drop.
        sessionsByIds: async () => [
          { id: "sess_live", agentId: "agent_1", title: "Live", archivedAt: null },
          {
            id: "sess_archived",
            agentId: "agent_1",
            title: "Tidied away",
            archivedAt: new Date("2026-07-02T00:00:00Z"),
          },
        ],
      },
    );

    // Archiving resolves the items it can see, but a turn settling in the same instant files a
    // `finished` item just after. Dropping on the read side means that race cannot leave a bell
    // entry whose link 404s.
    expect(rows.map((row) => row.id)).toEqual([live.id]);
  });
});

describe("ConversationReadRepo", () => {
  it("upserts an only-advance read cursor per (session, user)", async () => {
    await store.conversationReads.upsert(SESSION, USER, new Date(1_000));
    await store.conversationReads.upsert(SESSION, USER, new Date(3_000));
    // A stale tab's late write must not rewind the cursor.
    await store.conversationReads.upsert(SESSION, USER, new Date(2_000));
    expect(store.getConversationRead(SESSION, USER)?.lastReadAt.getTime()).toBe(
      3_000,
    );
  });

  it("lists cursors for one user across the given sessions only", async () => {
    await store.conversationReads.upsert(SESSION, USER, new Date(1_000));
    await store.conversationReads.upsert("sess_2", USER, new Date(2_000));
    await store.conversationReads.upsert(SESSION, "user_2", new Date(3_000));
    const rows = await store.conversationReads.listForUser(USER, [SESSION]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: SESSION, userId: USER });
  });
});
