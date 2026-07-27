/**
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

interface Harness {
  /** The config object the template handed to `githubChannel()`. */
  config: {
    events: Record<
      string,
      (event: unknown, channel: unknown, ctx: unknown) => Promise<void>
    >;
  };
  /** The template's default export (channel + its extra routes). */
  channelModule: { routes: unknown[] };
  commands: SandboxCall[];
  files: Record<string, string>;
  networkPolicyCalls: unknown[];
  posts: string[];
  reactions: string[];
  errors: string[];
  mintCalls: number;
  state: Record<string, unknown>;
  turnStarted: () => Promise<void>;
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
}

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
      POST: (path: string, handler: unknown) => ({ path, handler }),
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
      ...(options.env ?? {}),
    },
  };

  const fakeFetch = async (url: string) => {
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

  return {
    config,
    channelModule: moduleObject.exports.default as { routes: unknown[] },
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
    turnStarted: () => config!.events["turn.started"]({}, channel, ctx),
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
