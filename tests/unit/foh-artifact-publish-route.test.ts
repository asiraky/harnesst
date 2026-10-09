/**
 * The publish route's transport decisions (app/routes/api.foh.artifacts.ts): which bytes a request
 * carries, and how a request that may be large shares the copy slots with the publish it triggers.
 * `publishArtifact` is faked; the slot gate is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ publishArtifact: vi.fn() }));

vi.mock("~/team/token.server", () => ({
  verifyDelegationToken: (token: string) => (token === "good" ? "dep_1" : null),
}));
vi.mock("~/foh/artifacts.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/foh/artifacts.server")>()),
  publishArtifact: mocks.publishArtifact,
  defaultPublishArtifactDeps: () => ({}),
}));

import {
  MAX_CONCURRENT_ARTIFACT_COPIES,
  withArtifactCopySlot,
} from "~/foh/artifacts.server";
import { action, artifactPublishFields } from "~/routes/api.foh.artifacts";

/** A POST with no Content-Length — what a chunked upload looks like to the route. */
function chunked(body: Record<string, unknown>): Request {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Request("http://localhost/api/foh/artifacts", {
    method: "POST",
    headers: { authorization: "Bearer good" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

async function post(request: Request): Promise<unknown> {
  const result = (await action({ request, params: {}, context: {} } as never)) as {
    data: unknown;
  };
  return result.data;
}

beforeEach(() => {
  mocks.publishArtifact.mockReset();
  mocks.publishArtifact.mockResolvedValue({ ok: true });
});
afterEach(() => vi.restoreAllMocks());

describe("artifactPublishFields", () => {
  it("treats an empty contentBase64 as an empty file, not as no bytes", () => {
    const fields = artifactPublishFields({ path: "a.txt", contentBase64: "" });
    expect(fields.ok).toBe(true);
    if (!fields.ok) return;
    expect(fields.suppliedBytes).toBeInstanceOf(Buffer);
    expect(fields.suppliedBytes).toHaveLength(0);
  });

  it("carries no bytes when contentBase64 is absent or null", () => {
    for (const body of [{ path: "a.png" }, { path: "a.png", contentBase64: null }]) {
      const fields = artifactPublishFields(body);
      expect(fields).toMatchObject({ ok: true, suppliedBytes: undefined });
    }
  });

  it("decodes valid base64 and refuses anything else", () => {
    const fields = artifactPublishFields({
      path: "a.bin",
      contentBase64: Buffer.from("hi").toString("base64"),
    });
    expect(fields.ok && fields.suppliedBytes?.toString()).toBe("hi");
    for (const contentBase64 of ["not base64!", 42, "a"]) {
      expect(artifactPublishFields({ path: "a.bin", contentBase64 }).ok).toBe(
        false,
      );
    }
  });

  it("requires a path", () => {
    expect(artifactPublishFields({ contentBase64: "" }).ok).toBe(false);
  });
});

describe("publish route", () => {
  it("hands an empty file's bytes to the publish instead of falling back to a copy", async () => {
    await post(chunked({ path: "artifacts/empty.txt", kind: "file", contentBase64: "" }));
    const input = mocks.publishArtifact.mock.calls[0][0];
    expect(input.suppliedBytes).toHaveLength(0);
  });

  it("never holds a read slot while a path-only publish copies", async () => {
    // Each fake publish copies — takes a slot — and holds it until every request is in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.publishArtifact.mockImplementation(async () => {
      const slot = await withArtifactCopySlot(() => gate);
      return slot.ok ? { ok: true } : { ok: false, error: "busy" };
    });

    const results = Array.from({ length: MAX_CONCURRENT_ARTIFACT_COPIES }, () =>
      post(chunked({ path: "artifacts/chart.png" })),
    );
    await vi.waitFor(() =>
      expect(mocks.publishArtifact).toHaveBeenCalledTimes(
        MAX_CONCURRENT_ARTIFACT_COPIES,
      ),
    );
    release();

    for (const result of await Promise.all(results)) {
      expect(result).toEqual({ ok: true });
    }
  });

  it("publishes supplied bytes inside the slot it read them in", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mocks.publishArtifact.mockImplementation(async () => {
      await gate;
      return { ok: true };
    });

    const inFlight = Array.from({ length: MAX_CONCURRENT_ARTIFACT_COPIES }, () =>
      post(chunked({ path: "artifacts/a.bin", kind: "file", contentBase64: "aGk=" })),
    );
    await vi.waitFor(() =>
      expect(mocks.publishArtifact).toHaveBeenCalledTimes(
        MAX_CONCURRENT_ARTIFACT_COPIES,
      ),
    );
    // Every slot is taken by a buffered payload, so one more large request is refused as busy.
    expect(await post(chunked({ path: "artifacts/b.bin", contentBase64: "aGk=" }))).toMatchObject({
      ok: false,
    });
    release();
    await Promise.all(inFlight);
  });
});
