/**
 * scripts/dev-origin.mjs decides which origin `npm run dev` hands out. A wrong answer is a share
 * link or preview frame pointing at the user's own machine, or a worktree that signs you out of
 * main, so pin each branch of the decision.
 */
import { describe, expect, it, vi } from "vitest";

import {
  devHostname,
  resolveDevOrigin,
  worktreeSlug,
} from "../../scripts/dev-origin.mjs";

const resolvesAll = async () => true;
const resolvesNone = async () => false;

function decide(
  env: { BETTER_AUTH_URL?: string; HARNESST_DEV_HOST?: string },
  overrides: Partial<Parameters<typeof resolveDevOrigin>[0]> = {},
) {
  return resolveDevOrigin({
    env,
    port: 5280,
    cwd: "/repo/.worktrees/feature-x",
    isWorktree: true,
    resolves: resolvesAll,
    ...overrides,
  });
}

describe("resolveDevOrigin", () => {
  it("moves a loopback origin onto the worktree's tailnet host, keeping its port", async () => {
    await expect(
      decide({ BETTER_AUTH_URL: "http://localhost:5280" }),
    ).resolves.toEqual({
      origin: "http://app--feature-x.harnesst.test:5280",
      upgraded: true,
    });
  });

  it("gives the main checkout the bare app host", async () => {
    await expect(
      decide(
        { BETTER_AUTH_URL: "http://127.0.0.1:5173" },
        { cwd: "/repo", isWorktree: false, port: 5173 },
      ),
    ).resolves.toMatchObject({ origin: "http://app.harnesst.test:5173" });
  });

  it("uses the dev port when BETTER_AUTH_URL is unset", async () => {
    await expect(decide({})).resolves.toMatchObject({
      origin: "http://app--feature-x.harnesst.test:5280",
      upgraded: true,
    });
  });

  it("keeps a deliberate non-loopback origin such as the dev tunnel's", async () => {
    const resolves = vi.fn(resolvesAll);
    await expect(
      decide({ BETTER_AUTH_URL: "https://x.dev.zero8.ai" }, { resolves }),
    ).resolves.toEqual({ origin: "https://x.dev.zero8.ai", upgraded: false });
    expect(resolves).not.toHaveBeenCalled();
  });

  it("stays on loopback, with a reason, when the tailnet host does not resolve", async () => {
    const result = await decide(
      { BETTER_AUTH_URL: "http://localhost:5280" },
      { resolves: resolvesNone },
    );
    expect(result.origin).toBe("http://localhost:5280");
    expect(result.upgraded).toBe(false);
    expect(result.note).toContain("app--feature-x.harnesst.test");
  });

  it("stays on loopback when HARNESST_DEV_HOST says localhost", async () => {
    await expect(
      decide({
        BETTER_AUTH_URL: "http://localhost:5280",
        HARNESST_DEV_HOST: "localhost",
      }),
    ).resolves.toEqual({ origin: "http://localhost:5280", upgraded: false });
  });

  it("uses an explicit HARNESST_DEV_HOST without a DNS check", async () => {
    const resolves = vi.fn(resolvesNone);
    await expect(
      decide(
        {
          BETTER_AUTH_URL: "http://localhost:5280",
          HARNESST_DEV_HOST: "Box.Example.Test",
        },
        { resolves },
      ),
    ).resolves.toEqual({
      origin: "http://box.example.test:5280",
      upgraded: true,
    });
    expect(resolves).not.toHaveBeenCalled();
  });

  it("ignores a HARNESST_DEV_HOST that is not a bare hostname", async () => {
    const result = await decide({
      BETTER_AUTH_URL: "http://localhost:5280",
      HARNESST_DEV_HOST: "box.test:9000",
    });
    expect(result).toMatchObject({
      origin: "http://localhost:5280",
      upgraded: false,
    });
    expect(result.note).toContain("bare hostname");
  });
});

describe("devHostname", () => {
  it("falls back to the bare app host when the worktree name has no usable characters", () => {
    expect(devHostname({ cwd: "/repo/.worktrees/___", isWorktree: true })).toBe(
      "app.harnesst.test",
    );
  });
});

describe("worktreeSlug", () => {
  it("turns a directory name into a DNS label fragment", () => {
    expect(worktreeSlug("Feature_Omniplex.9448b652")).toBe(
      "feature-omniplex-9448b652",
    );
  });

  it("keeps the whole label within DNS's 63 characters without a trailing hyphen", () => {
    const slug = worktreeSlug(`${"a".repeat(57)}-bbbb`);
    expect(`app--${slug}`.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
  });
});
