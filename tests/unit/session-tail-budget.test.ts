/**
 * What a reconcile is allowed to spend waiting on eve.
 *
 * Eve answers "nothing new" by sending NOTHING — not a 204, not even a response header. Measured
 * against a live production instance on 2026-07-27: a stream request at a settled session's saved
 * cursor returned `code=000` after 6s, while the same endpoint asked for an index it has answers
 * in ~2ms. Since the FOH loader reconciles `running` OR `failed` rows, and a settled row's cursor
 * ALWAYS sits past the end, every open of a failed session ran out the full pre-headers budget —
 * ~3s to open one conversation while its neighbours took 30ms.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  reconcilePlaygroundSessionFromEve,
  tailBudgetsMs,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import type { Target } from "~/chat/playground.server";

const target: Target = {
  deploymentId: "dep_1",
  environmentId: "env_1",
  releaseId: "rel_1",
  url: "https://agent.example.test",
  version: "v1",
  environmentName: "production",
  gitSha: "sha_1",
};

function session(over: Partial<PlaygroundSession> = {}): PlaygroundSession {
  return {
    id: "sess_1",
    externalSessionId: "wrun_1",
    streamIndex: 28,
    status: "failed",
    surface: "foh",
    ...over,
  } as PlaygroundSession;
}

/** A server that accepted the connection and then went silent — eve at a past-the-end cursor. */
function silentEve() {
  return vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("The operation was aborted.")),
      );
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tailBudgetsMs", () => {
  it("waits on a running row and barely waits on a settled one", () => {
    const running = tailBudgetsMs("running");
    for (const status of ["failed", "waiting", "completed", "stopped", "new"]) {
      const settled = tailBudgetsMs(status);
      expect(settled.connectMs).toBeLessThan(running.connectMs);
      expect(settled.idleMs).toBeLessThan(running.idleMs);
      // Two orders of magnitude above eve's measured healthy response, and a read that comes up
      // empty writes nothing — so the cost of being wrong here is one retry on the next load.
      expect(settled.connectMs).toBeGreaterThanOrEqual(100);
    }
  });
});

describe("reconcilePlaygroundSessionFromEve", () => {
  it("gives up on a silent eve fast enough for a settled row to open at human speed", async () => {
    vi.stubGlobal("fetch", silentEve());
    const started = Date.now();
    await expect(
      reconcilePlaygroundSessionFromEve({ session: session(), target }),
    ).rejects.toThrow();
    // The loaders catch this and render from cache; what matters is that the page was not held
    // hostage. The old fixed budget put this at ~3s on EVERY load of the session.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not reach for eve at all without an external session id", async () => {
    const fetchMock = silentEve();
    vi.stubGlobal("fetch", fetchMock);
    const row = session({ externalSessionId: null });
    await expect(
      reconcilePlaygroundSessionFromEve({ session: row, target }),
    ).resolves.toBe(row);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
