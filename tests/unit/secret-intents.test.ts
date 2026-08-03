/**
 * Action-level intent handling for the secrets rework (§6): validation, JSON payloads (never a
 * redirect, never a value echo), atomic sandbox-at-creation, attach/detach/dismiss delegation,
 * and the missing-requirements computation the loader and deploy guard share (§9, §11.6).
 */
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { computeRequiredSecrets, handleSecretIntent, type SecretIntentDeps } from "~/project/secrets.server";
import { makeLocalSecretsProvider } from "~/seams/oss/secrets.local.server";
import { fingerprint } from "~/seams/oss/secretbox";
import { makeFakeSecretKV, type FakeSecretKV } from "../fakes/secret-kv";

const key = crypto.randomBytes(32);
const PROJECT = "proj_1";
const AGENT = "agent_1";
const USER = "user_1";

let kv: FakeSecretKV;
let deps: SecretIntentDeps;
let attachCalls: unknown[];
let dismissCalls: unknown[];
let exposeCalls: unknown[];
let invalidateCalls: unknown[];

const base = {
  projectId: PROJECT,
  agentId: AGENT,
  environmentId: null as string | null,
  userId: USER,
};

beforeEach(() => {
  kv = makeFakeSecretKV();
  attachCalls = [];
  dismissCalls = [];
  exposeCalls = [];
  invalidateCalls = [];
  deps = {
    secrets: makeLocalSecretsProvider(kv, () => key),
    // The Drizzle row echo is faked from the KV's meta so no DB is needed.
    getRow: async (ref) => {
      const meta = kv.meta(ref);
      if (!meta) return null;
      return {
        key: ref.key,
        environmentId: ref.environmentId,
        sandboxExposed: meta.sandboxExposed ?? false,
        fingerprint: meta.fingerprint ?? null,
        updatedAt: new Date().toISOString(),
        updatedBy: meta.updatedBy ?? null,
      };
    },
    setExposed: async (...args) => {
      exposeCalls.push(args);
    },
    attach: async (input) => {
      attachCalls.push(input);
    },
    dismiss: async (input) => {
      dismissCalls.push(input);
    },
    dependents: async () => [],
    invalidate: async (input) => {
      invalidateCalls.push(input);
      return { environmentIds: [] };
    },
  };
});

describe("secret-set / secret-replace", () => {
  it("rejects an invalid key and an empty value with typed errors", async () => {
    const bad = await handleSecretIntent({ ...base, intent: "secret-set", key: "1BAD", value: "v" }, deps);
    expect(bad).toEqual({
      ok: false,
      error: "Key must be a valid env var name (A–Z, 0–9, _).",
    });
    const empty = await handleSecretIntent({ ...base, intent: "secret-set", key: "GOOD", value: "" }, deps);
    expect(empty).toEqual({ ok: false, error: "Value is required." });
  });

  it("writes the value with sandbox set atomically and echoes metadata, never the value", async () => {
    const res = await handleSecretIntent(
      {
        ...base,
        intent: "secret-set",
        key: "API_KEY",
        value: "s3cr3t",
        exposed: true,
      },
      deps,
    );
    expect(res.ok).toBe(true);
    if (!res.ok || !res.secret) throw new Error("expected secret echo");
    expect(res.secret.name).toBe("API_KEY");
    expect(res.secret.sandboxExposed).toBe(true);
    expect(res.secret.fingerprint).toBe(fingerprint("s3cr3t"));
    expect(JSON.stringify(res)).not.toContain("s3cr3t");
    expect(invalidateCalls).toEqual([{ agentIds: [AGENT], environmentId: null, createdBy: USER }]);
  });

  it("secret-replace without `exposed` leaves the existing sandbox flag untouched", async () => {
    await handleSecretIntent(
      {
        ...base,
        intent: "secret-set",
        key: "API_KEY",
        value: "v1",
        exposed: true,
      },
      deps,
    );
    const res = await handleSecretIntent({ ...base, intent: "secret-replace", key: "API_KEY", value: "v2" }, deps);
    if (!res.ok || !res.secret) throw new Error("expected secret echo");
    expect(res.secret.sandboxExposed).toBe(true);
    expect(res.secret.fingerprint).toBe(fingerprint("v2"));
  });
});

describe("secret-delete / secret-expose", () => {
  it("deletes scope-exactly and returns the deleted key", async () => {
    await handleSecretIntent({ ...base, intent: "secret-set", key: "API_KEY", value: "v" }, deps);
    const res = await handleSecretIntent({ ...base, intent: "secret-delete", key: "API_KEY" }, deps);
    expect(res).toEqual({
      ok: true,
      deleted: { key: "API_KEY", environmentId: null },
    });
    expect(await deps.secrets.get({ ...base, environmentId: null, key: "API_KEY" })).toBeNull();
  });

  it("secret-expose flips the flag via the store helper", async () => {
    const res = await handleSecretIntent({ ...base, intent: "secret-expose", key: "API_KEY", exposed: true }, deps);
    expect(res).toEqual({ ok: true });
    expect(exposeCalls).toHaveLength(1);
  });
});

describe("secret-attach / secret-detach / secret-dismiss", () => {
  it("attach seeds the per-attachment sandbox flag", async () => {
    await handleSecretIntent({ ...base, intent: "secret-attach", key: "GITHUB_TOKEN", exposed: true }, deps);
    expect(attachCalls[0]).toMatchObject({
      agentId: AGENT,
      key: "GITHUB_TOKEN",
      attached: true,
      sandboxExposed: true,
    });
  });

  it("detach removes the attachment", async () => {
    await handleSecretIntent({ ...base, intent: "secret-detach", key: "GITHUB_TOKEN" }, deps);
    expect(attachCalls[0]).toMatchObject({
      key: "GITHUB_TOKEN",
      attached: false,
    });
  });

  it("dismiss and restore round-trip through the dismissals store", async () => {
    await handleSecretIntent(
      {
        ...base,
        intent: "secret-dismiss",
        key: "OPTIONAL_KEY",
        dismissed: true,
      },
      deps,
    );
    await handleSecretIntent(
      {
        ...base,
        intent: "secret-dismiss",
        key: "OPTIONAL_KEY",
        dismissed: false,
      },
      deps,
    );
    expect(dismissCalls).toMatchObject([{ dismissed: true }, { dismissed: false }]);
  });
});

describe("shared-secret intents (§8 — project-level scope)", () => {
  it("shared-secret-set writes at agentId null with the sandbox DEFAULT set atomically", async () => {
    const res = await handleSecretIntent(
      {
        ...base,
        intent: "shared-secret-set",
        agentId: "ignored-by-shared-intents",
        key: "GITHUB_TOKEN",
        value: "gh_x",
        exposed: true,
      },
      deps,
    );
    expect(res.ok).toBe(true);
    // Written at the project-level (shared) scope, not the member's.
    const sharedRef = {
      projectId: PROJECT,
      agentId: null,
      environmentId: null,
      key: "GITHUB_TOKEN",
    };
    expect(await deps.secrets.get(sharedRef)).toBe("gh_x");
    expect(kv.meta(sharedRef)?.sandboxExposed).toBe(true);
    expect(
      await deps.secrets.get({
        ...sharedRef,
        agentId: "ignored-by-shared-intents",
      }),
    ).toBeNull();
  });

  it("reconciles every agent attached to a replaced shared secret", async () => {
    await handleSecretIntent(
      {
        ...base,
        intent: "shared-secret-set",
        agentId: null,
        key: "SHARED_TOKEN",
        value: "rotated",
      },
      {
        ...deps,
        dependents: async () => [
          { agentId: "agent_a", agentName: "A" },
          { agentId: "agent_b", agentName: "B" },
        ],
      },
    );
    expect(invalidateCalls).toEqual([
      {
        agentIds: ["agent_a", "agent_b"],
        environmentId: null,
        createdBy: USER,
      },
    ]);
  });

  it("shared-secret-delete cascades through the store helper (§11.4)", async () => {
    const deleted: Array<[string, string]> = [];
    const res = await handleSecretIntent(
      {
        ...base,
        intent: "shared-secret-delete",
        agentId: null,
        key: "GITHUB_TOKEN",
      },
      {
        ...deps,
        deleteShared: async (projectId, key) => {
          deleted.push([projectId, key]);
        },
      },
    );
    expect(res).toEqual({
      ok: true,
      deleted: { key: "GITHUB_TOKEN", environmentId: null },
    });
    expect(deleted).toEqual([[PROJECT, "GITHUB_TOKEN"]]);
  });

  it("shared-secret-expose-default flips only the shared default flag", async () => {
    await handleSecretIntent(
      {
        ...base,
        intent: "shared-secret-expose-default",
        agentId: null,
        key: "GITHUB_TOKEN",
        exposed: true,
      },
      deps,
    );
    expect(exposeCalls).toHaveLength(1);
    const [ref] = exposeCalls[0] as [{ agentId: string | null }];
    expect(ref.agentId).toBeNull();
  });
});

describe("computeRequiredSecrets (§9 missing computation, §11.6 multi-source)", () => {
  const lockSecrets = [
    {
      templateId: "cloudflare-app-builder",
      secrets: [
        {
          name: "CLOUDFLARE_API_TOKEN",
          description: "API token",
          sandbox: true,
        },
        { name: "GITHUB_TOKEN", description: "Repo access" },
      ],
    },
    {
      templateId: "cloudflare-deploy",
      secrets: [{ name: "CLOUDFLARE_API_TOKEN", sandbox: false }],
    },
  ];

  it("missing = required − (set ∪ attached ∪ dismissed)", () => {
    const { missing } = computeRequiredSecrets({
      lockSecrets,
      setNames: ["GITHUB_TOKEN"],
      attachedNames: [],
      dismissedNames: [],
    });
    expect(missing.map((m) => m.name)).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  it("an attached shared secret satisfies a requirement", () => {
    const { missing } = computeRequiredSecrets({
      lockSecrets,
      setNames: ["CLOUDFLARE_API_TOKEN"],
      attachedNames: ["GITHUB_TOKEN"],
      dismissedNames: [],
    });
    expect(missing).toEqual([]);
  });

  it("groups multi-source requirements with every template id (renders `+1`)", () => {
    const { missing } = computeRequiredSecrets({
      lockSecrets,
      setNames: [],
      attachedNames: [],
      dismissedNames: [],
    });
    const cf = missing.find((m) => m.name === "CLOUDFLARE_API_TOKEN");
    expect(cf?.sources).toEqual(["cloudflare-app-builder", "cloudflare-deploy"]);
    // sandbox true from ANY source pre-checks the box.
    expect(cf?.sandbox).toBe(true);
  });

  it("dismissed names are excluded from missing but reported separately", () => {
    const { missing, dismissed } = computeRequiredSecrets({
      lockSecrets,
      setNames: [],
      attachedNames: [],
      dismissedNames: ["GITHUB_TOKEN"],
    });
    expect(missing.map((m) => m.name)).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(dismissed.map((d) => d.name)).toEqual(["GITHUB_TOKEN"]);
  });

  it("a dismissed-then-set name never reappears as dismissed (satisfied wins)", () => {
    const { missing, dismissed } = computeRequiredSecrets({
      lockSecrets,
      setNames: ["GITHUB_TOKEN"],
      attachedNames: [],
      dismissedNames: ["GITHUB_TOKEN"],
    });
    expect(missing.map((m) => m.name)).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(dismissed).toEqual([]);
  });

  // Issue #47: provisioned secrets (GITHUB_APP_ID and friends) are set by the Create GitHub App
  // guided flow, never by the user — so they are never "missing" or "dismissed", but they DO stay
  // in `all` so the Deployment tab can detect which channel-setup card to show.
  describe("provisioned secrets (Issue #47)", () => {
    const provisionedLock = [
      {
        templateId: "github-channel",
        secrets: [
          { name: "GITHUB_APP_ID", provisioned: true },
          { name: "DISCORD_BOT_TOKEN", description: "Bot token" },
        ],
      },
    ];

    it("an unset provisioned secret is excluded from missing; a genuine unset one is not", () => {
      const { missing } = computeRequiredSecrets({
        lockSecrets: provisionedLock,
        setNames: [],
        attachedNames: [],
        dismissedNames: [],
      });
      expect(missing.map((m) => m.name)).toEqual(["DISCORD_BOT_TOKEN"]);
    });

    it("provisioned entries remain in `all` flagged (keeps Deployment-tab channel detection working)", () => {
      const { all } = computeRequiredSecrets({
        lockSecrets: provisionedLock,
        setNames: [],
        attachedNames: [],
        dismissedNames: [],
      });
      const gh = all.find((r) => r.name === "GITHUB_APP_ID");
      expect(gh?.provisioned).toBe(true);
    });

    it("provisioned ORs across sources — a plain declaration plus a provisioned one is excluded", () => {
      const { missing, all } = computeRequiredSecrets({
        lockSecrets: [
          { templateId: "a", secrets: [{ name: "GITHUB_APP_ID" }] },
          {
            templateId: "b",
            secrets: [{ name: "GITHUB_APP_ID", provisioned: true }],
          },
        ],
        setNames: [],
        attachedNames: [],
        dismissedNames: [],
      });
      expect(missing).toEqual([]);
      expect(all.find((r) => r.name === "GITHUB_APP_ID")?.provisioned).toBe(true);
    });

    it("a provisioned name in dismissedNames does not appear in dismissed", () => {
      const { dismissed } = computeRequiredSecrets({
        lockSecrets: provisionedLock,
        setNames: [],
        attachedNames: [],
        dismissedNames: ["GITHUB_APP_ID"],
      });
      expect(dismissed).toEqual([]);
    });
  });
});
