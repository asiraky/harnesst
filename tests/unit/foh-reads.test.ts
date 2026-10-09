/**
 * markSessionReadLatest (app/foh/reads.server.ts): the server-side read mark for paths that write
 * `lastEventAt` after the viewer has already seen the content (the drain's terminal save, Stop).
 * It must read the row's CURRENT timestamp, and refuse rows the read route would refuse.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { markSessionReadLatest } from "~/foh/reads.server";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const PROJECT = "proj_1";
const SESSION = "sess_1";
const USER = "user_1";

let store: FakeStore;

beforeEach(() => {
  store = makeFakeStore();
});

function rows(
  row: { lastEventAt: Date | null; archivedAt?: Date | null } | null,
) {
  return async (ids: string[]) =>
    row && ids.includes(SESSION)
      ? [{ id: SESSION, archivedAt: null, ...row }]
      : [];
}

describe("markSessionReadLatest", () => {
  it("advances the cursor to the row's current lastEventAt and clears the viewer's finished item", async () => {
    const settledAt = new Date("2026-10-09T01:00:05Z");
    store.seedInboxItem({
      id: "fin",
      projectId: PROJECT,
      sessionId: SESSION,
      kind: "finished",
      userId: USER,
    });

    await markSessionReadLatest(SESSION, USER, {
      store,
      sessionsByIds: rows({ lastEventAt: settledAt }),
    });

    expect(store.getConversationRead(SESSION, USER)?.lastReadAt).toEqual(
      settledAt,
    );
    expect(store.getInboxItem("fin")?.status).toBe("resolved");
  });

  it("does nothing for an archived conversation", async () => {
    store.seedInboxItem({
      id: "fin",
      projectId: PROJECT,
      sessionId: SESSION,
      kind: "finished",
      userId: USER,
    });

    await markSessionReadLatest(SESSION, USER, {
      store,
      sessionsByIds: rows({
        lastEventAt: new Date(),
        archivedAt: new Date(),
      }),
    });

    expect(store.getConversationRead(SESSION, USER)).toBeNull();
    expect(store.getInboxItem("fin")?.status).toBe("pending");
  });

  it("does nothing when the conversation is gone", async () => {
    await markSessionReadLatest(SESSION, USER, {
      store,
      sessionsByIds: rows(null),
    });

    expect(store.getConversationRead(SESSION, USER)).toBeNull();
  });
});
