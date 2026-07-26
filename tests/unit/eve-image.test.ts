import { mkdir } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

type ExecOptionsOrCallback =
  { maxBuffer?: number; timeout?: number } | ExecCallback;

function execCallback(
  optionsOrCallback: ExecOptionsOrCallback,
  maybeCallback?: ExecCallback,
): ExecCallback {
  return typeof optionsOrCallback === "function"
    ? optionsOrCallback
    : maybeCallback!;
}

function defaultExecFile(
  cmd: string,
  args: string[],
  optionsOrCallback: ExecOptionsOrCallback,
  maybeCallback?: ExecCallback,
) {
  const callback = execCallback(optionsOrCallback, maybeCallback);

  if (cmd === "mkdir") {
    mkdir(args[1], { recursive: true }).then(
      () => callback(null, "", ""),
      (error) => callback(error, "", ""),
    );
    return;
  }

  if (cmd === "tar") {
    const target = args[args.indexOf("-C") + 1];
    mkdir(target, { recursive: true }).then(
      () => callback(null, "", ""),
      (error) => callback(error, "", ""),
    );
    return;
  }

  callback(null, "", "");
}

const execFile = vi.fn(defaultExecFile);

vi.mock("node:child_process", () => ({ execFile }));

vi.mock("~/github/client.server", () => ({
  getInstallationOctokit: vi.fn(async () => ({
    request: vi.fn(async () => ({ data: new ArrayBuffer(0) })),
  })),
}));

// Wrap writeFile so build-context injection is observable — it still writes to the temp dir.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) =>
      actual.writeFile(...args),
    ),
  };
});

describe("buildStagedTree", () => {
  beforeEach(() => {
    execFile.mockClear();
    execFile.mockImplementation(defaultExecFile);
  });

  it("fails deploy builds fast when the Docker daemon is unhealthy", async () => {
    const { buildEveImage } = await import("~/deploy/eve-image.server");

    execFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        optionsOrCallback:
          | { maxBuffer?: number; timeout?: number }
          | ((error: Error | null, stdout: string, stderr: string) => void),
        maybeCallback?: (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback!;
        const stderr =
          "ERROR: request returned 500 Internal Server Error for API route and version http://%2FUsers%2Faaron%2F.docker%2Frun%2Fdocker.sock/_ping";
        const error = Object.assign(
          new Error(`Command failed: docker version\n${stderr}`),
          {
            stderr,
          },
        );
        callback(error, "", stderr);
      },
    );

    await expect(
      buildEveImage({
        projectId: "proj_1",
        repo: { owner: "acme", repo: "agents" },
        ref: "abc123",
        installationId: "inst_1",
      }),
    ).rejects.toMatchObject({
      name: "DockerUnavailableError",
      message: expect.stringContaining("Docker is not responding"),
    });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it("reports Eve build errors without the full docker transcript", async () => {
    const { buildEveImage } = await import("~/deploy/eve-image.server");

    execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        optionsOrCallback: ExecOptionsOrCallback,
        maybeCallback?: ExecCallback,
      ) => {
        const callback = execCallback(optionsOrCallback, maybeCallback);
        if (cmd === "docker" && args[0] === "build") {
          const stderr = [
            "#11 [build 7/7] RUN npm exec -- eve build",
            "#11 0.670 The requested module 'eve' does not provide an export named 'defineTool'",
            '#11 ERROR: process "/bin/sh -c npm exec -- eve build" did not complete successfully: exit code: 1',
          ].join("\n");
          const error = Object.assign(
            new Error(`Command failed: docker build\n${stderr}`),
            { stderr },
          );
          callback(error, "", stderr);
          return;
        }
        defaultExecFile(cmd, args, optionsOrCallback, maybeCallback);
      },
    );

    let message = "";
    try {
      await buildEveImage({
        projectId: "proj_1",
        repo: { owner: "acme", repo: "agents" },
        ref: "abc123",
        installationId: "inst_1",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Agent image build failed");
    expect(message).toContain(
      "The requested module 'eve' does not provide an export named 'defineTool'",
    );
    expect(message).not.toContain("Command failed: docker build");
  });

  it("surfaces legacy-builder compile errors, which arrive on stdout", async () => {
    // A docker CLI without the buildx plugin (some self-host setups) falls back to the
    // legacy builder: build-step output — including the compiler's error — streams to
    // STDOUT, while stderr carries only the deprecation banner and the exit-code line.
    // Reading error.message alone reported "returned a non-zero code: 1" with no cause.
    const { buildStagedTree } = await import("~/deploy/eve-image.server");

    const stdout = [
      "Step 7/7 : RUN npm exec -- eve build",
      " ---> Running in 0123456789ab",
      "The requested module 'eve' does not provide an export named 'defineDynamic'",
    ].join("\n");
    const stderr = [
      "DEPRECATED: The legacy builder is deprecated and will be removed in a future release.",
      "The command '/bin/sh -c npm exec -- eve build' returned a non-zero code: 1",
    ].join("\n");

    execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        optionsOrCallback: ExecOptionsOrCallback,
        maybeCallback?: ExecCallback,
      ) => {
        const callback = execCallback(optionsOrCallback, maybeCallback);
        if (cmd === "docker" && args[0] === "build") {
          const error = Object.assign(
            new Error(`Command failed: docker build\n${stderr}`),
            { stdout, stderr },
          );
          callback(error, stdout, stderr);
          return;
        }
        defaultExecFile(cmd, args, optionsOrCallback, maybeCallback);
      },
    );

    const result = await buildStagedTree({
      projectId: "proj_1",
      repo: { owner: "acme", repo: "agents" },
      ref: "abc123",
      installationId: "inst_1",
      overlay: [],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.output).toContain(
      "does not provide an export named 'defineDynamic'",
    );
  });

  it("surfaces typecheck/lint failures, which tsc and eslint print on stdout", async () => {
    const { buildStagedTree } = await import("~/deploy/eve-image.server");

    const tscOutput = "agent/agent.ts(4,10): error TS2305: Module 'eve' has no exported member 'defineDynamic'.";
    execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        optionsOrCallback: ExecOptionsOrCallback,
        maybeCallback?: ExecCallback,
      ) => {
        const callback = execCallback(optionsOrCallback, maybeCallback);
        if (cmd === "docker" && args[0] === "run") {
          const error = Object.assign(new Error("Command failed: docker run"), {
            stdout: tscOutput,
            stderr: "",
          });
          callback(error, tscOutput, "");
          return;
        }
        defaultExecFile(cmd, args, optionsOrCallback, maybeCallback);
      },
    );

    const result = await buildStagedTree({
      projectId: "proj_1",
      repo: { owner: "acme", repo: "agents" },
      ref: "abc123",
      installationId: "inst_1",
      overlay: [],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.output).toContain("error TS2305");
  });

  it("skips publish checks when the Docker daemon is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { buildStagedTree } = await import("~/deploy/eve-image.server");

      execFile.mockImplementationOnce(
        (
          _cmd: string,
          _args: string[],
          optionsOrCallback:
            | { maxBuffer?: number; timeout?: number }
            | ((error: Error | null, stdout: string, stderr: string) => void),
          maybeCallback?: (
            error: Error | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          const callback =
            typeof optionsOrCallback === "function"
              ? optionsOrCallback
              : maybeCallback!;
          const error = Object.assign(
            new Error("Command failed: docker version"),
            {
              killed: true,
              signal: "SIGTERM",
            },
          );
          callback(error, "", "");
        },
      );

      await expect(
        buildStagedTree({
          projectId: "proj_1",
          repo: { owner: "acme", repo: "agents" },
          ref: "abc123",
          installationId: "inst_1",
          overlay: [],
        }),
      ).resolves.toEqual({ ok: true, skipped: true });
    } finally {
      warn.mockRestore();
    }
  });

  it("creates a missing new-member package directory before adding the Dockerfile", async () => {
    const { buildStagedTree } = await import("~/deploy/eve-image.server");

    await expect(
      buildStagedTree({
        projectId: "proj_1",
        repo: { owner: "acme", repo: "agents" },
        ref: "abc123",
        installationId: "inst_1",
        agentRoot: "agents/cloudflare-dev/agent",
        overlay: [
          {
            path: "agents/cloudflare-dev/package.json",
            content: JSON.stringify({ scripts: { build: "eve build" } }),
          },
          {
            path: "agents/cloudflare-dev/agent/agent.ts",
            content: "export default {};",
          },
        ],
      }),
    ).resolves.toEqual({
      ok: true,
      provisionalTag: "harnesst/publish-check:proj-proj_1-cloudflare-dev",
    });

    expect(execFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["build", "--target", "build"]),
      expect.any(Object),
      expect.any(Function),
    );
  });
});

/**
 * The generated agent Dockerfile — the contract the deploy pipeline bakes into every image.
 *
 * Pins the fix for the sandbox-template bug: images must boot via `eve start` (which prewarms
 * `eve-sbx-tpl-*` template images BEFORE the server binds its port) from a runtime stage that
 * inherits the full build stage (`eve start` needs node_modules + .eve/compile). Booting the
 * raw Nitro entry left every skills/bootstrap-carrying agent permanently unable to use its
 * bash tools (SandboxTemplateNotProvisionedError; self-heal is disabled for built servers).
 */
describe("ask-teammate tool injection (D2)", () => {
  beforeEach(() => {
    execFile.mockClear();
    execFile.mockImplementation(defaultExecFile);
  });

  async function writeCalls() {
    const fsp = await import("node:fs/promises");
    return (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mock.calls as [
      string,
      string,
    ][];
  }

  it("bakes the generated tool into a team member's build context", async () => {
    const { buildEveImage } = await import("~/deploy/eve-image.server");
    const fsp = await import("node:fs/promises");
    (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mockClear();

    // Injection happens in fetchSource, before the docker build — the build result is irrelevant
    // to this assertion (the mocked docker CLI isn't wired for a full success path).
    await buildEveImage({
      projectId: "proj_1",
      repo: { owner: "acme", repo: "agents" },
      ref: "abc123",
      installationId: "inst_1",
      agentRoot: "agents/deployer/agent",
      injectTeammateTool: true,
    }).catch(() => {});

    const toolWrite = (await writeCalls()).find(([p]) =>
      String(p).endsWith("agents/deployer/agent/tools/ask-teammate.ts"),
    );
    expect(toolWrite).toBeTruthy();
    expect(String(toolWrite![1])).toContain("defineTool");
    expect(String(toolWrite![1])).toContain("/api/team/ask");
  });

  it("does not inject when the flag is unset (single-agent / non-member builds)", async () => {
    const { buildEveImage } = await import("~/deploy/eve-image.server");
    const fsp = await import("node:fs/promises");
    (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mockClear();

    await buildEveImage({
      projectId: "proj_1",
      repo: { owner: "acme", repo: "agents" },
      ref: "abc123",
      installationId: "inst_1",
    }).catch(() => {});

    const toolWrite = (await writeCalls()).find(([p]) =>
      String(p).endsWith("tools/ask-teammate.ts"),
    );
    expect(toolWrite).toBeUndefined();
  });
});

describe("HARNESST_EVE_DOCKERFILE", () => {
  it("boots via the eve bin (`eve start`), not the raw Nitro entry", async () => {
    const { HARNESST_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(HARNESST_EVE_DOCKERFILE).toContain(
      'CMD ["node_modules/.bin/eve", "start"]',
    );
    expect(HARNESST_EVE_DOCKERFILE).not.toContain(
      'CMD ["node", ".output/server/index.mjs"]',
    );
    // Not via npm exec/npm run either — unreliable SIGTERM forwarding as PID 1, and harnesst's
    // scale-to-zero is a docker stop.
    expect(HARNESST_EVE_DOCKERFILE).not.toMatch(/CMD.*npm (exec|run)/);
  });

  it("runtime stage inherits the build stage (eve start needs node_modules + .eve/compile)", async () => {
    const { HARNESST_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(HARNESST_EVE_DOCKERFILE).toMatch(/^FROM build$/m);
    // Exactly one base-image stage: the old lean runtime stage duplicated nothing it needed.
    expect(HARNESST_EVE_DOCKERFILE.match(/^FROM node:24-slim/gm)).toHaveLength(1);
    // The publish build + world migrations build `--target build` — the stage name is API.
    expect(HARNESST_EVE_DOCKERFILE).toContain("FROM node:24-slim AS build");
  });

  it("keeps the runtime contract: PORT env, exposed port, the eve-docker shim", async () => {
    const { HARNESST_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
    expect(HARNESST_EVE_DOCKERFILE).toContain("ENV PORT=3000");
    expect(HARNESST_EVE_DOCKERFILE).toContain("EXPOSE 3000");
    expect(HARNESST_EVE_DOCKERFILE).toContain("/usr/local/bin/eve-docker");
  });
});
