import { describe, expect, it } from "vitest";

import {
  planSetup,
  type SetupInput,
  type SetupMemberState,
} from "~/marketplace/setup-plan";

function member(
  name: string,
  extra: Partial<SetupMemberState> = {},
): SetupMemberState {
  return {
    name,
    agentId: `id-${name}`,
    missingSecrets: [],
    github: null,
    connections: [],
    ...extra,
  };
}

function input(extra: Partial<SetupInput> = {}): SetupInput {
  return {
    members: [],
    sharedSecretNames: [],
    hasUnpublishedChanges: false,
    ledger: null,
    ...extra,
  };
}

const app = (
  installations: Array<{ account: string; missing: string[] }> | null,
) => ({
  required: { contents: "write" as const },
  app: {
    slug: "atlas-app",
    settingsUrl: "https://github.com/settings/apps/atlas-app",
    installations:
      installations?.map((i) => ({
        ...i,
        htmlUrl: `https://github.com/${i.account}`,
        repositorySelection: "all",
      })) ?? null,
  },
});

describe("planSetup", () => {
  it("is complete with nothing to do", () => {
    const plan = planSetup(input({ members: [member("a")] }));
    expect(plan).toEqual({ steps: [], next: null, done: 0, total: 0 });
  });

  it("asks once for a secret several members need, and marks an existing shared one", () => {
    const plan = planSetup(
      input({
        sharedSecretNames: ["CLOUDFLARE_API_TOKEN"],
        members: [
          member("atlas", {
            missingSecrets: [
              { name: "CLOUDFLARE_API_TOKEN", description: "deploys" },
            ],
          }),
          member("icarus", {
            missingSecrets: [
              { name: "CLOUDFLARE_API_TOKEN", sandbox: true },
              { name: "API_KEY" },
            ],
          }),
        ],
      }),
    );
    const secrets = plan.steps.filter((s) => s.kind === "secret");
    expect(secrets.map((s) => s.kind === "secret" && s.name)).toEqual([
      "API_KEY",
      "CLOUDFLARE_API_TOKEN",
    ]);
    expect(secrets[1]).toMatchObject({
      members: ["atlas", "icarus"],
      sandbox: true,
      description: "deploys",
      sharedExists: true,
    });
    expect(secrets[0]).toMatchObject({
      members: ["icarus"],
      sharedExists: false,
    });
  });

  it("orders secrets, ledger, publish, GitHub, connections, May I, wakes", () => {
    const plan = planSetup(
      input({
        hasUnpublishedChanges: true,
        ledger: { status: "pending", mayi: "not_installed" },
        members: [
          member("hermes", {
            agentId: null,
            missingSecrets: [{ name: "X" }],
            github: { required: {}, app: null },
            connections: [{ provider: "google", connected: false }],
          }),
        ],
      }),
    );
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "secret",
      "ledger",
      "publish",
      "github-app",
      "connection",
      "mayi",
      "wakes",
    ]);
    expect(plan.next?.kind).toBe("secret");
    expect(plan.steps.find((s) => s.kind === "publish")).toMatchObject({
      members: ["hermes"],
    });
    expect(plan.steps.find((s) => s.kind === "github-app")).toMatchObject({
      state: "unpublished",
    });
    expect(plan.steps.find((s) => s.kind === "connection")).toMatchObject({
      published: false,
      done: false,
    });
  });

  it("counts finished steps and points next at the first unfinished one", () => {
    const plan = planSetup(
      input({
        ledger: { status: "ready", mayi: "authorizing" },
        members: [
          member("a", {
            connections: [{ provider: "google", connected: true }],
          }),
        ],
      }),
    );
    expect(plan.steps.map((s) => [s.kind, s.done])).toEqual([
      ["ledger", true],
      ["connection", true],
      ["mayi", false],
      ["wakes", true],
    ]);
    expect(plan.next?.kind).toBe("mayi");
    expect(plan.done).toBe(3);
    expect(plan.total).toBe(4);
  });

  it("treats a provisioned ledger as installed but not yet verified", () => {
    const plan = planSetup(
      input({ ledger: { status: "provisioned", mayi: "connected" } }),
    );
    expect(plan.steps.map((s) => [s.kind, s.done])).toEqual([
      ["ledger", true],
      ["mayi", true],
      ["wakes", false],
    ]);
  });

  it.each([
    ["no App yet", { required: {}, app: null }, "create", false],
    ["unreachable GitHub", app(null), "unknown", false],
    ["not installed", app([]), "install", false],
    [
      "missing permissions",
      app([
        { account: "org-a", missing: ["administration:write"] },
        { account: "org-b", missing: [] },
      ]),
      "permissions",
      false,
    ],
    ["ready", app([{ account: "org-a", missing: [] }]), "ready", true],
  ] as const)("GitHub App step: %s", (_label, github, state, done) => {
    const plan = planSetup(input({ members: [member("atlas", { github })] }));
    expect(plan.steps[0]).toMatchObject({ kind: "github-app", state, done });
  });

  it("collects missing GitHub permissions across installations, once each", () => {
    const plan = planSetup(
      input({
        members: [
          member("atlas", {
            github: app([
              {
                account: "a",
                missing: ["workflows:write", "administration:write"],
              },
              { account: "b", missing: ["administration:write"] },
            ]),
          }),
        ],
      }),
    );
    expect(plan.steps[0]).toMatchObject({
      missing: ["administration:write", "workflows:write"],
    });
  });
});
