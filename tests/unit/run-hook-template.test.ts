/**
 * The generated run-reporting hook (WS2). The template is a source STRING baked into EVERY agent
 * image, importing only `eve/hooks`. We evaluate it under the env contract — stubbing
 * `defineHook` (returns the config) and injecting `process`/`fetch`/`AbortSignal` — to prove the
 * things that would only otherwise fail in production:
 *
 *  - it NEVER throws out of a handler. eve's `dispatchStreamEventHooks` lets hook errors
 *    propagate and the harness turns them into the recoverable `turn.failed` cascade, so a hook
 *    that throws breaks the agent it is observing. (Channel adapter handlers swallow — hooks are
 *    the opposite, which is exactly the trap.)
 *  - it no-ops when unconfigured, so a harnesst-built image still runs anywhere;
 *  - a flush carries the WHOLE turn, because the control plane replaces a run's steps wholesale
 *    and a tail-only batch would truncate an already-recorded transcript;
 *  - the buffer is bounded and is dropped when the turn settles.
 */
import { describe, expect, it, vi } from "vitest";

import {
  HARNESST_RUN_HOOK_PATH,
  HARNESST_RUN_HOOK_SOURCE,
} from "~/observability/run-hook-template";

interface HookConfig {
  events: Record<
    string,
    (event: unknown, ctx: unknown) => void | Promise<void>
  >;
}

interface Harness {
  hook: HookConfig;
  posts: { url: string; init: RequestInit; body: Record<string, unknown> }[];
  /** Resolve after the hook's fire-and-forget POST chain has drained. */
  settle: () => Promise<void>;
}

/**
 * Evaluate the template with a given env and fetch. The source is plain JS in a `.ts` file (the
 * same convention as the ask-teammate tool), so stripping the import line and turning the default
 * export into a return is all it takes to run it.
 */
function evalHook(
  env: Record<string, string>,
  fetchImpl: (url: string, init: RequestInit) => Promise<unknown>,
): Harness {
  const posts: Harness["posts"] = [];
  const body = HARNESST_RUN_HOOK_SOURCE.replace(/^import .*$/gm, "").replace(
    "export default defineHook(",
    "return defineHook(",
  );
  const wrappedFetch = async (url: string, init: RequestInit) => {
    posts.push({
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return fetchImpl(url, init);
  };
  const factory = new Function(
    "defineHook",
    "process",
    "fetch",
    "AbortSignal",
    body,
  );
  const hook = factory(
    (config: HookConfig) => config,
    { env },
    wrappedFetch,
    { timeout: () => undefined },
  ) as HookConfig;
  return {
    hook,
    posts,
    // Two microtask drains: the handler chains `.then(post)`, and post itself chains `.then`.
    settle: async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    },
  };
}

const ENV = {
  HARNESST_RUNS_URL: "http://cp/api/agent/runs",
  HARNESST_TEAM_TOKEN: "ednt_dep1.sig",
};

function ctx(over: Record<string, unknown> = {}) {
  return {
    session: { id: "wrun_1", turn: { id: "turn_0", sequence: 0 } },
    agent: { name: "deputy" },
    channel: { kind: "channel:github" },
    ...over,
  };
}

function evt(type: string, data: Record<string, unknown> = {}) {
  return { type, data, meta: { at: "2026-07-27T00:00:00.000Z" } };
}

const okFetch = async () => ({ text: async () => "" });

describe("harnesst-runs hook template", () => {
  it("imports only eve/hooks and lands at agent/hooks/harnesst-runs.ts", () => {
    const imports = [
      ...HARNESST_RUN_HOOK_SOURCE.matchAll(/^import .* from "([^"]+)";/gm),
    ].map((m) => m[1]);
    expect(imports).toEqual(["eve/hooks"]);
    expect(HARNESST_RUN_HOOK_PATH).toBe("agent/hooks/harnesst-runs.ts");
    // Hook slugs must match eve's HOOK_SLUG_PATTERN (letters/digits/underscore/dash).
    expect(HARNESST_RUN_HOOK_PATH.split("/").pop()!.replace(/\.ts$/, "")).toMatch(
      /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/,
    );
  });

  it("opts out of typechecking — an injected file must not fail a user's publish check", () => {
    // The hook is baked into EVERY agent image, including the publish-check build, and a repo's
    // build script may run `tsc`. Untyped handler params would otherwise break unrelated agents.
    expect(HARNESST_RUN_HOOK_SOURCE.startsWith("// @ts-nocheck")).toBe(true);
  });

  it("contains no `throw` in executable code — a thrown hook fails the turn it observes", () => {
    const code = HARNESST_RUN_HOOK_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    expect(code).not.toMatch(/\bthrow\b/);
  });

  it("registers exactly one wildcard handler, and its body is wrapped in try/catch", () => {
    const { hook } = evalHook(ENV, okFetch);
    expect(Object.keys(hook.events)).toEqual(["*"]);
    // The handler opens with try and the catch swallows (no rethrow anywhere in the file).
    expect(HARNESST_RUN_HOOK_SOURCE).toMatch(/"\*": \(event, ctx\) => \{\s*try \{/);
  });

  it("evaluates and no-ops with every env var unset", async () => {
    const { hook, posts } = evalHook({}, okFetch);
    await hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    await hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx());
    expect(posts).toHaveLength(0);
  });

  it("posts the running turn on turn.started with the delegation bearer", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](
      evt("session.started", { runtime: { modelId: "anthropic/x" } }),
      ctx(),
    );
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    await h.settle();

    expect(h.posts).toHaveLength(1);
    const [post] = h.posts;
    expect(post.url).toBe("http://cp/api/agent/runs");
    expect(
      (post.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer ednt_dep1.sig");
    expect(post.body.sessionId).toBe("wrun_1");
    expect(post.body.turnId).toBe("turn_0");
    expect(post.body.channelKind).toBe("channel:github");
    expect(post.body.modelId).toBe("anthropic/x");
    expect(post.body.agentName).toBe("deputy");
    expect(post.body.final).toBe(false);
    // session.started is in the buffer too — flushes carry the WHOLE turn, not a tail.
    expect((post.body.events as { type: string }[]).map((e) => e.type)).toEqual([
      "session.started",
      "turn.started",
    ]);
  });

  it("stamps turnId onto session-scoped events so the control-plane fold can group them", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    // session.waiting carries neither turnId nor, in some builds, a meta timestamp.
    await h.hook.events["*"]({ type: "session.waiting", data: {} }, ctx());
    await h.settle();

    const last = h.posts[h.posts.length - 1];
    const events = last.body.events as { type: string; data: { turnId: string }; meta: { at: string } }[];
    const waiting = events.find((e) => e.type === "session.waiting")!;
    expect(waiting.data.turnId).toBe("turn_0");
    expect(typeof waiting.meta.at).toBe("string");
  });

  it("flushes final:true on turn.completed and forgets the buffer", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    await h.hook.events["*"](evt("message.completed", { turnId: "turn_0", message: "hi" }), ctx());
    await h.hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx());
    await h.settle();

    const last = h.posts[h.posts.length - 1];
    expect(last.body.final).toBe(true);
    expect((last.body.events as unknown[]).length).toBe(3);

    // A stray later event for the same turn starts a FRESH buffer — proof the old one is gone.
    await h.hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx());
    await h.settle();
    expect((h.posts[h.posts.length - 1].body.events as unknown[]).length).toBe(1);
  });

  it("keeps the model id across turns of the same session", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](
      evt("session.started", { runtime: { modelId: "anthropic/x" } }),
      ctx(),
    );
    await h.hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx());
    const second = ctx({ session: { id: "wrun_1", turn: { id: "turn_1", sequence: 1 } } });
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_1" }), second);
    await h.settle();

    const last = h.posts[h.posts.length - 1];
    expect(last.body.turnId).toBe("turn_1");
    // session.started fires only once per session — losing it would leave turn 2 model-less.
    expect(last.body.modelId).toBe("anthropic/x");
  });

  it("does not leak buffers across turns of one session", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    const second = ctx({ session: { id: "wrun_1", turn: { id: "turn_1", sequence: 1 } } });
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_1" }), second);
    await h.settle();

    const last = h.posts[h.posts.length - 1];
    expect(last.body.turnId).toBe("turn_1");
    expect((last.body.events as { type: string }[]).map((e) => e.type)).toEqual([
      "turn.started",
    ]);
  });

  it("caps the buffer and marks it truncated, keeping the head and the outcome", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    for (let i = 0; i < 2_400; i += 1) {
      await h.hook.events["*"](
        evt("step.started", { turnId: "turn_0", sequence: i }),
        ctx(),
      );
    }
    await h.hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx());
    await h.settle();

    const last = h.posts[h.posts.length - 1];
    const events = last.body.events as { type: string }[];
    expect(last.body.truncated).toBe(true);
    expect(events.length).toBeLessThanOrEqual(2_000);
    expect(events[0].type).toBe("turn.started");
    expect(events[events.length - 1].type).toBe("turn.completed");
  });

  it("swallows a rejected fetch instead of failing the turn", async () => {
    const boom = vi.fn(async () => {
      throw new Error("control plane down");
    });
    const h = evalHook(ENV, boom);
    // The handler is synchronous by design: it never awaits its own POST, so a slow or dead
    // control plane adds zero latency to the turn.
    expect(() =>
      h.hook.events["*"](evt("turn.completed", { turnId: "turn_0" }), ctx()),
    ).not.toThrow();
    await h.settle();
    expect(boom).toHaveBeenCalled();
  });

  it("swallows a garbage context instead of failing the turn", async () => {
    const h = evalHook(ENV, okFetch);
    for (const bad of [undefined, null, {}, { session: {} }, { session: { id: 1 } }]) {
      expect(() => h.hook.events["*"](evt("turn.completed"), bad)).not.toThrow();
    }
    await h.settle();
    expect(h.posts).toHaveLength(0);
  });

  it("only flushes on turn boundaries, not on every event", async () => {
    const h = evalHook(ENV, okFetch);
    for (const type of [
      "step.started",
      "actions.requested",
      "action.result",
      "message.completed",
      "step.completed",
      "reasoning.completed",
    ]) {
      await h.hook.events["*"](evt(type, { turnId: "turn_0" }), ctx());
    }
    await h.settle();
    expect(h.posts).toHaveLength(0);
  });

  it("reports a parked question (input.requested) without ending the turn", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](
      evt("input.requested", { turnId: "turn_0", requests: [{ requestId: "r1", prompt: "?" }] }),
      ctx(),
    );
    await h.settle();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].body.final).toBe(false);
  });

  it("declares the channel kind in a header so the control plane can refuse before the body", async () => {
    const h = evalHook(ENV, okFetch);
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_0" }), ctx());
    await h.settle();

    expect(
      (h.posts[0].init.headers as Record<string, string>)["x-harnesst-channel-kind"],
    ).toBe("channel:github");
  });

  it("never reports an http-homed turn, in either spelling", async () => {
    // Playground, assistant and teammate turns are recorded in-process and `ingestPushedTurn`
    // discards them unconditionally. Reporting them meant uploading each transcript several
    // times over (a flush resends the whole buffer, and there are seven flush events) purely to
    // be parsed and thrown away.
    for (const kind of ["http", "channel:http", " http ", "channel: http "]) {
      const h = evalHook(ENV, okFetch);
      await h.hook.events["*"](
        evt("turn.started", { turnId: "turn_0" }),
        ctx({ channel: { kind } }),
      );
      await h.hook.events["*"](
        evt("turn.completed", { turnId: "turn_0" }),
        ctx({ channel: { kind } }),
      );
      await h.settle();
      expect(h.posts, `kind=${JSON.stringify(kind)}`).toEqual([]);
    }
  });

  it("still reports a kind it does not recognise, and one it cannot see at all", async () => {
    // The hook is baked into images that outlive a control-plane deploy, so classification stays
    // on the control-plane side: only the one kind it is certain gets discarded is dropped here.
    // Case included: the hook's test is character-for-character the control plane's
    // `channelForTrigger`, which is also case-sensitive. Diverging here would mean the two ends
    // disagree about what a run is.
    for (const channel of [
      { kind: "channel:slack" },
      { kind: "HTTP" },
      { kind: "" },
      undefined,
    ]) {
      const h = evalHook(ENV, okFetch);
      await h.hook.events["*"](
        evt("turn.started", { turnId: "turn_0" }),
        ctx({ channel }),
      );
      await h.settle();
      expect(h.posts, `channel=${JSON.stringify(channel)}`).toHaveLength(1);
    }
  });

  it("does not even BUFFER a discarded turn", async () => {
    // Dropping at the POST would still have every http turn's transcript accumulating in the
    // container's memory for the life of the process.
    const h = evalHook(ENV, okFetch);
    const httpCtx = ctx({ channel: { kind: "http" } });
    for (let i = 0; i < 50; i += 1) {
      await h.hook.events["*"](evt("message.part", { turnId: "turn_0", text: "x" }), httpCtx);
    }
    // A GitHub turn in the same process still reports its own events, and only its own.
    await h.hook.events["*"](evt("turn.started", { turnId: "turn_1" }), ctx({
      session: { id: "wrun_1", turn: { id: "turn_1", sequence: 1 } },
    }));
    await h.settle();

    expect(h.posts).toHaveLength(1);
    expect((h.posts[0].body.events as { type: string }[]).map((e) => e.type)).toEqual([
      "turn.started",
    ]);
  });
});
