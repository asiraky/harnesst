import { afterEach, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture(key = "ab".repeat(32), migrationFails = false) {
  const root = mkdtempSync(join(tmpdir(), "harnesst-hooks-"));
  scratch.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "package.json"), '{"private":true}');
  writeFileSync(join(root, "AGENTS.md"), "fixture\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const cwd = join(root, ".worktrees", "external-name");
  git("worktree", "add", "-b", "feature/different-name", cwd);
  writeFileSync(
    join(root, ".env.local"),
    `DATABASE_URL=postgres://fixture:private@localhost/fixture\nHARNESST_SECRETS_KEY=${key}\n`,
  );
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nif [ "$1" = inspect ]; then echo true; else echo 1; fi\n',
    { mode: 0o755 },
  );
  mkdirSync(join(cwd, "node_modules", "drizzle-kit"), { recursive: true });
  writeFileSync(
    join(cwd, "node_modules", "drizzle-kit", "bin.cjs"),
    `require('node:fs').writeFileSync('migration-ran',process.env.DATABASE_URL);process.exit(${migrationFails ? 1 : 0})`,
  );
  const context = join(root, "context.json"),
    result = join(root, "result.json");
  writeFileSync(
    context,
    JSON.stringify({
      version: 1,
      projectRoot: root,
      requestedBranch: "feature/different-name",
      baseRef: "main",
      suggestedWorktreePath: cwd,
    }),
  );
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    HARNESST_SECRETS_KEY: "",
    OMNIPLEX_LIFECYCLE_VERSION: "2",
    OMNIPLEX_CONTEXT_FILE: context,
    OMNIPLEX_RESULT_FILE: result,
  };
  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, [resolve("scripts", script), ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
  return { root, cwd, context, result, run };
}
test("Omniplex setup uses the saved path, accepts --base, migrates its own DB and teardown handles renamed branches", () => {
  const f = fixture();
  const setup = f.run("worktree-setup.mjs", [
    "--base",
    "main",
    "feature/different-name",
  ]);
  expect(setup.status, setup.stderr).toBe(0);
  const result = JSON.parse(readFileSync(f.result, "utf8"));
  expect(result.cwd).toBe(f.cwd);
  expect(readFileSync(join(f.cwd, "migration-ran"), "utf8")).toMatch(
    /\/fixture_external_name$/,
  );
  const before = readFileSync(join(f.cwd, ".env.local"), "utf8");
  expect(
    f.run("worktree-setup.mjs", ["--base", "main", "feature/different-name"])
      .status,
  ).toBe(0);
  expect(readFileSync(join(f.cwd, ".env.local"), "utf8")).toBe(before);
  writeFileSync(
    f.context,
    JSON.stringify({
      version: 1,
      projectRoot: f.root,
      provisionResult: result,
    }),
  );
  const cleanup = f.run("worktree-teardown.mjs", ["feature/renamed-branch"]);
  expect(cleanup.status, cleanup.stderr).toBe(0);
  expect(existsSync(f.cwd)).toBe(false);
  expect(
    JSON.parse(readFileSync(join(f.root, ".worktrees", "_ports.json"), "utf8")),
  ).toEqual({});
  expect(
    f.run("worktree-teardown.mjs", ["feature/renamed-branch"]).status,
  ).toBe(0);
});
test("missing canonical key fails before allocating resources", () => {
  const f = fixture("");
  const setup = f.run("worktree-setup.mjs", [
    "--base",
    "main",
    "feature/different-name",
  ]);
  expect(setup.status).not.toBe(0);
  expect(setup.stderr).toContain("HARNESST_SECRETS_KEY");
  expect(existsSync(join(f.root, ".worktrees", "_ports.json"))).toBe(false);
});
test("failed migration cannot report a ready workspace", () => {
  const f = fixture(undefined, true);
  const setup = f.run("worktree-setup.mjs", [
    "--base",
    "main",
    "feature/different-name",
  ]);
  expect(setup.status).not.toBe(0);
  expect(existsSync(f.result)).toBe(false);
});
test("cleanup refuses a missing saved workspace and protects main", () => {
  const f = fixture();
  writeFileSync(f.context, JSON.stringify({ projectRoot: f.root }));
  expect(
    f.run("worktree-teardown.mjs", ["feature/different-name"]).status,
  ).not.toBe(0);
  writeFileSync(
    f.context,
    JSON.stringify({ projectRoot: f.root, provisionResult: { cwd: f.root } }),
  );
  expect(
    f.run("worktree-teardown.mjs", ["feature/different-name"]).status,
  ).not.toBe(0);
  expect(existsSync(join(f.root, ".git"))).toBe(true);
});
