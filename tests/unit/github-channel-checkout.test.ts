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
 * #254 — the wake rules. `onIssue`/`onPullRequest` are the only way an agent hears anything but an
 * @mention, and the predicate behind them is exported pure precisely so it can be driven here:
 * self-suppression, the label allowlist, repo scoping, and — the one that decides whether taking
 * this update is safe — an unconfigured install staying inert.
 *
 * The file under test moved in #254 from `files/channels/github.ts` to
 * `files/harnesst/github-channel.ts`: the body is platform-owned and rewritten by every update,
 * while the customer's `agent/channels/github.ts` is a three-line wrapper written once and never
 * again. This suite compiles the platform file and calls the factory the wrapper calls.
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
  "catalog/templates/channels/github/files/harnesst/github-channel.ts",
);
/** The customer-owned wrapper. Its only job is to call the factory the platform file exports. */
const WRAPPER_PATH = join(
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

/** eve's `GitHubInboundResult`: `null` ignores, `{auth}` dispatches. */
type EveInboundResult = { auth: unknown; context?: readonly string[] } | null;
/** The webhook shapes the wake hooks receive, as eve 0.24.2 normalises them. */
interface EveIssueEvent {
  action: string;
  issueNumber: number;
  raw: Record<string, unknown>;
}
interface EvePullRequestEvent {
  action: string;
  headSha: string | null;
  pullRequestNumber: number;
  raw: Record<string, unknown>;
}

interface Harness {
  /** The config object the template handed to `githubChannel()`. */
  config: {
    events: Record<
      string,
      (event: never, channel: never, ctx: never) => Promise<void>
    >;
    onIssue?: (ctx: never, issue: EveIssueEvent) => EveInboundResult;
    onPullRequest?: (ctx: never, pullRequest: EvePullRequestEvent) => EveInboundResult;
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
  /** Drive `onIssue` / `onPullRequest` through the settings the module read from env. */
  issueEvent: (input: {
    action: string;
    label?: string;
    number?: number;
    repo?: string;
    sender?: string;
  }) => EveInboundResult;
  pullRequestEvent: (input: {
    action: string;
    headSha?: string | null;
    label?: string;
    number?: number;
    repo?: string;
    sender?: string;
  }) => EveInboundResult;
  /** The exported pure predicate, for driving the rules without any env at all. */
  wakeContext: (event: WakeEvent, settings: WakeSettings) => string | null;
}

/** Mirrors the two exported interfaces of the platform file (which tsconfig excludes). */
interface WakeSettings {
  repos: readonly string[];
  wakeLabels: readonly string[];
  wakeOnNewIssues: boolean;
  appSlug: string;
}
interface WakeEvent {
  kind: "issue" | "pull_request";
  action: string;
  number: number;
  label: string | null;
  headSha: string | null;
  repoFullName: string;
  senderLogin: string;
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

  // The customer's `agent/channels/github.ts` is a wrapper around this factory, so the suite
  // exercises exactly what a deployed agent's default export evaluates to.
  const factory = moduleObject.exports.harnesstGitHubChannel as
    | (() => { routes: EveRouteDefinition[] })
    | undefined;
  if (typeof factory !== "function") {
    throw new Error("the platform file exports no harnesstGitHubChannel() factory");
  }
  const channelModule = factory();
  if (!config) throw new Error("the factory never called githubChannel()");

  const inboundCtx = (repo: string, sender: string) =>
    ({ repository: { fullName: repo }, sender: { login: sender } }) as never;

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
    issueEvent: ({ action, label, number = 12, repo = "acme/widgets", sender = "octocat" }) => {
      if (!config!.onIssue) throw new Error("the template registered no onIssue hook");
      return config!.onIssue(inboundCtx(repo, sender), {
        action,
        issueNumber: number,
        raw: label === undefined ? {} : { label: { name: label } },
      });
    },
    pullRequestEvent: ({
      action,
      headSha = null,
      label,
      number = 19,
      repo = "acme/widgets",
      sender = "octocat",
    }) => {
      if (!config!.onPullRequest) {
        throw new Error("the template registered no onPullRequest hook");
      }
      return config!.onPullRequest(inboundCtx(repo, sender), {
        action,
        headSha,
        pullRequestNumber: number,
        raw: label === undefined ? {} : { label: { name: label } },
      });
    },
    wakeContext: moduleObject.exports.githubWakeContext as Harness["wakeContext"],
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

  it("keeps the customer's file a wrapper — the split is the whole fix", () => {
    // #254: the update that destroyed two agents' channels overwrote a lock-owned file under
    // `agent/`. `agent/channels/github.ts` is now install-once and holds nothing worth losing;
    // every line that an update rewrites lives in the platform file this suite compiles.
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");
    expect(wrapper).toContain(
      'import { harnesstGitHubChannel } from "../../harnesst/github-channel";',
    );
    expect(wrapper).toContain("export default harnesstGitHubChannel();");
    const lines = wrapper.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(8);
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

/**
 * The dubious-ownership failure, observed in production on 2026-07-27: the sandbox mounts the
 * workspace under a uid git does not run as, so the FIRST git command in it — `git remote add` —
 * exits 128 with `fatal: detected dubious ownership in repository at '/workspace'` and the whole
 * checkout is lost. The turn then answers the issue without the repository, which is exactly the
 * failure mode WS3 exists to prevent, only now announced instead of silent.
 */
describe("github channel template — dubious ownership", () => {
  it("marks the checkout directory safe before it runs any other git command", async () => {
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    const commands = harness.commands.map((c) => c.command);
    const guard = commands.findIndex((c) => c.includes("safe.directory"));
    expect(guard).toBe(0);
    // Before the reuse probe too: an ownership rejection there reads as "not on the target
    // commit", so the channel would re-clone on every single event.
    expect(commands.findIndex((c) => c.includes("rev-parse"))).toBeGreaterThan(guard);
    expect(commands.findIndex((c) => c.includes("git remote add"))).toBeGreaterThan(guard);
  });

  it("only appends the entry when git does not already list it", async () => {
    // The sandbox outlives a single checkout and `git config --add` is not idempotent, so a long
    // session would otherwise accumulate one duplicate line per turn.
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    expect(harness.commands[0]!.command).toBe(
      "git config --global --get-all safe.directory 2>/dev/null | grep -qxF '/workspace' || git config --global --add safe.directory '/workspace'",
    );
  });

  it("repeats the entry in the scoped config the fetch runs under", async () => {
    // `GIT_CONFIG_GLOBAL` REPLACES ~/.gitconfig rather than layering over it, so the fetch and
    // checkout would be blind to the global entry written above.
    const harness = loadTemplate({
      run: (command) => (command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined),
    });
    await harness.turnStarted();

    const [configPath] = Object.keys(harness.files);
    expect(harness.files[configPath!]).toContain("[safe]\n\tdirectory = /workspace");
  });

  it("logs and carries on when the guard itself fails", async () => {
    // A workspace git is already happy with needs none of this, and the scoped config still
    // carries the entry — so a read-only HOME must not cost the agent its checkout.
    const harness = loadTemplate({
      run: (command) => {
        if (command.includes("safe.directory")) {
          return { exitCode: 1, stderr: "error: could not lock config file" };
        }
        return command.includes("rev-parse") ? { stdout: "b".repeat(40) } : undefined;
      },
    });
    await harness.turnStarted();

    expect(harness.state.checkoutPath).toBe("/workspace");
    expect(harness.posts).toEqual([]);
    expect(harness.errors.join("\n")).toContain("safe git directory failed");
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
  it("asks in ONE place — parked, with nothing on the thread", async () => {
    // A person needing an answer asks in the inbox or on the thread, not both. The copy on the
    // issue would be un-answerable anyway: a comment reply starts a NEW turn, while the session
    // that is actually waiting can only be resumed through the answer route.
    const harness = loadTemplate();
    await harness.inputRequested(REQUESTS);

    expect(harness.parkPosts).toHaveLength(1);
    expect(harness.posts).toEqual([]);
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

  it("falls back to the thread when harnesst never wired a park up", async () => {
    // A self-hosted eve has nowhere to file the question, and a question nobody can see is the
    // original bug. The thread is the fallback — never the duplicate.
    const harness = loadTemplate({ env: { HARNESST_FOH_PARK_URL: "" } });
    await harness.inputRequested(REQUESTS);

    expect(harness.parkPosts).toEqual([]);
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toContain("I need input before I can continue");
    expect(harness.posts[0]).toContain("Which branch should I target?");
    expect(harness.posts[0]).toContain("- **main** — the default");
    expect(harness.posts[0]).toContain("- **develop**");
    expect(harness.posts[0]).toContain("Squash the commits?");
  });

  it("falls back to the thread without a token — an unauthenticated park is refused anyway", async () => {
    const harness = loadTemplate({ env: { HARNESST_TEAM_TOKEN: "" } });
    await harness.inputRequested(REQUESTS);

    expect(harness.parkPosts).toEqual([]);
    expect(harness.posts).toHaveLength(1);
  });

  it("falls back to the thread when the park answers non-2xx", async () => {
    const harness = loadTemplate({ park: 503 });
    await expect(harness.inputRequested(REQUESTS)).resolves.toBeUndefined();

    expect(harness.errors.join("\n")).toContain("park returned 503");
    expect(harness.posts).toHaveLength(1);
  });

  it("falls back to the thread when the park never connects", async () => {
    const harness = loadTemplate({ park: "throw" });
    await expect(harness.inputRequested(REQUESTS)).resolves.toBeUndefined();

    expect(harness.errors.join("\n")).toContain("park failed");
    expect(harness.posts).toHaveLength(1);
  });

  it("survives losing both — a failed park AND a thread that refuses the comment", async () => {
    const harness = loadTemplate({ park: "throw", postThrows: true });
    await expect(harness.inputRequested(REQUESTS)).resolves.toBeUndefined();

    expect(harness.errors.join("\n")).toContain("park failed");
    expect(harness.errors.join("\n")).toContain("posting the question to GitHub failed");
  });

  it("does not post to the thread just because a successful park's comment would have failed", async () => {
    // `postThrows` must never be reached on the happy path: no post is attempted at all.
    const harness = loadTemplate({ postThrows: true });
    await harness.inputRequested(REQUESTS);

    expect(harness.parkPosts).toHaveLength(1);
    expect(harness.errors).toEqual([]);
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

/**
 * #254 — the wake rules. Driven twice over: through the exported pure predicate, where every rule
 * can be stated without env or eve, and through the real `onIssue`/`onPullRequest` hooks, which is
 * the only way to prove the `HARNESST_CHANNEL_GITHUB_*` env contract the deploy path emits is the
 * one this file reads. Those two encodings drifting apart breaks the channel silently.
 */
const WAKE: WakeSettings = {
  repos: ["worksauceapp/marketing-site"],
  wakeLabels: ["ready", "changes-requested"],
  wakeOnNewIssues: false,
  appSlug: "ivy-worksauce",
};

function labelEvent(over: Partial<WakeEvent> = {}): WakeEvent {
  return {
    kind: "pull_request",
    action: "labeled",
    number: 19,
    label: "changes-requested",
    headSha: "ee9a696aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repoFullName: "worksauceapp/marketing-site",
    senderLogin: "sam-harnesst",
    ...over,
  };
}

describe("the wake predicate", () => {
  it("names the event and refuses to say what to do about it", () => {
    // The policy lives in the customer's instructions.md. An agent told "you were woken because
    // X, therefore do Y" stops reading its own instructions.
    const { wakeContext } = loadTemplate();
    const context = wakeContext(labelEvent(), WAKE);

    expect(context).toContain(
      'pull request #19 labeled "changes-requested" by @sam-harnesst in worksauceapp/marketing-site',
    );
    expect(context).toContain("Decide from your instructions");
    expect(context).toContain("do nothing and post nothing");
  });

  it("suppresses the agent's OWN app whatever case GitHub minted the login in", () => {
    // GitHub logins are case-preserving, so an exact-case comparison falls open and the agent
    // wakes itself on its own label — an unbounded loop that costs money.
    const { wakeContext } = loadTemplate();
    expect(wakeContext(labelEvent({ senderLogin: "ivy-worksauce[bot]" }), WAKE)).toBeNull();
    expect(wakeContext(labelEvent({ senderLogin: "Ivy-WorkSauce[BOT]" }), WAKE)).toBeNull();
  });

  it("still wakes on ANOTHER agent's bot — it is a sender check, not a bot check", () => {
    // This is what lets two agents hand work back and forth.
    const { wakeContext } = loadTemplate();
    expect(wakeContext(labelEvent({ senderLogin: "sam-worksauce[bot]" }), WAKE)).toContain(
      "@sam-worksauce[bot]",
    );
  });

  it("checks the sender BEFORE anything else can match", () => {
    // Ordering matters: a self-applied label in a watched repo is the exact shape of the loop.
    const { wakeContext } = loadTemplate();
    expect(
      wakeContext(
        labelEvent({ action: "synchronize", label: null, senderLogin: "ivy-worksauce[bot]" }),
        WAKE,
      ),
    ).toBeNull();
  });

  it("dispatches on an allowlisted label and ignores every other one", () => {
    const { wakeContext } = loadTemplate();
    expect(wakeContext(labelEvent({ label: "ready" }), WAKE)).toContain('labeled "ready"');
    expect(wakeContext(labelEvent({ label: "wontfix" }), WAKE)).toBeNull();
    expect(wakeContext(labelEvent({ label: null }), WAKE)).toBeNull();
  });

  it("ignores `unlabeled`, which carries a `label` payload of its own", () => {
    // GitHub sends the removed label on `unlabeled` too, so matching on the label alone would
    // wake the agent when a human took the label OFF.
    const { wakeContext } = loadTemplate();
    expect(wakeContext(labelEvent({ action: "unlabeled" }), WAKE)).toBeNull();
    for (const action of ["closed", "edited", "assigned", "reopened", "opened"]) {
      expect(wakeContext(labelEvent({ action }), WAKE)).toBeNull();
    }
  });

  it("scopes to the configured repositories", () => {
    const { wakeContext } = loadTemplate();
    expect(wakeContext(labelEvent({ repoFullName: "worksauceapp/other" }), WAKE)).toBeNull();
    expect(wakeContext(labelEvent({ repoFullName: "someoneelse/marketing-site" }), WAKE)).toBeNull();
    // GitHub is case-insensitive about owner/repo; an operator typing it differently is not a
    // different repository.
    expect(
      wakeContext(labelEvent({ repoFullName: "WorkSauceApp/Marketing-Site" }), WAKE),
    ).not.toBeNull();
  });

  it("carries the head sha on a synchronize, so the agent knows which commit woke it", () => {
    const { wakeContext } = loadTemplate();
    const context = wakeContext(
      labelEvent({ action: "synchronize", label: null }),
      WAKE,
    );
    expect(context).toContain("updated with new commits");
    expect(context).toContain("head ee9a696");
  });

  it("wakes on a draft becoming reviewable", () => {
    const { wakeContext } = loadTemplate();
    expect(
      wakeContext(labelEvent({ action: "ready_for_review", label: null }), WAKE),
    ).toContain("marked ready for review");
  });

  it("gates opened/reopened issues on wakeOnNewIssues alone", () => {
    const { wakeContext } = loadTemplate();
    const opened = labelEvent({ kind: "issue", action: "opened", label: null, headSha: null });
    expect(wakeContext(opened, WAKE)).toBeNull();
    expect(wakeContext(opened, { ...WAKE, wakeOnNewIssues: true })).toContain(
      "issue #19 opened",
    );
    expect(
      wakeContext({ ...opened, action: "reopened" }, { ...WAKE, wakeOnNewIssues: true }),
    ).toContain("issue #19 reopened");
  });

  it("stays inert with nothing configured, whatever arrives", () => {
    // The update must change no existing agent's behaviour: no surprise turns, no surprise spend.
    const { wakeContext } = loadTemplate();
    const inert: WakeSettings = {
      repos: [],
      wakeLabels: [],
      wakeOnNewIssues: false,
      appSlug: "",
    };
    expect(wakeContext(labelEvent(), inert)).toBeNull();
    expect(wakeContext(labelEvent({ action: "synchronize", label: null }), inert)).toBeNull();
    expect(
      wakeContext(labelEvent({ kind: "issue", action: "opened", label: null }), inert),
    ).toBeNull();
    // Not even with the labels set but no repository named — an empty repo list means INERT,
    // never "every repository this App can see".
    expect(
      wakeContext(labelEvent(), { ...inert, wakeLabels: ["changes-requested"] }),
    ).toBeNull();
  });
});

describe("the wake hooks and the HARNESST_CHANNEL_GITHUB_* env contract", () => {
  const CONFIGURED = {
    HARNESST_CHANNEL_GITHUB_REPOS: "worksauceapp/marketing-site,acme/widgets",
    HARNESST_CHANNEL_GITHUB_WAKE_LABELS: "ready, changes-requested",
    GITHUB_APP_SLUG: "ivy-worksauce",
  };

  it("registers both hooks — eve dispatches nothing for these webhooks without them", () => {
    const harness = loadTemplate();
    expect(typeof harness.config.onIssue).toBe("function");
    expect(typeof harness.config.onPullRequest).toBe("function");
  });

  it("ignores everything when no channel settings reached the container", () => {
    // An agent taking the 0.6.0 update before anyone opens the settings panel must behave exactly
    // as it did on 0.5.0: mentions only.
    const harness = loadTemplate();
    expect(harness.issueEvent({ action: "labeled", label: "ready" })).toBeNull();
    expect(harness.issueEvent({ action: "opened" })).toBeNull();
    expect(harness.pullRequestEvent({ action: "synchronize", headSha: "a".repeat(40) })).toBeNull();
    expect(harness.pullRequestEvent({ action: "ready_for_review" })).toBeNull();
  });

  it("reads the repo and label lists off the env names deployRelease emits", () => {
    const harness = loadTemplate({ env: CONFIGURED });
    const dispatched = harness.pullRequestEvent({
      action: "labeled",
      label: "changes-requested",
      headSha: "ee9a696aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(dispatched).toMatchObject({ auth: null });
    expect(dispatched?.context?.[0]).toContain('pull request #19 labeled "changes-requested"');
    // an unwatched repository, same event
    expect(
      harness.pullRequestEvent({ action: "labeled", label: "ready", repo: "acme/other" }),
    ).toBeNull();
  });

  it("treats an absent wake-on-new-issues var as off and \"1\" as on", () => {
    const off = loadTemplate({ env: CONFIGURED });
    expect(off.issueEvent({ action: "opened" })).toBeNull();

    const on = loadTemplate({
      env: { ...CONFIGURED, HARNESST_CHANNEL_GITHUB_WAKE_ON_NEW_ISSUES: "1" },
    });
    expect(on.issueEvent({ action: "opened" })).toMatchObject({ auth: null });

    // The projection renders `false` as an EMPTY string rather than deleting the key.
    const empty = loadTemplate({
      env: { ...CONFIGURED, HARNESST_CHANNEL_GITHUB_WAKE_ON_NEW_ISSUES: "" },
    });
    expect(empty.issueEvent({ action: "opened" })).toBeNull();
  });

  it("reads the transition label off raw.label, not the issue's current labels", () => {
    const harness = loadTemplate({ env: CONFIGURED });
    // `labeled` with no label payload at all cannot be attributed to a rule, so it must not wake.
    expect(harness.issueEvent({ action: "labeled" })).toBeNull();
    expect(harness.issueEvent({ action: "labeled", label: "ready" })).toMatchObject({
      auth: null,
    });
    expect(harness.issueEvent({ action: "unlabeled", label: "ready" })).toBeNull();
  });

  it("does not wake on its own GITHUB_APP_SLUG", () => {
    const harness = loadTemplate({ env: CONFIGURED });
    expect(
      harness.issueEvent({ action: "labeled", label: "ready", sender: "Ivy-Worksauce[bot]" }),
    ).toBeNull();
    expect(
      harness.issueEvent({ action: "labeled", label: "ready", sender: "sam-worksauce[bot]" }),
    ).toMatchObject({ auth: null });
  });
});
