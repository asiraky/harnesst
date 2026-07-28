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
  missingOwnedFiles,
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
 * Platform files are the ONE remaining ownership class a template declares (issue #254), and it is
 * declared by path convention alone — `harnesst/…` materializes beside the agent root, is rewritten
 * on every update, and is hash-verified at publish. The install-once field is gone: a marketplace
 * update overwrites every file a template ships, so there is nothing left for a manifest to say
 * about ownership.
 */
describe("manifest schema — platform files (issue #254)", () => {
  const CHANNEL: TemplateManifest = {
    ...VALID,
    id: "github",
    type: "channel",
    files: ["channels/github.ts", "harnesst/model-hooks.ts"],
  };

  it("accepts a platform file by path convention", () => {
    expect(parseManifest(CHANNEL).files).toContain("harnesst/model-hooks.ts");
  });

  it("ignores a stray installOnce field — the mechanism is gone, updates overwrite", () => {
    const parsed = parseManifest({
      ...CHANNEL,
      installOnce: ["channels/github.ts"],
    } as unknown as TemplateManifest);
    expect("installOnce" in parsed).toBe(false);
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

  // Authored skills must match the public eve shape: eve's discovery hard-errors on an unknown
  // frontmatter key, so a template shipping one (legal-advisor shipped Claude Code's
  // `disable-model-invocation`) installs fine and then fails the customer's next build at publish.
  // Same rule as catalog/scripts/validate.mjs — re-implemented here, not imported.
  it("every authored skill's frontmatter stays within the eve shape", async () => {
    const index = await fixtureCatalog.index();
    let checked = 0;

    for (const entry of index.templates) {
      const template = await fixtureCatalog.template(entry.type, entry.id);

      for (const [path, content] of Object.entries(template.files)) {
        // Mirrors eve's scan of agent/skills/: skills/<id>.md (flat, frontmatter optional) and
        // skills/<id>/SKILL.md (packaged, description required). Deeper paths are sibling files.
        const parts = path.split("/");
        const packaged = parts.length === 3 && parts[2] === "SKILL.md";
        const flat = parts.length === 2 && path.endsWith(".md");
        if (parts[0] !== "skills" || !(packaged || flat)) continue;
        checked++;

        const lines = content.split("\n");
        const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1;
        if (end === -1) {
          expect(flat, `${entry.id}: ${path} needs frontmatter`).toBe(true);
          continue;
        }
        const keys = lines
          .slice(1, end)
          .map((line) => /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1])
          .filter((key): key is string => Boolean(key));

        expect(keys, `${entry.id}: ${path} frontmatter`).toContain("description");
        const unknown = keys.filter((key) => key !== "name" && key !== "description");
        expect(unknown, `${entry.id}: ${path} frontmatter keys eve rejects`).toEqual([]);
      }
    }

    expect(checked).toBeGreaterThan(0);
  });
});

describe("composition against the real seed", () => {
  // The Google Sheets bundle is a real multi-include template, so it carries the composition
  // guarantee end to end: the resolved file set is exactly the union its manifest declares, the
  // parent's hash is its own index row, and every include reports its own index-row hash in
  // manifest order — the provenance the Settings drift check reads back out of the lock.
  it("resolves the Google Sheets bundle, materializing the connector and its usage skill", async () => {
    const resolved = await resolveTemplate(
      fixtureCatalog,
      "bundle",
      "google-sheets-bundle",
    );

    expect(new Set(Object.keys(resolved.files))).toEqual(
      new Set(resolved.manifest.files),
    );
    expect(Object.keys(resolved.files)).toContain(
      "connections/google-sheets.ts",
    );
    expect(Object.keys(resolved.files)).toContain(
      "data/google-sheets.openapi.json",
    );
    expect(Object.keys(resolved.files)).toContain("skills/google-sheets.md");

    // The connector's provisioned secrets union into the bundle, which declares none itself.
    const secretNames = (resolved.manifest.secrets ?? []).map((s) => s.name);
    expect(secretNames).toEqual(
      expect.arrayContaining([
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN",
      ]),
    );

    const index = await fixtureCatalog.index();
    const bundleRow = index.templates.find(
      (t) => t.type === "bundle" && t.id === "google-sheets-bundle",
    )!;
    const connectionRow = index.templates.find(
      (t) => t.type === "connection" && t.id === "google-sheets",
    )!;
    const skillRow = index.templates.find(
      (t) => t.type === "skill" && t.id === "google-sheets-skill",
    )!;
    expect(resolved.hash).toBe(bundleRow.hash);
    expect(resolved.includes).toEqual([
      {
        id: "google-sheets",
        type: "connection",
        name: "Google Sheets",
        version: connectionRow.version,
        hash: connectionRow.hash,
      },
      {
        id: "google-sheets-skill",
        type: "skill",
        name: "Google Sheets usage",
        version: skillRow.version,
        hash: skillRow.hash,
      },
    ]);
  });

  // The Discord channel's behaviour is pinned against the real seed file, not a fixture: these
  // are the exact strings a customer's repo receives, and every one of them is a bug we shipped.
  it("materializes the Discord channel with its question, reply and typing plumbing", async () => {
    const resolved = await resolveTemplate(fixtureCatalog, "channel", "discord");
    const source = resolved.files["channels/discord.ts"];

    expect(source).toContain('from "eve/channels/discord"');
    expect(source).toContain("discordContinuationToken");
    expect(source).toContain("renderInputRequestComponents");
    expect(source).toContain("splitDiscordMessageContent");
    expect(source).toContain('async "input.requested"(event, channel)');
    expect(source).toMatch(
      /channel\.setContinuationToken\(\s*discordContinuationToken\(/,
    );
    expect(source).toContain(
      "discordContinuationToken(channel.discord.channelId, posted.id)",
    );
    // Issue #113: prose turns (no ask_question) park at wait: "next-user-message" with no
    // Discord reply path. The discord 0.3.2 channel posts a "Reply" button on session.waiting,
    // re-shapes the modal's sentinel answer into a message via a deliver wrapper, and tracks a
    // per-turn flag so the Reply button never clobbers a question's own button routing.
    expect(source).toContain('async "session.waiting"(event, channel)');
    expect(source).toContain(
      "eve_input_freeform:eyJyZXF1ZXN0SWQiOiJlZGVuOnJlcGx5In0",
    );
    expect(source).toContain(
      'const HARNESST_REPLY_REQUEST_ID = "harnesst:reply"',
    );
    expect(source).toContain("r.requestId === HARNESST_REPLY_REQUEST_ID");
    expect(source).toContain("message: replies.map((r) => r.text).join");
    expect(source).toContain("harnesstTurnAskedQuestion");
    expect(source).toContain('async "turn.started"(event, channel)');
    expect(source).toContain("channel.discord.startTyping()");

    // PROVISIONED secrets only — the bot token is never a per-agent secret (issue #32), harnesst
    // holds it control-plane-side.
    const secretNames = (resolved.manifest.secrets ?? []).map((s) => s.name);
    expect(secretNames).toEqual(
      expect.arrayContaining(["DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY"]),
    );
    expect(secretNames).not.toContain("DISCORD_BOT_TOKEN");
  });

  it("materializes the send tool proxied through the control plane", async () => {
    const resolved = await resolveTemplate(
      fixtureCatalog,
      "tool",
      "discord-send-message",
    );
    const source = resolved.files["tools/discord-send-message.ts"];

    // The send tool proxies through harnesst's control plane (issue #32) — it reads the injected
    // send URL/token, not the shared bot token, and no longer imports eve's Discord.
    expect(source).toContain("HARNESST_DISCORD_SEND_URL");
    expect(source).not.toContain("sendDiscordChannelMessage");
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
 * `harnesst-lock.json`, so the pure identity/aggregation logic is covered thoroughly here.
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

describe("missingOwnedFiles", () => {
  // The Settings drift check compares the lock against the catalog manifest, which proves the lock
  // is complete and nothing about the tree. A managed file moved or deleted on disk — what a
  // hand-"fixed" install leaves behind — is only visible by comparing against the repo.
  const entry: InstallEntry = {
    ...installEntry({ id: "legal-advisor", type: "skill", member: "ivy" }),
    files: [
      "agents/ivy/agent/skills/legal-advisor/SKILL.md",
      "agents/ivy/agent/skills/legal-advisor/references/templates.md",
    ],
  };

  it("is empty when every owned file is in the tree", () => {
    expect(missingOwnedFiles(entry, new Set(entry.files))).toEqual([]);
  });

  it("names the owned file someone moved out from under the lock", () => {
    const present = new Set([
      "agents/ivy/agent/skills/legal-advisor/references/templates.md",
      // relocated by hand — the lock still claims the path above
      "agents/ivy/agent/skills/legal-advisor.md",
    ]);
    expect(missingOwnedFiles(entry, present)).toEqual([
      "agents/ivy/agent/skills/legal-advisor/SKILL.md",
    ]);
  });

  it("treats a staged install as intact — its files are drafts, and drafts are in `present`", () => {
    // The loader folds staged drafts into `present`, so an install whose change-set is not yet
    // published is not reported as drifted.
    expect(missingOwnedFiles(entry, new Set(entry.files))).toEqual([]);
    expect(missingOwnedFiles(entry, new Set())).toEqual(entry.files);
  });
});

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
