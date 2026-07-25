/**
 * The marketplace format + catalog seam (PRD §7.8, Milestone 6 phase 1).
 *
 * Three concerns:
 *  - the manifest schema enforces the format — above all it makes path traversal impossible,
 *    since these file paths are materialized into customer repos in phase 2;
 *  - the fixture catalog + the real seed never drift: every index row loads, its files match the
 *    manifest exactly, and the recorded content hash matches an INDEPENDENT recomputation here
 *    (the hash rule is re-implemented, not imported — that's the point of the check);
 *  - the fake catalog behaves like the real seams (round-trip, unknown id throws).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseManifest,
  templateManifestSchema,
  type TemplateManifest,
  type TemplateType,
} from "~/marketplace/manifest";
import {
  emptyLock,
  installKey,
  installedKeys,
  upsertInstall,
  type HarnesstLock,
  type InstallEntry,
} from "~/marketplace/lock";
import { resolveTemplate } from "~/marketplace/compose.server";
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";
import type { CatalogTemplate } from "~/seams/types";
import { fakeCatalog } from "../fakes/catalog";

const VALID: TemplateManifest = {
  id: "cloudflare-deploy",
  type: "tool",
  name: "Cloudflare Deploy",
  description: "Deploy a Worker.",
  version: "0.1.0",
  eve: ">=0.1.0",
  files: ["tools/cloudflare-deploy.ts"],
  dependencies: { wrangler: "^3.0.0" },
  secrets: [{ name: "CLOUDFLARE_API_TOKEN" }],
};

describe("manifest schema", () => {
  it("accepts a valid manifest", () => {
    expect(parseManifest(VALID)).toEqual(VALID);
  });

  it.each([
    ["../escape.ts", "parent traversal"],
    ["/etc/passwd", "absolute path"],
    ["a\\b.ts", "backslash"],
  ])("rejects path traversal: %s (%s)", (path) => {
    expect(() => parseManifest({ ...VALID, files: [path] })).toThrow();
  });

  it("rejects an empty files list", () => {
    expect(() => parseManifest({ ...VALID, files: [] })).toThrow();
  });

  it("accepts a bundle with no files of its own (pure composition — issue #42)", () => {
    const parsed = parseManifest({
      ...VALID,
      id: "chat-pack",
      type: "bundle",
      files: [],
      includes: [{ type: "channel", id: "discord" }],
    });
    expect(parsed.files).toEqual([]);
    expect(parsed.includes).toEqual([{ type: "channel", id: "discord" }]);
  });

  it("rejects a file-less bundle with no includes (it would install nothing)", () => {
    expect(() =>
      parseManifest({ ...VALID, type: "bundle", files: [], includes: [] }),
    ).toThrow();
  });

  it("rejects a non-semver version", () => {
    expect(() => parseManifest({ ...VALID, version: "1.0" })).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() => parseManifest({ ...VALID, type: "plugin" })).toThrow();
  });

  it("rejects a non-kebab id", () => {
    expect(() => parseManifest({ ...VALID, id: "Not Kebab" })).toThrow();
  });

  it("rejects a non-UPPER_SNAKE secret name", () => {
    expect(() =>
      parseManifest({ ...VALID, secrets: [{ name: "lower_case" }] }),
    ).toThrow();
  });

  it("preserves a secret's provisioned flag (set by a guided harnesst flow, not the wizard)", () => {
    const parsed = parseManifest({
      ...VALID,
      secrets: [{ name: "GITHUB_APP_ID", sandbox: true, provisioned: true }],
    });
    expect(parsed.secrets).toEqual([
      { name: "GITHUB_APP_ID", sandbox: true, provisioned: true },
    ]);
  });

  it("accepts optional fields via the schema directly", () => {
    const parsed = templateManifestSchema.parse({
      ...VALID,
      dependencies: undefined,
      secrets: undefined,
      model: "anthropic/claude-sonnet-5",
    });
    expect(parsed.model).toBe("anthropic/claude-sonnet-5");
  });

  it("strips the removed `connections` field (no longer part of the format, issue #30)", () => {
    const parsed = parseManifest({ ...VALID, connections: ["some-service"] });
    expect((parsed as Record<string, unknown>).connections).toBeUndefined();
  });

  it("accepts an auth descriptor on a connection template (issue #30)", () => {
    const parsed = parseManifest({
      ...VALID,
      id: "google-sheets",
      type: "connection",
      auth: {
        provider: "google",
        kind: "oauth2",
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      },
    });
    expect(parsed.auth).toEqual({
      provider: "google",
      kind: "oauth2",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  });

  it("rejects auth on a non-connection template", () => {
    expect(() =>
      parseManifest({
        ...VALID,
        type: "tool",
        auth: { provider: "google", kind: "oauth2", scopes: ["x"] },
      }),
    ).toThrow();
  });

  it("rejects an auth with an empty scopes list", () => {
    expect(() =>
      parseManifest({
        ...VALID,
        id: "google-sheets",
        type: "connection",
        auth: { provider: "google", kind: "oauth2", scopes: [] },
      }),
    ).toThrow();
  });

  it("accepts scope groups without baseline scopes (issue #165)", () => {
    const auth = {
      provider: "google",
      kind: "oauth2" as const,
      scopeGroups: [
        {
          id: "read",
          label: "Read mail",
          description: "Search and read messages.",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          default: true,
        },
        {
          id: "send",
          label: "Send mail",
          description: "Send messages as the connected account.",
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
        },
      ],
    };
    const parsed = parseManifest({
      ...VALID,
      id: "gmail",
      type: "connection",
      auth,
    });
    expect(parsed.auth).toEqual(auth);
  });

  it("rejects an auth with neither scopes nor scopeGroups (issue #165)", () => {
    expect(() =>
      parseManifest({
        ...VALID,
        id: "gmail",
        type: "connection",
        auth: { provider: "google", kind: "oauth2" },
      }),
    ).toThrow(/scopes, scopeGroups, or both/);
  });

  it("rejects duplicate scope group ids (issue #165)", () => {
    const group = {
      id: "read",
      label: "Read",
      description: "Read things.",
      scopes: ["scope-a"],
    };
    expect(() =>
      parseManifest({
        ...VALID,
        id: "gmail",
        type: "connection",
        auth: {
          provider: "google",
          kind: "oauth2",
          scopeGroups: [group, { ...group, scopes: ["scope-b"] }],
        },
      }),
    ).toThrow(/duplicate scope group id/);
  });

  it("rejects a scope group with an empty scopes list (issue #165)", () => {
    expect(() =>
      parseManifest({
        ...VALID,
        id: "gmail",
        type: "connection",
        auth: {
          provider: "google",
          kind: "oauth2",
          scopeGroups: [
            { id: "read", label: "Read", description: "Read.", scopes: [] },
          ],
        },
      }),
    ).toThrow();
  });
});

/**
 * The content-hash rule, re-implemented from marketplace/scripts/build-index.mjs. If either
 * drifts, the seed test below fails — which is exactly the guarantee we want.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function templateHash(t: CatalogTemplate): string {
  const parts = [stableStringify(t.manifest)];
  for (const path of Object.keys(t.files).sort()) {
    parts.push(`${path}\0${t.files[path]}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

describe("fixture catalog (the real in-repo seed)", () => {
  it("index parses and every entry's template loads, files match, hashes hold", async () => {
    const index = await fixtureCatalog.index();
    expect(index.templates.length).toBeGreaterThan(0);

    for (const entry of index.templates) {
      const template = await fixtureCatalog.template(entry.type, entry.id);

      // The loaded files map is EXACTLY the manifest's declared file set.
      expect(new Set(Object.keys(template.files))).toEqual(
        new Set(template.manifest.files),
      );

      // The recorded hash matches an independent recomputation — the seed hasn't drifted.
      expect(templateHash(template)).toBe(entry.hash);

      // The index row agrees with the manifest.
      expect(entry.name).toBe(template.manifest.name);
      expect(entry.version).toBe(template.manifest.version);

      for (const content of Object.values(template.files)) {
        if (content.includes("defineTool")) {
          expect(content).not.toMatch(/from\s+["']eve["']/);
        }
      }
    }
  });
});

describe("composition against the real seed", () => {
  it("resolves the engineer agent, materializing the bundled GitHub + Discord channels and send tool", async () => {
    const resolved = await resolveTemplate(fixtureCatalog, "agent", "engineer");

    // The GitHub + Discord channels and the outbound tool are flattened into the agent's file set.
    expect(new Set(Object.keys(resolved.files))).toEqual(
      new Set(resolved.manifest.files),
    );
    expect(Object.keys(resolved.files)).toContain("channels/github.ts");
    expect(Object.keys(resolved.files)).toContain("channels/discord.ts");
    expect(Object.keys(resolved.files)).toContain(
      "tools/discord-send-message.ts",
    );
    expect(resolved.files["channels/github.ts"]).toContain(
      'from "eve/channels/github"',
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      'from "eve/channels/discord"',
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "discordContinuationToken",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "renderInputRequestComponents",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "splitDiscordMessageContent",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      'async "input.requested"(event, channel)',
    );
    expect(resolved.files["channels/discord.ts"]).toMatch(
      /channel\.setContinuationToken\(\s*discordContinuationToken\(/,
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "discordContinuationToken(channel.discord.channelId, posted.id)",
    );
    // Issue #113: prose turns (no ask_question) park at wait: "next-user-message" with no
    // Discord reply path. The discord 0.3.2 channel posts a "Reply" button on session.waiting,
    // re-shapes the modal's sentinel answer into a message via a deliver wrapper, and tracks a
    // per-turn flag so the Reply button never clobbers a question's own button routing.
    expect(resolved.files["channels/discord.ts"]).toContain(
      'async "session.waiting"(event, channel)',
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "eve_input_freeform:eyJyZXF1ZXN0SWQiOiJlZGVuOnJlcGx5In0",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      'const EDEN_REPLY_REQUEST_ID = "eden:reply"',
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "r.requestId === EDEN_REPLY_REQUEST_ID",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "message: replies.map((r) => r.text).join",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "edenTurnAskedQuestion",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      'async "turn.started"(event, channel)',
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      "channel.discord.startTyping()",
    );
    // The send tool now proxies through harnesst's control plane (issue #32) — it reads the
    // injected send URL/token, not the shared bot token, and no longer imports eve's Discord.
    expect(resolved.files["tools/discord-send-message.ts"]).toContain(
      "EDEN_DISCORD_SEND_URL",
    );
    expect(resolved.files["tools/discord-send-message.ts"]).not.toContain(
      "sendDiscordChannelMessage",
    );

    // The GitHub App secrets (from the GitHub channel) and Discord's PROVISIONED secrets union
    // in. The bot token is never a per-agent secret (issue #32) — harnesst holds it control-plane-side.
    const secretNames = (resolved.manifest.secrets ?? []).map((s) => s.name);
    expect(secretNames).toEqual(
      expect.arrayContaining([
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_WEBHOOK_SECRET",
        "GITHUB_APP_SLUG",
        "DISCORD_APPLICATION_ID",
        "DISCORD_PUBLIC_KEY",
      ]),
    );
    expect(secretNames).not.toContain("GITHUB_TOKEN");
    expect(secretNames).not.toContain("DISCORD_BOT_TOKEN");

    // Provenance + hash lockstep: the parent's hash is its own index row; each include carries
    // its own index-row hash, in manifest order.
    const index = await fixtureCatalog.index();
    const engineerRow = index.templates.find(
      (t) => t.type === "agent" && t.id === "engineer",
    )!;
    const githubRow = index.templates.find(
      (t) => t.type === "channel" && t.id === "github",
    )!;
    const discordRow = index.templates.find(
      (t) => t.type === "channel" && t.id === "discord",
    )!;
    const discordToolRow = index.templates.find(
      (t) => t.type === "tool" && t.id === "discord-send-message",
    )!;
    const toolchainRow = index.templates.find(
      (t) => t.type === "skill" && t.id === "dev-toolchain",
    )!;
    expect(resolved.hash).toBe(engineerRow.hash);
    expect(resolved.includes).toEqual([
      {
        id: "github",
        type: "channel",
        name: "GitHub",
        version: githubRow.version,
        hash: githubRow.hash,
      },
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: discordRow.version,
        hash: discordRow.hash,
      },
      {
        id: "discord-send-message",
        type: "tool",
        name: "Discord Send Message",
        version: discordToolRow.version,
        hash: discordToolRow.hash,
      },
      {
        id: "dev-toolchain",
        type: "skill",
        name: "Developer toolchain",
        version: toolchainRow.version,
        hash: toolchainRow.hash,
      },
    ]);
  });
});

describe("fakeCatalog", () => {
  const tpl: CatalogTemplate = {
    manifest: VALID,
    files: { "tools/cloudflare-deploy.ts": "export default {};\n" },
  };
  const catalog = fakeCatalog([tpl]);

  it("round-trips index and template", async () => {
    const index = await catalog.index();
    expect(index.templates).toHaveLength(1);
    expect(index.templates[0].id).toBe("cloudflare-deploy");

    const loaded = await catalog.template("tool", "cloudflare-deploy");
    expect(loaded).toEqual(tpl);
  });

  it("throws on an unknown id", async () => {
    await expect(catalog.template("tool", "nope")).rejects.toThrow();
  });
});

/**
 * The "Installed" facet (issue #72). The data path — aggregating install keys across the org's
 * connected projects — can't be browser-exercised without a connected repo carrying an
 * `eden-lock.json`, so the pure identity/aggregation logic is covered thoroughly here.
 */
function installEntry(over: {
  id: string;
  type?: TemplateType;
  member?: string | null;
}): InstallEntry {
  return {
    id: over.id,
    type: over.type ?? "tool",
    name: over.id,
    version: "1.0.0",
    hash: "sha",
    registry: "fixture",
    member: over.member ?? null,
    files: [],
  };
}

describe("installKey", () => {
  it("joins type and id with a slash", () => {
    expect(installKey("tool", "web-search")).toBe("tool/web-search");
    expect(installKey("agent", "pm")).toBe("agent/pm");
  });
});

describe("installedKeys", () => {
  it("is empty for an empty lock", () => {
    expect(installedKeys(emptyLock())).toEqual([]);
  });

  it("returns a 'type/id' key per install", () => {
    let lock: HarnesstLock = emptyLock();
    lock = upsertInstall(lock, installEntry({ id: "web-search", type: "tool" }));
    lock = upsertInstall(lock, installEntry({ id: "pm", type: "agent" }));
    expect(installedKeys(lock).sort()).toEqual(["agent/pm", "tool/web-search"]);
  });

  it("returns one key per install for the same id under two members, and the caller dedupes by set", () => {
    // A team repo can host the same (type, id) under two members. `installedKeys` reports BOTH;
    // the marketplace loader collapses them via `new Set(...)` so the facet counts it once.
    const lock: HarnesstLock = {
      version: 1,
      installs: [
        installEntry({ id: "web-search", type: "tool", member: "pm" }),
        installEntry({ id: "web-search", type: "tool", member: "sales" }),
      ],
    };
    expect(installedKeys(lock)).toEqual(["tool/web-search", "tool/web-search"]);
    expect([...new Set(installedKeys(lock))]).toEqual(["tool/web-search"]);
  });
});

describe("installed filter predicate", () => {
  // Mirrors the browse component's `isInstalled` + the "installed"/"all" branch selection.
  const templates = [
    { type: "tool" as TemplateType, id: "web-search" },
    { type: "agent" as TemplateType, id: "pm" },
    { type: "skill" as TemplateType, id: "triage" },
  ];
  const installedSet = new Set(["tool/web-search", "skill/triage"]);
  const isInstalled = (t: { type: TemplateType; id: string }) =>
    installedSet.has(`${t.type}/${t.id}`);

  it("'installed' selects exactly the installed rows", () => {
    expect(templates.filter(isInstalled).map((t) => t.id)).toEqual([
      "web-search",
      "triage",
    ]);
  });

  it("'all' selects everything", () => {
    expect(templates.map((t) => t.id)).toEqual(["web-search", "pm", "triage"]);
  });
});
