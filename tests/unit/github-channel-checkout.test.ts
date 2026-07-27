/**
 * WS1 + WS3 — the shipped GitHub channel template, compiled and driven.
 *
 * WS3 — the silent checkout failure.
 *
 * eve's built-in GitHub `turn.started` checks the repository out by brokering the installation
 * token at the sandbox firewall (`sandbox.setNetworkPolicy`). The Docker sandbox backend — the one
 * harnesst deliberately forces by mounting the host docker socket — supports only `"allow-all"`
 * and `"deny-all"`, so that first await throws, eve catches it, and the turn proceeds with an
 * EMPTY workspace. A production run on 2026-07-26/27 answered three turns of a real issue that
 * way, and no surface anywhere said so.
 *
 * The fix lives in the channel template's `turn.started` override, which is a catalog file — not
 * typechecked by the control plane and not importable from here (it imports `eve`, which is not a
 * harnesst dependency). So this suite compiles the real template with esbuild and runs it against
 * stubs, which is the only way to pin behaviour that would otherwise only fail in production:
 *
 *  - the eyes reaction the override REPLACES is re-asserted;
 *  - the checkout actually happens, tokenized rather than brokered, and lands on channel state;
 *  - the installation token never reaches a sandbox command line, and the file that carries it is
 *    deleted;
 *  - `setNetworkPolicy` is never called (calling it is the original bug);
 *  - a failure is announced on the thread instead of swallowed, with credentials redacted;
 *  - and a failure — of the checkout, of the post, of anything — never takes the turn down.
 *
 * WS1 — the park and the answer route. These two halves are the ONLY way a mid-turn question on a
 * GitHub issue reaches Front of House and the human's answer gets back into the SAME eve session:
 * eve's built-in `POST /eve/v1/session/:id` cannot resolve a channel-homed continuation token at
 * all. Both halves live in this same untypechecked catalog file, so the same esbuild harness
 * drives them directly:
 *
 *  - `input.requested` posts the question on the thread AND files the exact park payload harnesst
 *    parses (namespaced token, channel state, one entry per request);
 *  - a park that fails — unset, non-2xx, or throwing — never takes the turn down;
 *  - the answer route refuses an absent, wrong-length or wrong bearer, and refuses outright when
 *    the container was built with no token to compare against;
 *  - it calls this channel's own `send` with `{auth: null, continuationToken, state}`;
 *  - it refuses an answer that names no pending request (eve's `send()` would silently `run()` a
 *    brand-new session and comment on the issue named in the caller's `state`);
 *  - and it separates "this token names no live session" (409) from "the send blew up" (500), the
 *    distinction `app/agent/talk.server.ts` turns into two very different sentences.
 *
 * The eve stubs below are hand-written — `eve` is not a dependency of this repo and the template
 * is excluded from tsconfig, so NOTHING typechecks it (see docs/SPIKE-GITHUB-TO-FOH.md §6 "Known
 * gaps"). They are typed here against eve 0.22.6's documented shapes so a signature drift at
 * least shows up as a compile error in this file.
 */
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createSign, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { transformSync } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const TEMPLATE_PATH = join(
  process.cwd(),
  "catalog/templates/channels/github/files/channels/github.ts",
);

let privateKeyPem = "";

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  }).privateKey;
});

interface SandboxCall {
  command: string;
}

/**
 * eve 0.22.6 surfaces the template actually touches, transcribed as closely as the published
 * typings allow from here. `send` is the channel-bound one an `HttpRouteDefinition` handler is
 * given: the input carries `inputResponses` (and an optional `message`), and the options carry
 * `auth`, the RAW continuation token and the channel state.
 */
interface EveInputResponse {
  requestId: string;
  optionId?: string;
  text?: string;
}
interface EveSendInput {
  message?: string;
  inputResponses?: EveInputResponse[];
}
interface EveSendOptions {
  auth: unknown;
  continuationToken: string;
  state: unknown;
}
type EveSend = (
  input: EveSendInput,
  options: EveSendOptions,
) => Promise<{ id: string }>;
interface EveRouteDefinition {
  path: string;
  handler: (request: Request, args: { send: EveSend }) => Promise<Response>;
}
/** One entry of an `input.requested` event, as eve raises it. */
interface EveInputRequest {
  requestId: string;
  prompt: string;
  display?: string;
  allowFreeform?: boolean;
  options?: readonly { id: string; label: string; description?: string }[];
}

interface Harness {
  /** The config object the template handed to `githubChannel()`. */
  config: {
    events: Record<
      string,
      (event: never, channel: never, ctx: never) => Promise<void>
    >;
  };
  /** The template's default export (channel + its extra routes). */
  channelModule: { routes: EveRouteDefinition[] };
  commands: SandboxCall[];
  files: Record<string, string>;
  networkPolicyCalls: unknown[];
  posts: string[];
  reactions: string[];
  errors: string[];
  mintCalls: number;
  state: Record<string, unknown>;
  /** Everything POSTed to the park URL, decoded. */
  parkPosts: { url: string; headers: Record<string, string>; body: unknown }[];
  /** Every `send()` the answer route made. */
  sendCalls: { input: EveSendInput; options: EveSendOptions }[];
  turnStarted: () => Promise<void>;
  inputRequested: (requests: EveInputRequest[]) => Promise<void>;
  /** Drive the channel-registered answer route. */
  answer: (init: { bearer?: string | null; body?: unknown }) => Promise<Response>;
}

interface Options {
  /** exitCode/stdout/stderr for a command, keyed by a substring match. */
  run?: (
    command: string,
  ) => { exitCode?: number; stderr?: string; stdout?: string } | undefined;
  state?: Record<string, unknown>;
  /** Response for `GET /repos/:owner/:repo`. */
  defaultBranch?: string;
  postThrows?: boolean;
  reactThrows?: boolean;
  getSandboxThrows?: boolean;
  env?: Record<string, string>;
  /** Status the park endpoint answers with (default 200). `"throw"` = network failure. */
  park?: number | "throw";
  /** What the channel's own `send` does. Default: resolves with a session. */
  send?: () => Promise<{ id: string }>;
}

const PARK_URL = "https://harnesst.test/api/foh/park";

const TOKEN = "ghs_0000000000000000000000000000000000000A";

function initialState(): Record<string, unknown> {
  return {
    baseRef: null,
    baseSha: null,
    checkoutPath: null,
    conversationKind: "issue",
    defaultBranch: null,
    headRef: null,
    headSha: null,
    installationId: 4242,
    issueNumber: 7,
    owner: "acme",
    pullRequestNumber: null,
    repo: "widgets",
    repositoryId: 1,
    reviewCommentId: null,
    reviewThreadRootCommentId: null,
    triggeringCommentId: 99,
    triggeringUserLogin: "octocat",
  };
}

/**
 * Compile the shipped template to CommonJS and evaluate it with `eve` stubbed out. The template
 * is real TypeScript (it ships to customer repos), so esbuild does the type stripping that a bare
 * `new Function` could not.
 */
function loadTemplate(options: Options = {}): Harness {
  const source = readFileSync(TEMPLATE_PATH, "utf8");
  const compiled = transformSync(source, {
    format: "cjs",
    loader: "ts",
    target: "node20",
  }).code;

  const commands: SandboxCall[] = [];
  const files: Record<string, string> = {};
  const networkPolicyCalls: unknown[] = [];
  const posts: string[] = [];
  const reactions: string[] = [];
  const errors: string[] = [];
  const parkPosts: Harness["parkPosts"] = [];
  const sendCalls: Harness["sendCalls"] = [];
  let mintCalls = 0;

  const state = { ...initialState(), ...(options.state ?? {}) };

  const sandbox = {
    id: "sbx",
    resolvePath: (path: string) => path,
    async run({ command }: { command: string }) {
      commands.push({ command });
      const override = options.run?.(command);
      return {
        exitCode: override?.exitCode ?? 0,
        stderr: override?.stderr ?? "",
        stdout: override?.stdout ?? "",
      };
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      files[path] = content;
    },
    async setNetworkPolicy(policy: unknown) {
      networkPolicyCalls.push(policy);
    },
  };

  const channel = {
    state,
    continuationToken: "github:acme/widgets#7",
    github: {
      async request() {
        return {
          body: { default_branch: options.defaultBranch ?? "main" },
          ok: true,
          status: 200,
        };
      },
    },
    thread: {
      async post(message: string) {
        if (options.postThrows) throw new Error("github said no");
        posts.push(message);
        return { htmlUrl: undefined, id: 1, raw: null, url: undefined };
      },
      async react(content: string) {
        if (options.reactThrows) throw new Error("github said no");
        reactions.push(content);
      },
    },
  };

  const ctx = {
    session: { id: "sess_1" },
    async getSandbox() {
      if (options.getSandboxThrows) {
        throw new Error("no sandbox is available in this runtime context");
      }
      return sandbox;
    },
  };

  let config: Harness["config"] | undefined;
  const stubs: Record<string, unknown> = {
    "eve/channels": {
      POST: (
        path: string,
        handler: EveRouteDefinition["handler"],
      ): EveRouteDefinition => ({ path, handler }),
    },
    "eve/channels/github": {
      githubChannel: (given: Harness["config"]) => {
        config = given;
        return { adapter: {}, routes: [] };
      },
    },
    "node:crypto": { createSign, randomUUID, timingSafeEqual },
  };

  const fakeProcess = {
    env: {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      HARNESST_TEAM_TOKEN: "tok",
      HARNESST_FOH_PARK_URL: PARK_URL,
      ...(options.env ?? {}),
    },
  };

  const fakeFetch = async (url: string, init?: RequestInit) => {
    if (String(url) === PARK_URL) {
      if (options.park === "throw") throw new Error("connect ECONNREFUSED");
      parkPosts.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "null")) as unknown,
      });
      const status = typeof options.park === "number" ? options.park : 200;
      return { ok: status >= 200 && status < 300, status, statusText: "" };
    }
    if (String(url).includes("/access_tokens")) {
      mintCalls += 1;
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            token: TOKEN,
          };
        },
      };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const fakeConsole = {
    error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
    log: () => undefined,
    warn: () => undefined,
  };

  const moduleObject = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string) => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`the template must not import ${specifier}`);
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(
    "require",
    "module",
    "exports",
    "process",
    "fetch",
    "console",
    compiled,
  )(requireStub, moduleObject, moduleObject.exports, fakeProcess, fakeFetch, fakeConsole);

  if (!config) throw new Error("the template never called githubChannel()");

  const channelModule = moduleObject.exports.default as {
    routes: EveRouteDefinition[];
  };

  const send: EveSend = async (input, sendOptions) => {
    sendCalls.push({ input, options: sendOptions });
    return options.send ? await options.send() : { id: "sess_resumed" };
  };

  return {
    config,
    channelModule,
    commands,
    files,
    networkPolicyCalls,
    posts,
    reactions,
    errors,
    get mintCalls() {
      return mintCalls;
    },
    state,
    parkPosts,
    sendCalls,
    turnStarted: () =>
      config!.events["turn.started"]({} as never, channel as never, ctx as never),
    inputRequested: (requests) =>
      config!.events["input.requested"](
        { requests } as never,
        channel as never,
        ctx as never,
      ),
    answer: async ({ bearer = "tok", body = {} }) => {
      const route = channelModule.routes.find(
        (r) => r.path === "/eve/v1/github/harnesst/answer",
      );
      if (!route) throw new Error("the template registered no answer route");
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
      return await route.handler(
        new Request(`https://agent.test${route.path}`, {
          method: "POST",
          headers,
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        { send },
      );
    },
  };
}

/** Fail the git fetch, the way a real credential or permission problem would. */
const failingFetch = (command: string) =>
  command.includes("git fetch")
    ? { exitCode: 128, stderr: "fatal: could not read Username for 'https://github.com'" }
    : undefined;

describe("the GitHub channel template's turn.started override", () => {
  it("installs a turn.started handler at all (eve's built-in cannot work here)", () => {
    const harness = loadTemplate();
    expect(typeof harness.config.events["turn.started"]).toBe("function");
    // and it must not have displaced the WS1 work in the same file
    expect(typeof harness.config.events["input.requested"]).toBe("function");
    expect(harness.channelModule.routes).toHaveLength(1);
  });

  it("re-asserts the eyes reaction the override replaces", async () => {
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "a".repeat(40) } : undefined),
    });
    await harness.turnStarted();
    expect(harness.reactions).toContain("eyes");
  });

  it("checks the repository out and records it on channel state", async () => {
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    expect(harness.posts).toEqual([]);
    expect(harness.mintCalls).toBe(1);
    expect(harness.state.checkoutPath).toBe("/workspace");
    expect(harness.state.headSha).toBe("b".repeat(40));
    const joined = harness.commands.map((c) => c.command).join("\n");
    expect(joined).toContain("git init -q");
    expect(joined).toContain("git remote add origin 'https://github.com/acme/widgets.git'");
    expect(joined).toContain("git fetch --depth 1 origin 'main'");
    expect(joined).toContain("git checkout --detach 'FETCH_HEAD'");
  });

  it("never calls setNetworkPolicy — that call is the original bug", async () => {
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();
    expect(harness.networkPolicyCalls).toEqual([]);
  });

  it("keeps the installation token out of every sandbox command, and deletes the file holding it", async () => {
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    for (const { command } of harness.commands) {
      expect(command).not.toContain(TOKEN);
      // the base64 basic-auth form must not leak either
      expect(command).not.toContain(
        Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
      );
    }

    const [configPath, ...rest] = Object.keys(harness.files);
    expect(rest).toEqual([]);
    expect(configPath).toMatch(/^\/tmp\/\.harnesst-git-/u);
    expect(harness.files[configPath]).toContain('[http "https://github.com/"]');
    expect(harness.files[configPath]).toContain(
      Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
    );
    expect(harness.commands.map((c) => c.command)).toContain(`rm -f '${configPath}'`);
  });

  it("does not re-fetch or mint a token when the workspace is already at the target commit", async () => {
    const sha = "c".repeat(40);
    const harness = loadTemplate({
      state: { headSha: sha },
      run: (command) => (command.includes("rev-parse") ? { stdout: sha } : undefined),
    });
    await harness.turnStarted();

    expect(harness.mintCalls).toBe(0);
    expect(harness.commands.map((c) => c.command).join("\n")).not.toContain("git fetch");
    expect(harness.state.checkoutPath).toBe("/workspace");
    expect(harness.state.headSha).toBe(sha);
  });

  it("fetches a pull request head ref and, best effort, its base", async () => {
    const harness = loadTemplate({
      state: { pullRequestNumber: 31, baseRef: "main", baseSha: "d".repeat(40) },
      run: (command) => (command.includes("rev-parse") ? { stdout: "e".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    const joined = harness.commands.map((c) => c.command).join("\n");
    expect(joined).toContain("git fetch --depth 1 origin 'refs/pull/31/head'");
    expect(joined).toContain(`git fetch --depth 1 origin '${"d".repeat(40)}'`);
    expect(harness.state.checkoutPath).toBe("/workspace");
  });

  it("says so on the thread when the checkout fails, instead of swallowing it", async () => {
    const harness = loadTemplate({ run: failingFetch });
    await harness.turnStarted();

    expect(harness.state.checkoutPath).toBeNull();
    expect(harness.reactions).toContain("confused");
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toContain("could not check out `acme/widgets`");
    expect(harness.posts[0]).toContain("without the repository in front of me");
    expect(harness.posts[0]).toContain("could not read Username");
    expect(harness.errors.join("\n")).toContain("github checkout failed for acme/widgets");
  });

  it("reports a missing sandbox as a failed checkout rather than a crashed turn", async () => {
    const harness = loadTemplate({ getSandboxThrows: true });
    await expect(harness.turnStarted()).resolves.toBeUndefined();
    expect(harness.posts[0]).toContain("could not check out");
    expect(harness.state.checkoutPath).toBeNull();
  });

  it("redacts anything token-shaped before echoing a failure onto a public thread", async () => {
    const leaked = "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const harness = loadTemplate({
      run: (command) =>
        command.includes("git fetch")
          ? { exitCode: 128, stderr: `fatal: bad credentials using ${leaked} for github.com` }
          : undefined,
    });
    await harness.turnStarted();

    expect(harness.posts[0]).not.toContain(leaked);
    expect(harness.posts[0]).toContain("[redacted]");
  });

  it("still resolves when even the failure comment cannot be posted", async () => {
    const harness = loadTemplate({ run: failingFetch, postThrows: true, reactThrows: true });
    await expect(harness.turnStarted()).resolves.toBeUndefined();
    expect(harness.errors.join("\n")).toContain("github checkout failed for acme/widgets");
  });

  it("fails loudly rather than silently when the App credentials are missing", async () => {
    const harness = loadTemplate({ env: { GITHUB_APP_PRIVATE_KEY: "" } });
    await harness.turnStarted();
    expect(harness.posts[0]).toContain("GITHUB_APP_PRIVATE_KEY is not set");
    expect(harness.state.checkoutPath).toBeNull();
  });
});

const REQUESTS: EveInputRequest[] = [
  {
    requestId: "req_1",
    prompt: "Which branch should I target?",
    options: [
      { id: "main", label: "main", description: "the default" },
      { id: "develop", label: "develop" },
    ],
    allowFreeform: true,
  },
  { requestId: "req_2", prompt: "Squash the commits?" },
];

describe("the template's input.requested handler (the park)", () => {
  it("posts the question on the thread, options and all", async () => {
    const harness = loadTemplate();
    await harness.inputRequested(REQUESTS);

    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toContain("I need input before I can continue");
    expect(harness.posts[0]).toContain("Which branch should I target?");
    expect(harness.posts[0]).toContain("- **main** — the default");
    expect(harness.posts[0]).toContain("- **develop**");
    expect(harness.posts[0]).toContain("Squash the commits?");
  });

  it("files the exact payload harnesst's park route parses", async () => {
    const harness = loadTemplate();
    await harness.inputRequested(REQUESTS);

    expect(harness.parkPosts).toHaveLength(1);
    const [park] = harness.parkPosts;
    expect(park.headers.authorization).toBe("Bearer tok");
    expect(park.body).toEqual({
      channel: "github",
      routePath: "/eve/v1/github/harnesst/answer",
      eveSessionId: "sess_1",
      // NAMESPACED, exactly as eve reports it. harnesst strips `github:` before handing it back,
      // because eve's `send()` re-prefixes the channel name — sending the stripped form here
      // would make harnesst store a token that resolves to nothing.
      continuationToken: "github:acme/widgets#7",
      state: harness.state,
      title: "acme/widgets#7",
      requests: [
        {
          requestId: "req_1",
          prompt: "Which branch should I target?",
          display: null,
          allowFreeform: true,
          options: [
            { id: "main", label: "main", description: "the default" },
            { id: "develop", label: "develop" },
          ],
        },
        {
          requestId: "req_2",
          prompt: "Squash the commits?",
          display: null,
          allowFreeform: null,
          options: [],
        },
      ],
    });
  });

  it("titles a repo-level conversation without an issue number", async () => {
    const harness = loadTemplate({ state: { issueNumber: null } });
    await harness.inputRequested(REQUESTS);
    expect((harness.parkPosts[0].body as { title: string }).title).toBe("acme/widgets");
  });

  it("does not park when harnesst never wired one up", async () => {
    const harness = loadTemplate({ env: { HARNESST_FOH_PARK_URL: "" } });
    await harness.inputRequested(REQUESTS);
    // The question is still on the issue — a self-hosted eve just has nowhere to file it.
    expect(harness.posts).toHaveLength(1);
    expect(harness.parkPosts).toEqual([]);
  });

  it("does not park without a token — an unauthenticated park is refused anyway", async () => {
    const harness = loadTemplate({ env: { HARNESST_TEAM_TOKEN: "" } });
    await harness.inputRequested(REQUESTS);
    expect(harness.parkPosts).toEqual([]);
  });

  it("survives a park that answers non-2xx", async () => {
    const harness = loadTemplate({ park: 503 });
    await expect(harness.inputRequested(REQUESTS)).resolves.toBeUndefined();
    expect(harness.errors.join("\n")).toContain("park returned 503");
  });

  it("survives a park that never connects", async () => {
    const harness = loadTemplate({ park: "throw" });
    await expect(harness.inputRequested(REQUESTS)).resolves.toBeUndefined();
    expect(harness.errors.join("\n")).toContain("park failed");
  });

  it("still parks when the thread comment cannot be posted", async () => {
    // The park is the half that gets a human involved; losing the comment must not lose it.
    const harness = loadTemplate({ postThrows: true });
    await harness.inputRequested(REQUESTS);
    expect(harness.parkPosts).toHaveLength(1);
    expect(harness.errors.join("\n")).toContain("posting the question to GitHub failed");
  });
});

describe("the template's answer route (the resume)", () => {
  const VALID = {
    continuationToken: "acme/widgets#7",
    state: initialState(),
    message: "main",
    inputResponses: [{ requestId: "req_1", optionId: "main" }],
  };

  it("is registered on the channel, so the resume runs through this channel's send", () => {
    const harness = loadTemplate();
    expect(harness.channelModule.routes.map((r) => r.path)).toEqual([
      "/eve/v1/github/harnesst/answer",
    ]);
  });

  it("resumes the session with auth:null, the raw token and the round-tripped state", async () => {
    const harness = loadTemplate();
    const res = await harness.answer({ body: VALID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: "sess_resumed" });
    expect(harness.sendCalls).toHaveLength(1);
    expect(harness.sendCalls[0].input).toEqual({
      inputResponses: [{ requestId: "req_1", optionId: "main" }],
      message: "main",
    });
    expect(harness.sendCalls[0].options).toEqual({
      auth: null,
      continuationToken: "acme/widgets#7",
      state: VALID.state,
    });
  });

  it("omits `message` when the human only picked an option", async () => {
    const harness = loadTemplate();
    await harness.answer({ body: { ...VALID, message: "" } });
    expect(harness.sendCalls[0].input).not.toHaveProperty("message");
  });

  it("refuses an unauthenticated call", async () => {
    const harness = loadTemplate();
    const res = await harness.answer({ bearer: null, body: VALID });
    expect(res.status).toBe(401);
    expect(harness.sendCalls).toEqual([]);
  });

  it("refuses a wrong bearer, and one that merely differs in length", async () => {
    const harness = loadTemplate();
    expect((await harness.answer({ bearer: "nope", body: VALID })).status).toBe(401);
    expect((await harness.answer({ bearer: "tokk", body: VALID })).status).toBe(401);
    expect((await harness.answer({ bearer: "to", body: VALID })).status).toBe(401);
    expect(harness.sendCalls).toEqual([]);
  });

  it("refuses everything when the container was built with no token to compare against", async () => {
    // Falling open here would let anyone on the public ingress inject inputResponses into a live
    // agent session.
    const harness = loadTemplate({ env: { HARNESST_TEAM_TOKEN: "" } });
    expect((await harness.answer({ bearer: null, body: VALID })).status).toBe(401);
    expect((await harness.answer({ bearer: "", body: VALID })).status).toBe(401);
    expect(harness.sendCalls).toEqual([]);
  });

  it("rejects a malformed body, a missing token and a missing state", async () => {
    const harness = loadTemplate();
    expect((await harness.answer({ body: "{not json" })).status).toBe(400);
    expect(
      (await harness.answer({ body: { ...VALID, continuationToken: "" } })).status,
    ).toBe(400);
    expect((await harness.answer({ body: { ...VALID, state: undefined } })).status).toBe(
      400,
    );
    expect(harness.sendCalls).toEqual([]);
  });

  it("refuses an answer that names no pending request", async () => {
    // eve's `send()` throws on a failed deliver ONLY when inputResponses is non-empty; with an
    // empty array it falls back to `run()` and starts a NEW session from the supplied state —
    // here, a fresh comment on whatever issue the caller named.
    const harness = loadTemplate();
    const res = await harness.answer({ body: { ...VALID, inputResponses: [] } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("at least one pending request");
    expect(harness.sendCalls).toEqual([]);

    const missing = await harness.answer({
      body: { ...VALID, inputResponses: undefined },
    });
    expect(missing.status).toBe(400);
    expect(harness.sendCalls).toEqual([]);
  });

  it("reports a spent continuation token as 409 session_gone", async () => {
    const harness = loadTemplate({
      send: () => {
        throw new Error(
          "Cannot deliver inputResponses — the target session was not found via continuation token",
        );
      },
    });
    const res = await harness.answer({ body: VALID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "session_gone" });
  });

  it("reports any OTHER send failure as 500 send_failed, carrying its own message", async () => {
    // Conflating this with a dead session made harnesst tell the human "the agent was redeployed"
    // for a GitHub outage, which sent people looking in entirely the wrong place.
    const harness = loadTemplate({
      send: () => {
        throw new Error("github responded 502 while posting the reply");
      },
    });
    const res = await harness.answer({ body: VALID });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "send_failed",
      error: "github responded 502 while posting the reply",
    });
  });

  it("redacts anything token-shaped out of a failure it hands back", async () => {
    const harness = loadTemplate({
      send: () => {
        throw new Error(`bad credentials using ${TOKEN} for github.com`);
      },
    });
    const res = await harness.answer({ body: VALID });
    const payload = (await res.json()) as { error: string };
    expect(payload.error).not.toContain(TOKEN);
    expect(payload.error).toContain("[redacted]");
  });
});
