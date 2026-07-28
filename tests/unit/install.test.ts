/**
 * The install planner + lock format (PRD §7.8, Milestone 6 phase 2).
 *
 * All against literals, no I/O: the planner takes plain data by design (app/marketplace/
 * install.server.ts), so path mapping, the dependency conflict policy, update-vs-conflict, and
 * the lock round-trip are each pinned here. If the planner's rules drift, these fail — which is
 * the point: install materializes files into customer repos, so its decisions need teeth.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  installedFilePath,
  planInstall,
  planUninstall,
  type PlanContext,
} from "~/marketplace/install.server";
import { platformPathsUnderCheck } from "~/marketplace/platform";
import {
  channelIdsForEntry,
  channelSettings,
  emptyLock,
  findInstall,
  parseLock,
  removeInstall,
  requiredScopesByProvider,
  serializeLock,
  setChannelSettings,
  upsertInstall,
  type HarnesstLock,
  type InstallEntry,
} from "~/marketplace/lock";
import type { ResolvedAuth } from "~/marketplace/compose.server";
import type { CatalogTemplate } from "~/seams/types";

const REGISTRY = "fixture";

/** A tool template: one file, one dependency, one secret. */
const toolTpl: CatalogTemplate = {
  manifest: {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    description: "Deploy a Worker.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
    secrets: [
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ],
  },
  files: { "tools/cloudflare-deploy.ts": "export default {};\n" },
};

/** An agent template: instructions + module + a tool, two deps. */
const agentTpl: CatalogTemplate = {
  manifest: {
    id: "cloudflare-deployment-engineer",
    type: "agent",
    name: "Cloudflare Deployment Engineer",
    description: "Deploys workers.",
    version: "0.1.0",
    eve: ">=0.1.0",
    model: "anthropic/claude-sonnet-5",
    files: ["instructions.md", "agent.ts", "tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
  },
  files: {
    "instructions.md": "# Engineer\n",
    "agent.ts": "export default {};\n",
    "tools/cloudflare-deploy.ts": "export default {};\n",
  },
};

const browserSkillTpl: CatalogTemplate = {
  manifest: {
    id: "agent-browser",
    type: "skill",
    name: "Agent Browser",
    description: "Browser automation.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["skills/agent-browser.md"],
    sandbox: {
      bootstrap: [
        'if ! command -v chromium >/dev/null; then echo "deb [arch=$(dpkg --print-architecture) trusted=yes] http://deb.debian.org/debian trixie main" > /etc/apt/sources.list.d/debian-trixie.list && printf "Package: *\\nPin: release n=trixie\\nPin-Priority: 100\\n" > /etc/apt/preferences.d/debian-trixie && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; fi',
        "npm install -g agent-browser@0.31.1",
        "AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium agent-browser --version",
      ],
      env: {
        AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        AGENT_BROWSER_PROFILE: "/workspace/home/agent-browser/profile",
      },
      revalidationKey: "agent-browser@0.31.1-chromium-debian-trixie",
    },
  },
  files: { "skills/agent-browser.md": "# Agent Browser\n" },
};

function pkg(deps: Record<string, string>): string {
  return (
    JSON.stringify(
      {
        name: "pm",
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
        dependencies: deps,
      },
      null,
      2,
    ) + "\n"
  );
}

/** A member-target context for the tool template, with overridable bits. */
function memberCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    template: toolTpl,
    registry: REGISTRY,
    repoPaths: [],
    drafts: [],
    packageJson: pkg({ zod: "^3.23.0" }),
    lock: emptyLock(),
    target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
    ...over,
  };
}

describe("planInstall — path mapping", () => {
  it("maps a tool into an existing member's agent root", () => {
    const plan = planInstall(memberCtx());
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/pm/agent/tools/cloudflare-deploy.ts");
    expect(paths).toContain("harnesst-lock.json");
    expect(plan.conflicts).toEqual([]);
    expect(plan.isUpdate).toBe(false);
    expect(plan.secrets).toEqual([
      // sandbox rides through so the wizard can flip the exposure flag on install.
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ]);
  });

  it("maps a single-agent (null member) tool into the root agent", () => {
    const plan = planInstall(
      memberCtx({
        packageJson: null,
        target: { kind: "member", memberName: null, root: "agent" },
      }),
    );
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agent/tools/cloudflare-deploy.ts");
    // No package.json existed → a fresh one is written at the repo root, carrying the dep.
    expect(paths).toContain("package.json");
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    expect(
      findInstall(
        parseLock(JSON.parse(lockWrite.content)),
        "cloudflare-deploy",
        null,
      ),
    ).toBeDefined();
  });

  it("maps an agent into a NEW team member with a generated package.json", () => {
    const plan = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "deployer" },
    });
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/deployer/agent/instructions.md");
    expect(paths).toContain("agents/deployer/agent/agent.ts");
    expect(paths).toContain("agents/deployer/agent/tools/cloudflare-deploy.ts");
    expect(paths).toContain("agents/deployer/package.json");
    expect(plan.conflicts).toEqual([]);

    const gen = JSON.parse(
      plan.writes.find((w) => w.path === "agents/deployer/package.json")!
        .content,
    );
    expect(gen.name).toBe("deployer");
    expect(gen.type).toBe("module");
    // Scaffold deps merged with the template's.
    expect(gen.dependencies).toEqual({
      eve: "latest",
      wrangler: "^3.0.0",
      zod: "^4.4.3",
    });

    // The lock records final paths, EXCLUDING the generated package.json.
    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
        ),
      ),
      "cloudflare-deployment-engineer",
      "deployer",
    )!;
    expect(entry.files).toEqual([
      "agents/deployer/agent/agent.ts",
      "agents/deployer/agent/instructions.md",
      "agents/deployer/agent/tools/cloudflare-deploy.ts",
    ]);
  });

  it("writes the supplied qualified model into new and existing agent templates only", () => {
    const model = "anthropic/abcdefghijkl/claude-sonnet-4-5";
    const newMember = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      model,
      target: { kind: "new-member", name: "deployer" },
    });
    expect(
      newMember.writes.find(
        (write) => write.path === "agents/deployer/agent/agent.ts",
      )?.content,
    ).toContain(`harnesstModel('${model}')`);
    expect(
      JSON.parse(
        newMember.writes.find(
          (write) => write.path === "agents/deployer/package.json",
        )!.content,
      ).dependencies,
    ).toMatchObject({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      zod: "^4.4.3",
    });

    const existingMember = planInstall(
      memberCtx({
        template: agentTpl,
        model,
      }),
    );
    expect(
      existingMember.writes.find(
        (write) => write.path === "agents/pm/agent/agent.ts",
      )?.content,
    ).toContain(`harnesstModel('${model}')`);
    expect(
      JSON.parse(
        existingMember.writes.find(
          (write) => write.path === "agents/pm/package.json",
        )!.content,
      ).dependencies,
    ).toMatchObject({
      "@ai-sdk/anthropic": "^4.0.12",
      "@ai-sdk/openai": "^4.0.11",
      "@ai-sdk/openai-compatible": "^3.0.7",
      zod: "^4.4.3",
    });

    const tool = planInstall(memberCtx({ model }));
    expect(
      tool.writes.find((write) =>
        write.path.endsWith("tools/cloudflare-deploy.ts"),
      )?.content,
    ).toBe("export default {};\n");
  });
});

describe("planInstall — lock secrets snapshot (§4.5)", () => {
  it("records manifest secrets in the lock entry so requirements survive forever", () => {
    const plan = planInstall(memberCtx());
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "cloudflare-deploy",
      "pm",
    )!;
    expect(entry.secrets).toEqual([
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ]);
    // Values NEVER touch the plan or the lock.
    expect(lockWrite.content).not.toMatch(/value|ciphertext/i);
  });

  it("omits the secrets field entirely for templates that declare none", () => {
    const plan = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "deployer" },
    });
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "cloudflare-deployment-engineer",
      "deployer",
    )!;
    expect(entry.secrets).toBeUndefined();
  });

  it("old locks without the field parse fine and produce no required rows", () => {
    const legacy = {
      version: 1,
      installs: [
        {
          id: "x",
          type: "tool",
          name: "X",
          version: "0.1.0",
          hash: "abc",
          registry: "fixture",
          member: null,
          files: ["agent/tools/x.ts"],
        },
      ],
    };
    const lock = parseLock(legacy);
    expect(lock.installs[0].secrets).toBeUndefined();
  });
});

/** A connection template with an OAuth descriptor — resolves to `auths` (issue #30). */
const sheetsConnTpl: CatalogTemplate & { auths?: ResolvedAuth[] } = {
  manifest: {
    id: "google-sheets",
    type: "connection",
    name: "Google Sheets",
    description: "Read and write spreadsheets.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["connections/google-sheets.ts"],
    auth: {
      provider: "google",
      kind: "oauth2",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    },
  },
  files: { "connections/google-sheets.ts": "export default {};\n" },
  auths: [
    {
      templateId: "google-sheets",
      provider: "google",
      kind: "oauth2",
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    },
  ],
};

describe("planInstall — lock auth snapshot (issue #30)", () => {
  it("records the resolved template's auths (provider/kind/scopes) in the lock entry", () => {
    const plan = planInstall(
      memberCtx({
        template: sheetsConnTpl,
        target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
      }),
    );
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "google-sheets",
      "pm",
    )!;
    expect(entry.auth).toEqual([
      {
        provider: "google",
        kind: "oauth2",
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      },
    ]);
  });

  it("falls back to a plain template's manifest.auth when no resolved auths are present", () => {
    const { auths: _drop, ...plain } = sheetsConnTpl;
    const plan = planInstall(
      memberCtx({
        template: plain,
        target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
      }),
    );
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "google-sheets",
      "pm",
    )!;
    expect(entry.auth).toEqual([
      {
        provider: "google",
        kind: "oauth2",
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      },
    ]);
  });

  it("omits the auth field for templates that declare none", () => {
    const plan = planInstall(memberCtx());
    const lockWrite = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "cloudflare-deploy",
      "pm",
    )!;
    expect(entry.auth).toBeUndefined();
  });
});

describe("requiredScopesByProvider (issue #30)", () => {
  const authEntry = (
    over: Partial<InstallEntry> & { auth?: InstallEntry["auth"] },
  ): InstallEntry => ({
    id: "x",
    type: "connection",
    name: "X",
    version: "0.1.0",
    hash: "h",
    registry: REGISTRY,
    member: null,
    files: [],
    ...over,
  });

  it("unions and dedupes scopes across installs for the same member/provider, sorted", () => {
    const lock: HarnesstLock = {
      version: 1,
      installs: [
        authEntry({
          id: "a",
          member: "pm",
          auth: [
            {
              provider: "google",
              kind: "oauth2",
              scopes: [
                "https://www.googleapis.com/auth/spreadsheets",
                "openid",
              ],
            },
          ],
        }),
        authEntry({
          id: "b",
          member: "pm",
          auth: [
            {
              provider: "google",
              kind: "oauth2",
              scopes: ["openid", "https://www.googleapis.com/auth/drive"],
            },
          ],
        }),
      ],
    };
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([
        [
          "google",
          [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/spreadsheets",
            "openid",
          ],
        ],
      ]),
    );
  });

  it("filters by member — a different member's scopes don't leak in", () => {
    const lock: HarnesstLock = {
      version: 1,
      installs: [
        authEntry({
          member: "pm",
          auth: [{ provider: "google", kind: "oauth2", scopes: ["a"] }],
        }),
        authEntry({
          member: "eng",
          auth: [{ provider: "google", kind: "oauth2", scopes: ["b"] }],
        }),
      ],
    };
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", ["a"]]]),
    );
  });

  it("is empty when installs carry no auth snapshot (old locks)", () => {
    const lock: HarnesstLock = {
      version: 1,
      installs: [authEntry({ member: "pm" })],
    };
    expect(requiredScopesByProvider(lock, "pm").size).toBe(0);
  });
});

describe("planInstall — sandbox setup", () => {
  it("materializes a marketplace sandbox add-on and managed sandbox module", () => {
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/pm/agent/skills/agent-browser.md");
    expect(paths).toContain("agents/pm/agent/sandbox/addons/agent-browser.ts");
    expect(paths).toContain("agents/pm/agent/sandbox/sandbox.ts");

    const addon = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/addons/agent-browser.ts",
    )!.content;
    expect(addon).toContain("npm install -g agent-browser@0.31.1");
    expect(addon).toContain(
      "apt-get install -y --no-install-recommends chromium",
    );
    expect(addon).toContain("AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium");

    const sandbox = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
    )!.content;
    expect(sandbox).toContain(
      'import * as addon0 from "./addons/agent-browser";',
    );
    expect(sandbox).toContain("HARNESST_SANDBOX_ENV");
    expect(sandbox).toContain(
      "defaultBackend({ docker: { env }, vercel: { env } })",
    );

    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
        ),
      ),
      "agent-browser",
      "pm",
    )!;
    expect(entry.files).toEqual([
      "agents/pm/agent/sandbox/addons/agent-browser.ts",
      "agents/pm/agent/skills/agent-browser.md",
    ]);
    expect(entry.sandbox?.revalidationKey).toBe(
      "agent-browser@0.31.1-chromium-debian-trixie",
    );
  });

  it("updates the managed sandbox module with all installed add-ons for the member", () => {
    const priorPlan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const priorLock = parseLock(
      JSON.parse(
        priorPlan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    const cloudflareSkill: CatalogTemplate = {
      manifest: {
        id: "cloudflare-cli",
        type: "skill",
        name: "Cloudflare CLI",
        description: "Cloudflare CLI.",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["skills/cloudflare-cli.md"],
        sandbox: {
          bootstrap: ["npm install -g wrangler@latest"],
          revalidationKey: "wrangler@latest",
        },
      },
      files: { "skills/cloudflare-cli.md": "# Cloudflare CLI\n" },
    };
    const plan = planInstall(
      memberCtx({
        template: cloudflareSkill,
        packageJson: null,
        lock: priorLock,
      }),
    );
    const sandbox = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
    )!.content;
    expect(sandbox).toContain(
      'import * as addon0 from "./addons/agent-browser";',
    );
    expect(sandbox).toContain(
      'import * as addon1 from "./addons/cloudflare-cli";',
    );
    expect(sandbox).toContain("const addons = [addon0, addon1];");
  });
});

describe("planInstall — dependency merge policy", () => {
  it("adds a dependency the package doesn't have", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ zod: "^3.23.0" }) }),
    );
    const pkgWrite = plan.writes.find(
      (w) => w.path === "agents/pm/package.json",
    )!;
    expect(pkgWrite).toBeDefined();
    expect(JSON.parse(pkgWrite.content).dependencies).toEqual({
      wrangler: "^3.0.0",
      zod: "^3.23.0",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("keeps an intersecting existing range silently (no churn, no warning)", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ wrangler: "^3.1.0" }) }),
    );
    expect(plan.writes.some((w) => w.path === "agents/pm/package.json")).toBe(
      false,
    );
    expect(plan.warnings).toEqual([]);
  });

  it("warns and keeps the agent's range when ranges are disjoint", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ wrangler: "^2.0.0" }) }),
    );
    expect(plan.writes.some((w) => w.path === "agents/pm/package.json")).toBe(
      false,
    );
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("wrangler");
    expect(plan.warnings[0]).toContain("^2.0.0");
    expect(plan.warnings[0]).toContain("^3.0.0");
  });

  it('treats a "latest" pin as satisfying any wanted range (no conflict warning)', () => {
    // Scaffolded members pin `eve: "latest"`; catalog templates now want `eve: "^0.22.0"` —
    // "latest" resolves to the newest release, so that must merge silently, not warn.
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ wrangler: "latest" }) }),
    );
    expect(plan.writes.some((w) => w.path === "agents/pm/package.json")).toBe(
      false,
    );
    expect(plan.warnings).toEqual([]);
  });
});

describe("planInstall — conflicts", () => {
  it("flags a target path that already exists on the branch", () => {
    const plan = planInstall(
      memberCtx({ repoPaths: ["agents/pm/agent/tools/cloudflare-deploy.ts"] }),
    );
    expect(plan.conflicts).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
    expect(plan.canKeepExistingFiles).toBe(true);
  });

  it("flags a target path occupied by a staged (non-deletion) draft", () => {
    const plan = planInstall(
      memberCtx({
        drafts: [
          {
            path: "agents/pm/agent/tools/cloudflare-deploy.ts",
            content: "mine\n",
          },
        ],
      }),
    );
    expect(plan.conflicts).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
    expect(plan.canKeepExistingFiles).toBe(true);
  });

  it("does NOT flag a path with only a staged deletion draft", () => {
    const plan = planInstall(
      memberCtx({
        drafts: [
          { path: "agents/pm/agent/tools/cloudflare-deploy.ts", content: null },
        ],
      }),
    );
    expect(plan.conflicts).toEqual([]);
  });

  it("a staged deletion frees a path that still exists at HEAD", () => {
    // Delete-then-install: the operator removes a hand-authored, unowned add-on so the
    // marketplace can own it. Drafts are newer than HEAD, so the deletion must win — otherwise
    // the install conflicts, gets registered with "keep existing files", and the lock claims a
    // file the drafts are removing (an UNRESOLVED_IMPORT in the regenerated sandbox module).
    const addon = "agents/pm/agent/sandbox/addons/agent-browser.ts";
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
        repoPaths: [addon, "agents/pm/agent/sandbox/sandbox.ts"],
        drafts: [{ path: addon, content: null }],
      }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([]);
    // The install writes its OWN content there…
    expect(plan.writes.some((w) => w.path === addon)).toBe(true);
    // …and the lock owns it, so the regenerated module's import resolves.
    const lock = parseLock(
      JSON.parse(plan.writes.find((w) => w.path === "harnesst-lock.json")!.content),
    );
    expect(findInstall(lock, "agent-browser", "pm")!.files).toContain(addon);
    expect(
      plan.writes.find((w) => w.path === "agents/pm/agent/sandbox/sandbox.ts")!
        .content,
    ).toContain('from "./addons/agent-browser"');
  });

  it("a staged WRITE over a HEAD file still occupies the path", () => {
    const path = "agents/pm/agent/tools/cloudflare-deploy.ts";
    const plan = planInstall(
      memberCtx({ repoPaths: [path], drafts: [{ path, content: "mine\n" }] }),
    );
    expect(plan.conflicts).toEqual([path]);
  });

  it("regenerates the managed sandbox module when the hand-authored one is staged for deletion", () => {
    const sandboxPath = "agents/pm/agent/sandbox/sandbox.ts";
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
        repoPaths: [sandboxPath],
        drafts: [{ path: sandboxPath, content: null }],
        keepExistingFiles: true,
      }),
    );
    // Nothing is left to preserve, so the sandbox bootstrap gets wired in as normal.
    const module = plan.writes.find((w) => w.path === sandboxPath);
    expect(module?.content).toContain('from "./addons/agent-browser"');
    expect(
      plan.warnings.some((w) => w.includes(sandboxPath) && w.includes("bootstrap")),
    ).toBe(false);
  });

  it("never treats package.json or harnesst-lock.json as a conflict (they merge)", () => {
    const plan = planInstall(
      memberCtx({
        repoPaths: ["agents/pm/package.json", "harnesst-lock.json"],
        packageJson: pkg({ zod: "^3.23.0" }),
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.some((w) => w.path === "harnesst-lock.json")).toBe(true);
  });

  it("registers around an existing code-authored connection without owning or rewriting it", () => {
    const path = "agents/pm/agent/connections/google-sheets.ts";
    const plan = planInstall(
      memberCtx({
        template: sheetsConnTpl,
        repoPaths: [path],
        keepExistingFiles: true,
      }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([path]);
    expect(plan.writes.some((write) => write.path === path)).toBe(false);

    const lock = parseLock(
      JSON.parse(plan.writes.find((w) => w.path === "harnesst-lock.json")!.content),
    );
    const entry = findInstall(lock, "google-sheets", "pm")!;
    expect(entry.files).toEqual([]);
    expect(entry.auth).toEqual([
      {
        provider: "google",
        kind: "oauth2",
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      },
    ]);
    expect(
      planUninstall({
        lock,
        id: "google-sheets",
        memberName: "pm",
        repoPaths: [path],
      }).deletions,
    ).toEqual([]);
  });

  it("keeps occupied files but still installs missing template files", () => {
    const existingPath = "agents/pm/agent/instructions.md";
    const missingPath = "agents/pm/agent/agent.ts";
    const plan = planInstall(
      memberCtx({
        template: {
          ...agentTpl,
          manifest: {
            ...agentTpl.manifest,
            files: ["instructions.md", "agent.ts"],
          },
        },
        repoPaths: [existingPath],
        keepExistingFiles: true,
      }),
    );

    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([existingPath]);
    expect(plan.writes.some((write) => write.path === existingPath)).toBe(
      false,
    );
    expect(plan.writes.some((write) => write.path === missingPath)).toBe(true);
    const lock = parseLock(
      JSON.parse(plan.writes.find((w) => w.path === "harnesst-lock.json")!.content),
    );
    expect(findInstall(lock, agentTpl.manifest.id, "pm")!.files).toEqual([
      missingPath,
    ]);
  });

  it("does not let keep-existing bypass a malformed package.json", () => {
    const path = "agents/pm/agent/tools/cloudflare-deploy.ts";
    const plan = planInstall(
      memberCtx({
        repoPaths: [path],
        packageJson: "{ not json",
        keepExistingFiles: true,
      }),
    );

    expect(plan.preservedFiles).toEqual([path]);
    expect(plan.conflicts).toEqual([
      "agents/pm/package.json is not valid JSON — fix it before installing.",
    ]);
    expect(plan.canKeepExistingFiles).toBe(false);
  });

  it("preserves a draft-occupied (not repo-occupied) path in keep-existing mode", () => {
    const path = "agents/pm/agent/tools/cloudflare-deploy.ts";
    const plan = planInstall(
      memberCtx({
        drafts: [{ path, content: "mine\n" }],
        keepExistingFiles: true,
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([path]);
    expect(plan.writes.some((w) => w.path === path)).toBe(false);
  });

  it("keeps a hand-authored sandbox module in keep-existing mode instead of overwriting it", () => {
    const sandboxPath = "agents/pm/agent/sandbox/sandbox.ts";
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        // Only the managed sandbox module pre-exists; the skill file is genuinely new.
        repoPaths: [sandboxPath],
        keepExistingFiles: true,
      }),
    );
    // The hand-authored module harnesst never managed must not be clobbered…
    expect(plan.writes.some((w) => w.path === sandboxPath)).toBe(false);
    // …and the missing skill file still stages.
    expect(
      plan.writes.some((w) => w.path === "agents/pm/agent/skills/agent-browser.md"),
    ).toBe(true);
    expect(
      plan.warnings.some((w) => w.includes(sandboxPath) && w.includes("bootstrap")),
    ).toBe(true);
  });

  it("still blocks a new-member orphan package.json even with keepExistingFiles", () => {
    const plan = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      // A half-deleted member left its package.json behind; a fresh member CREATE must not clobber it.
      repoPaths: ["agents/ghost/package.json"],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: [],
      model: "anthropic/claude-sonnet-5",
      target: { kind: "new-member", name: "ghost" },
      keepExistingFiles: true,
    });
    expect(plan.conflicts).toEqual(["agents/ghost/package.json"]);
    // A new-member target can never register-around occupied paths.
    expect(plan.canKeepExistingFiles).toBe(false);
    expect(plan.preservedFiles).toEqual([]);
  });

  it("a later update RECLAIMS a registered template-shipped path instead of blocking on it", () => {
    const path = "agents/pm/agent/connections/google-sheets.ts";
    // First: register around the existing file, producing a lock entry that records the path.
    const registered = planInstall(
      memberCtx({
        template: sheetsConnTpl,
        repoPaths: [path],
        keepExistingFiles: true,
      }),
    );
    const lock = parseLock(
      JSON.parse(
        registered.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    expect(findInstall(lock, "google-sheets", "pm")!.preservedFiles).toEqual([
      path,
    ]);

    // Then: an update (a Settings repair re-plans the same way, WITHOUT keepExistingFiles).
    // Preservation guards the first install only — the template ships this path, so the update
    // overwrites the kept file and owns it from here on. Never a blocking conflict either way:
    // the update must not hard-fail on the very file the register step recorded.
    const updated = planInstall(
      memberCtx({
        template: sheetsConnTpl,
        repoPaths: [path],
        lock,
      }),
    );
    expect(updated.conflicts).toEqual([]);
    expect(updated.preservedFiles).toEqual([]);
    expect(updated.writes.some((w) => w.path === path)).toBe(true);
    const nextLock = parseLock(
      JSON.parse(
        updated.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    const entry = findInstall(nextLock, "google-sheets", "pm")!;
    expect(entry.files).toEqual([path]);
    expect(entry.preservedFiles).toBeUndefined();
  });

  it("keeps preserving a registered path the incoming template does NOT ship", () => {
    const path = "agents/pm/agent/connections/google-sheets.ts";
    const registered = planInstall(
      memberCtx({
        template: sheetsConnTpl,
        repoPaths: [path],
        keepExistingFiles: true,
      }),
    );
    const lock = parseLock(
      JSON.parse(
        registered.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );

    // The next version renames its module, so the registered path is no longer a template write.
    // The registration outlives the rename: the file is neither overwritten nor deleted, and the
    // rebuilt entry still records it — dropping the record would turn the update after THIS one
    // into a conflict on a file the first install promised to leave alone.
    const renamed = planInstall(
      memberCtx({
        template: {
          ...sheetsConnTpl,
          manifest: {
            ...sheetsConnTpl.manifest,
            version: "0.2.0",
            files: ["connections/google-sheets-v2.ts"],
          },
          files: { "connections/google-sheets-v2.ts": "export default {};\n" },
        },
        repoPaths: [path],
        lock,
      }),
    );
    expect(renamed.conflicts).toEqual([]);
    expect(renamed.writes.some((w) => w.path === path)).toBe(false);
    expect(renamed.deletions).not.toContain(path);
    const nextLock = parseLock(
      JSON.parse(
        renamed.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    expect(
      findInstall(nextLock, "google-sheets", "pm")!.preservedFiles,
    ).toEqual([path]);
  });
});

describe("planInstall — update mode", () => {
  it("reinstalling the same id+member overwrites and deletes dropped files", () => {
    const prior: InstallEntry = {
      id: "cloudflare-deploy",
      type: "tool",
      name: "Cloudflare Deploy",
      version: "0.0.9",
      hash: "old",
      registry: REGISTRY,
      member: "pm",
      files: [
        "agents/pm/agent/tools/cloudflare-deploy.ts",
        "agents/pm/agent/tools/legacy.ts",
      ],
      dependencies: { wrangler: "^3.0.0" },
    };
    const lock = upsertInstall(emptyLock(), prior);
    const plan = planInstall(
      memberCtx({
        lock,
        repoPaths: [
          "agents/pm/agent/tools/cloudflare-deploy.ts",
          "agents/pm/agent/tools/legacy.ts",
        ],
      }),
    );
    expect(plan.isUpdate).toBe(true);
    // Owning our own files is not a conflict.
    expect(plan.conflicts).toEqual([]);
    // The old version's dropped file is scheduled for deletion.
    expect(plan.deletions).toEqual(["agents/pm/agent/tools/legacy.ts"]);
  });
});

describe("planInstall — new-member validation", () => {
  const base = {
    template: agentTpl,
    registry: REGISTRY,
    repoPaths: [] as string[],
    drafts: [],
    packageJson: null,
    lock: emptyLock(),
  };

  it("rejects a name already in the roster", () => {
    const plan = planInstall({
      ...base,
      rosterNames: ["pm", "deployer"],
      target: { kind: "new-member", name: "deployer" },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("deployer");
  });

  it("rejects an invalid (non-slug) name", () => {
    const plan = planInstall({
      ...base,
      rosterNames: [],
      target: { kind: "new-member", name: "Not Valid" },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("valid agent name");
  });

  it("flags an orphan package.json already at the new member's path", () => {
    // A half-deleted member leaves agents/<name>/package.json with no agent/ dir — the roster
    // misses it, but the generated package.json is a CREATE and must not clobber it silently.
    const plan = planInstall({
      ...base,
      rosterNames: [],
      repoPaths: ["agents/deployer/package.json"],
      target: { kind: "new-member", name: "deployer" },
    });
    expect(plan.conflicts).toEqual(["agents/deployer/package.json"]);
  });
});

describe("planInstall — malformed package.json", () => {
  it("is a blocking conflict, not a crash", () => {
    const plan = planInstall(memberCtx({ packageJson: "{ not json" }));
    expect(plan.conflicts).toEqual([
      "agents/pm/package.json is not valid JSON — fix it before installing.",
    ]);
    // No package.json write is staged; the template file + lock writes still plan fine.
    expect(plan.writes.map((w) => w.path)).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
      "harnesst-lock.json",
    ]);
  });
});

describe("planInstall — resolved (composed) templates", () => {
  /** A flattened agent template as compose.server.ts hands it to the planner: extra hash + includes. */
  const resolvedEngineer: CatalogTemplate & {
    hash?: string;
    includes?: Array<{
      id: string;
      type: "channel";
      name: string;
      version: string;
      hash: string;
    }>;
  } = {
    manifest: {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      description: "Ships code.",
      version: "0.2.0",
      eve: ">=0.1.0",
      // The channel's file is flattened in alongside the agent's own files.
      files: ["channels/discord.ts", "agent.ts", "instructions.md"],
      secrets: [{ name: "DISCORD_BOT_TOKEN", description: "bot token" }],
    },
    files: {
      "channels/discord.ts": "export default {};\n",
      "agent.ts": "export default {};\n",
      "instructions.md": "# Engineer\n",
    },
    hash: "parent-own-hash",
    includes: [
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: "discord-own-hash",
      },
    ],
  };

  it("records the PROVIDED hash + includes and lands every flattened file under the member dir", () => {
    const plan = planInstall({
      template: resolvedEngineer,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "eng" },
    });
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/eng/agent/channels/discord.ts");
    expect(paths).toContain("agents/eng/agent/agent.ts");
    expect(paths).toContain("agents/eng/agent/instructions.md");

    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
        ),
      ),
      "engineer",
      "eng",
    )!;
    // The resolver-supplied hash is used verbatim (not recomputed over the flattened template).
    expect(entry.hash).toBe("parent-own-hash");
    expect(entry.includes).toEqual([
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: "discord-own-hash",
      },
    ]);
  });

  it("update dropping an include stages the dropped included file for deletion", () => {
    const prior: InstallEntry = {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      version: "0.1.0",
      hash: "old",
      registry: REGISTRY,
      member: "eng",
      files: [
        "agents/eng/agent/agent.ts",
        "agents/eng/agent/channels/discord.ts",
        "agents/eng/agent/instructions.md",
      ],
      includes: [
        {
          id: "discord",
          type: "channel",
          name: "Discord",
          version: "0.1.0",
          hash: "discord-own-hash",
        },
      ],
    };
    // The new resolved version no longer includes Discord — its file is gone from the flatten.
    const noDiscord: CatalogTemplate & { hash?: string } = {
      manifest: {
        id: "engineer",
        type: "agent",
        name: "Engineer",
        description: "Ships code.",
        version: "0.2.0",
        eve: ">=0.1.0",
        files: ["agent.ts", "instructions.md"],
      },
      files: {
        "agent.ts": "export default {};\n",
        "instructions.md": "# Engineer\n",
      },
      hash: "new-own-hash",
    };
    const plan = planInstall({
      template: noDiscord,
      registry: REGISTRY,
      repoPaths: prior.files,
      drafts: [],
      packageJson: null,
      lock: upsertInstall(emptyLock(), prior),
      target: { kind: "member", memberName: "eng", root: "agents/eng/agent" },
    });
    expect(plan.isUpdate).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.deletions).toEqual(["agents/eng/agent/channels/discord.ts"]);
  });

  it("a standalone channel install collides with a path an agent-install already owns", () => {
    // The engineer agent materialized channels/discord.ts under member x (a different lock entry).
    const agentEntry: InstallEntry = {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      version: "0.2.0",
      hash: "h",
      registry: REGISTRY,
      member: "x",
      files: ["agents/x/agent/agent.ts", "agents/x/agent/channels/discord.ts"],
    };
    const discordChannel: CatalogTemplate = {
      manifest: {
        id: "discord",
        type: "channel",
        name: "Discord",
        description: "Talk from Discord.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: ["channels/discord.ts"],
      },
      files: { "channels/discord.ts": "export default {};\n" },
    };
    const plan = planInstall({
      template: discordChannel,
      registry: REGISTRY,
      repoPaths: agentEntry.files,
      drafts: [],
      packageJson: null,
      lock: upsertInstall(emptyLock(), agentEntry),
      target: { kind: "member", memberName: "x", root: "agents/x/agent" },
      keepExistingFiles: true,
    });
    // A DIFFERENT lock entry owns the path, so this is a blocking conflict, not an update.
    expect(plan.isUpdate).toBe(false);
    expect(plan.conflicts).toEqual(["agents/x/agent/channels/discord.ts"]);
    expect(plan.canKeepExistingFiles).toBe(false);
    expect(plan.preservedFiles).toEqual([]);
  });
});

describe("planInstall — composite absorbs a standalone include install (issue #42)", () => {
  /** The member already has the Discord channel installed standalone… */
  const standaloneEntry: InstallEntry = {
    id: "discord",
    type: "channel",
    name: "Discord",
    version: "0.1.0",
    hash: "discord-own-hash",
    registry: REGISTRY,
    member: "x",
    files: [
      "agents/x/agent/channels/discord.ts",
      "agents/x/agent/sandbox/addons/discord.ts",
    ],
  };
  /** …and the bundle being installed includes that same channel (flattened by the resolver). */
  const resolvedBundle: CatalogTemplate & {
    hash?: string;
    includes?: Array<{
      id: string;
      type: "channel";
      name: string;
      version: string;
      hash: string;
    }>;
  } = {
    manifest: {
      id: "chat-pack",
      type: "bundle",
      name: "Chat pack",
      description: "Discord plus a chat skill.",
      version: "0.1.0",
      eve: ">=0.20.0",
      files: ["channels/discord.ts", "skills/chat.md"],
    },
    files: {
      "channels/discord.ts": "export default {};\n",
      "skills/chat.md": "# Chat\n",
    },
    hash: "bundle-own-hash",
    includes: [
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: "discord-own-hash",
      },
    ],
  };

  function absorbCtx(over: Partial<PlanContext> = {}): PlanContext {
    return {
      template: resolvedBundle,
      registry: REGISTRY,
      repoPaths: standaloneEntry.files,
      drafts: [],
      packageJson: null,
      lock: upsertInstall(emptyLock(), standaloneEntry),
      target: { kind: "member", memberName: "x", root: "agents/x/agent" },
      ...over,
    };
  }

  it("overwrites the standalone install instead of refusing, and supersedes its lock entry", () => {
    const plan = planInstall(absorbCtx());
    expect(plan.conflicts).toEqual([]);
    expect(plan.isUpdate).toBe(false);
    // Files the standalone owned that the composite doesn't re-ship are staged deletions.
    expect(plan.deletions).toEqual([
      "agents/x/agent/sandbox/addons/discord.ts",
    ]);
    // The reviewer is told an existing install was absorbed.
    expect(plan.warnings.some((w) => w.includes("Absorbs"))).toBe(true);

    const lock = parseLock(
      JSON.parse(plan.writes.find((w) => w.path === "harnesst-lock.json")!.content),
    );
    // The standalone entry is gone; the composite's entry records the include provenance.
    expect(findInstall(lock, "discord", "x")).toBeUndefined();
    const entry = findInstall(lock, "chat-pack", "x")!;
    expect(entry.includes?.map((i) => i.id)).toEqual(["discord"]);
    expect(entry.files).toContain("agents/x/agent/channels/discord.ts");
    expect(entry.files).toContain("agents/x/agent/skills/chat.md");
  });

  it("leaves the same template installed under a DIFFERENT member untouched", () => {
    const otherMember: InstallEntry = {
      ...standaloneEntry,
      member: "y",
      files: ["agents/y/agent/channels/discord.ts"],
    };
    const plan = planInstall(
      absorbCtx({
        repoPaths: [...standaloneEntry.files, ...otherMember.files],
        lock: upsertInstall(
          upsertInstall(emptyLock(), standaloneEntry),
          otherMember,
        ),
      }),
    );
    expect(plan.conflicts).toEqual([]);
    const lock = parseLock(
      JSON.parse(plan.writes.find((w) => w.path === "harnesst-lock.json")!.content),
    );
    expect(findInstall(lock, "discord", "y")).toBeDefined();
    expect(findInstall(lock, "discord", "x")).toBeUndefined();
  });

  it("still refuses a path owned by an install the composite does NOT include", () => {
    const unrelated: InstallEntry = {
      ...standaloneEntry,
      id: "telegram",
      name: "Telegram",
      files: ["agents/x/agent/channels/discord.ts"], // occupies the same path
    };
    const plan = planInstall(
      absorbCtx({
        repoPaths: unrelated.files,
        lock: upsertInstall(emptyLock(), unrelated),
      }),
    );
    expect(plan.conflicts).toEqual(["agents/x/agent/channels/discord.ts"]);
  });
});

/**
 * Ownership after the #254 reversal: TWO classes remain. Platform files (`harnesst/…`) live
 * beside the agent root, are rewritten on every update and hash-verified at publish; everything
 * else a template ships is the template's to overwrite on every update — install-once is gone,
 * and preservation guards first installs only. The two fixtures mirror the real GitHub channel's
 * history: 0.6.0 split the implementation into a platform file plus a preserved wrapper, and
 * 0.7.0 folds the whole channel back into one overwritable file.
 */
const platformChannelTpl: CatalogTemplate = {
  manifest: {
    id: "github",
    type: "channel",
    name: "GitHub",
    description: "Wake on GitHub events.",
    version: "0.6.0",
    eve: ">=0.1.0",
    files: ["channels/github.ts", "harnesst/github-channel.ts"],
  },
  files: {
    "channels/github.ts":
      'import { harnesstGitHubChannel } from "../../harnesst/github-channel";\nexport default harnesstGitHubChannel();\n',
    "harnesst/github-channel.ts":
      "export function harnesstGitHubChannel() {\n  return {};\n}\n",
  },
};

/** The folded 0.7.0 shape: one self-contained channel file, no platform half. */
const foldedChannelTpl: CatalogTemplate = {
  manifest: {
    id: "github",
    type: "channel",
    name: "GitHub",
    description: "Wake on GitHub events.",
    version: "0.7.0",
    eve: ">=0.1.0",
    files: ["channels/github.ts"],
  },
  files: { "channels/github.ts": "export default {};\n" },
};

const WRAPPER_PATH = "agents/pm/agent/channels/github.ts";
const PLATFORM_PATH = "agents/pm/harnesst/github-channel.ts";

/** Independent recomputation of the platform file hash — the rule, not the implementation. */
function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The lock as it looks after a first install of the channel into `pm`. */
function installedChannelLock(): HarnesstLock {
  const first = planInstall(
    memberCtx({ template: platformChannelTpl, packageJson: null }),
  );
  return parseLock(
    JSON.parse(first.writes.find((w) => w.path === "harnesst-lock.json")!.content),
  );
}

describe("planInstall — platform files (issue #254)", () => {
  it("materializes a `harnesst/` file BESIDE the agent root, never inside it", () => {
    const plan = planInstall(
      memberCtx({ template: platformChannelTpl, packageJson: null }),
    );
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain(WRAPPER_PATH);
    expect(paths).toContain(PLATFORM_PATH);
    // eve hard-errors on an unknown directory under `agent/` — nothing may land there.
    expect(paths).not.toContain("agents/pm/agent/harnesst/github-channel.ts");
  });

  it("maps the platform root for a single-agent repo and for a new team member", () => {
    const single = planInstall(
      memberCtx({
        template: platformChannelTpl,
        packageJson: null,
        target: { kind: "member", memberName: null, root: "agent" },
      }),
    );
    expect(single.writes.map((w) => w.path)).toContain(
      "harnesst/github-channel.ts",
    );

    const newMember = planInstall({
      template: {
        ...platformChannelTpl,
        manifest: { ...platformChannelTpl.manifest, type: "agent" },
      },
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      target: { kind: "new-member", name: "deployer" },
    });
    expect(newMember.writes.map((w) => w.path)).toContain(
      "agents/deployer/harnesst/github-channel.ts",
    );
  });

  it("records a content hash per platform file in the lock entry", () => {
    const entry = findInstall(installedChannelLock(), "github", "pm")!;
    expect(entry.platformFiles).toEqual({
      [PLATFORM_PATH]: sha256(
        platformChannelTpl.files["harnesst/github-channel.ts"],
      ),
    });
    // The template hash is a different question and stays what it always was.
    expect(entry.platformFiles![PLATFORM_PATH]).not.toBe(entry.hash);
  });

  it("omits platformFiles for a template that ships no platform code", () => {
    const plan = planInstall(memberCtx());
    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
        ),
      ),
      "cloudflare-deploy",
      "pm",
    )!;
    expect(entry.platformFiles).toBeUndefined();
  });

  it("installedFilePath is the one mapping — platform paths go to the sibling root", () => {
    expect(installedFilePath("agents/pm/agent", "channels/github.ts")).toBe(
      "agents/pm/agent/channels/github.ts",
    );
    expect(installedFilePath("agents/pm/agent", "harnesst/x.ts")).toBe(
      "agents/pm/harnesst/x.ts",
    );
    expect(installedFilePath("agent", "harnesst/x.ts")).toBe("harnesst/x.ts");
  });
});

describe("planInstall — updates overwrite (the #254 reversal)", () => {
  /** The next lock after a plan, parsed back out of its staged `harnesst-lock.json` write. */
  function lockAfter(plan: ReturnType<typeof planInstall>): HarnesstLock {
    return parseLock(
      JSON.parse(
        plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
  }

  it("a FIRST install writes every shipped file and owns them all", () => {
    const plan = planInstall(
      memberCtx({ template: platformChannelTpl, packageJson: null }),
    );
    expect(plan.writes.some((w) => w.path === WRAPPER_PATH)).toBe(true);
    expect(plan.preservedFiles).toEqual([]);
    const entry = findInstall(lockAfter(plan), "github", "pm")!;
    expect(entry.files).toEqual([WRAPPER_PATH, PLATFORM_PATH]);
  });

  it("an update overwrites a template path recorded in preservedFiles — the stuck production state", () => {
    // Exactly what the install-once update left behind on two live agents: the wrapper sits in
    // `preservedFiles`, not `files`. Before the narrowing, every later update re-preserved the
    // stale file forever; the folded update must reclaim and rewrite it instead.
    const stuck: InstallEntry = {
      id: "github",
      type: "channel",
      name: "GitHub",
      version: "0.6.0",
      hash: "abc",
      registry: REGISTRY,
      member: "pm",
      files: [PLATFORM_PATH],
      preservedFiles: [WRAPPER_PATH],
    };
    const plan = planInstall(
      memberCtx({
        template: foldedChannelTpl,
        packageJson: null,
        lock: upsertInstall(emptyLock(), stuck),
        repoPaths: [WRAPPER_PATH, PLATFORM_PATH],
      }),
    );
    expect(plan.isUpdate).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([]);
    // The whole point of the reversal: the template's bytes land over the stale file...
    expect(plan.writes.find((w) => w.path === WRAPPER_PATH)?.content).toBe(
      foldedChannelTpl.files["channels/github.ts"],
    );
    // ...and the platform half the folded version no longer ships falls out as a deletion.
    expect(plan.deletions).toEqual([PLATFORM_PATH]);

    const entry = findInstall(lockAfter(plan), "github", "pm")!;
    // Reclaimed: lock-owned again, nothing preserved, no platform files left to hash-check.
    expect(entry.files).toEqual([WRAPPER_PATH]);
    expect(entry.preservedFiles).toBeUndefined();
    expect(entry.platformFiles).toBeUndefined();
  });

  it("an update from the split layout overwrites the owned wrapper and deletes the platform half", () => {
    const lock = installedChannelLock(); // 0.6.0: owns both files
    const plan = planInstall(
      memberCtx({
        template: foldedChannelTpl,
        packageJson: null,
        lock,
        repoPaths: [WRAPPER_PATH, PLATFORM_PATH],
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.some((w) => w.path === WRAPPER_PATH)).toBe(true);
    expect(plan.deletions).toEqual([PLATFORM_PATH]);
    const entry = findInstall(lockAfter(plan), "github", "pm")!;
    expect(entry.files).toEqual([WRAPPER_PATH]);
    expect(entry.platformFiles).toBeUndefined();
  });

  it("the staged platform deletion leaves the publish hash gate nothing to check", () => {
    // The 0.6.0 entry recorded a hash for PLATFORM_PATH; the folded update's change-set deletes
    // that file AND the lock entry that vouched for it. platformPathsUnderCheck must see the
    // staged deletion — a gate still demanding a hash for a file the tree is about to lose would
    // fail every publish of this update.
    const plan = planInstall(
      memberCtx({
        template: foldedChannelTpl,
        packageJson: null,
        lock: installedChannelLock(),
        repoPaths: [WRAPPER_PATH, PLATFORM_PATH],
      }),
    );
    const drafts = [
      ...plan.writes.map((w) => ({ path: w.path, content: w.content as string | null })),
      ...plan.deletions.map((path) => ({ path, content: null })),
    ];
    expect(platformPathsUnderCheck([WRAPPER_PATH, PLATFORM_PATH], drafts)).toEqual([]);
  });

  it("an update overwrites a draft-edited template path too — a draft is not preservation", () => {
    const plan = planInstall(
      memberCtx({
        template: foldedChannelTpl,
        packageJson: null,
        lock: installedChannelLock(),
        repoPaths: [PLATFORM_PATH],
        drafts: [{ path: WRAPPER_PATH, content: "// edited, unpublished\n" }],
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.preservedFiles).toEqual([]);
    expect(plan.writes.some((w) => w.path === WRAPPER_PATH)).toBe(true);
  });
});

/**
 * A live agent once lost its browser QA to this: someone hand-wrote a sandbox add-on, so nothing
 * in the lock claimed it, and the next install regenerated `sandbox/sandbox.ts` from the lock —
 * dropping the import with no error, no conflict, and no diff the reviewer would read as a loss.
 * The planner cannot adopt a file with no provenance, so the least it owes the customer is to say
 * out loud which file just stopped running. These tests hold that line, and hold it narrowly: a
 * warning on every add-on would be noise nobody reads by the second install.
 */
describe("planInstall — orphaned sandbox add-ons (issue #254)", () => {
  const HAND_ROLLED = "agents/pm/agent/sandbox/addons/hand-rolled.ts";

  it("names an add-on no install owns, whose import regeneration silently drops", () => {
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
        repoPaths: [HAND_ROLLED, "agents/pm/agent/sandbox/sandbox.ts"],
      }),
    );
    const module = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
    )!.content;
    expect(module).not.toContain("hand-rolled");
    expect(plan.warnings.some((w) => w.includes(HAND_ROLLED))).toBe(true);
    // The add-on this install owns is not an orphan.
    expect(
      plan.warnings.some((w) => w.includes("addons/agent-browser.ts")),
    ).toBe(false);
  });

  it("says nothing about an add-on the operator has staged for deletion", () => {
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
        repoPaths: [HAND_ROLLED, "agents/pm/agent/sandbox/sandbox.ts"],
        drafts: [{ path: HAND_ROLLED, content: null }],
      }),
    );
    expect(plan.warnings.some((w) => w.includes(HAND_ROLLED))).toBe(false);
  });

  it("says nothing when every add-on on disk is lock-owned", () => {
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
        repoPaths: ["agents/pm/agent/sandbox/addons/agent-browser.ts"],
      }),
    );
    expect(plan.warnings.filter((w) => w.includes("isn't owned"))).toEqual([]);
  });

  it("ignores an add-on this very plan deletes (an absorbed install's)", () => {
    const standalone = planInstall(
      memberCtx({ template: browserSkillTpl, packageJson: null }),
    );
    const lock = parseLock(
      JSON.parse(
        standalone.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    const bundle = planInstall(
      memberCtx({
        packageJson: null,
        lock,
        repoPaths: [
          "agents/pm/agent/sandbox/addons/agent-browser.ts",
          "agents/pm/agent/skills/agent-browser.md",
        ],
        template: {
          manifest: {
            ...browserSkillTpl.manifest,
            id: "browser-bundle",
            type: "bundle",
            name: "Browser Bundle",
          },
          files: browserSkillTpl.files,
          includes: [
            {
              id: "agent-browser",
              type: "skill",
              name: "Agent Browser",
              version: "0.1.0",
              hash: "abc",
            },
          ],
        },
      }),
    );
    expect(bundle.deletions).toEqual([
      "agents/pm/agent/sandbox/addons/agent-browser.ts",
    ]);
    expect(bundle.warnings.filter((w) => w.includes("isn't owned"))).toEqual([]);
  });
});

describe("channel settings in the lock (issue #254)", () => {
  const bundleEntry: InstallEntry = {
    id: "github-bundle",
    type: "bundle",
    name: "GitHub Bundle",
    version: "0.4.0",
    hash: "abc",
    registry: REGISTRY,
    member: "ivy",
    files: [],
    includes: [
      {
        id: "github",
        type: "channel",
        name: "GitHub",
        version: "0.6.0",
        hash: "def",
      },
    ],
  };

  it("resolves a bundle-carried channel — the only lock entry a real install has", () => {
    expect(channelIdsForEntry(bundleEntry)).toEqual(["github"]);
    expect(
      channelIdsForEntry({ ...bundleEntry, id: "github", type: "channel", includes: undefined }),
    ).toEqual(["github"]);
    expect(channelIdsForEntry({ ...bundleEntry, includes: undefined })).toEqual(
      [],
    );
  });

  it("writes settings onto the entry that provides the channel", () => {
    const lock = upsertInstall(emptyLock(), bundleEntry);
    const { lock: next, changed } = setChannelSettings(lock, "github", "ivy", {
      repos: ["worksauceapp/marketing-site"],
      wakeLabels: ["ready", "changes-requested"],
      wakeOnNewIssues: true,
    });
    expect(changed).toBe(true);
    expect(channelSettings(next, "github", "ivy")).toEqual({
      repos: ["worksauceapp/marketing-site"],
      wakeLabels: ["ready", "changes-requested"],
      wakeOnNewIssues: true,
    });
    // Round-trips through the serialized lock — this is a reviewable file, not a cache.
    expect(
      channelSettings(parseLock(JSON.parse(serializeLock(next))), "github", "ivy"),
    ).toEqual(channelSettings(next, "github", "ivy"));
  });

  it("drops values that mean 'not configured' and reads back as inert", () => {
    const lock = upsertInstall(emptyLock(), bundleEntry);
    const { lock: next } = setChannelSettings(lock, "github", "ivy", {
      repos: [],
      wakeLabels: [],
      wakeOnNewIssues: false,
      note: "",
    });
    expect(findInstall(next, "github-bundle", "ivy")!.settings).toBeUndefined();
    expect(channelSettings(next, "github", "ivy")).toEqual({});
  });

  it("reports no change for a no-op write, and leaves other members alone", () => {
    const lock = upsertInstall(
      upsertInstall(emptyLock(), bundleEntry),
      { ...bundleEntry, member: "sam" },
    );
    const first = setChannelSettings(lock, "github", "ivy", { repos: ["a/b"] });
    expect(first.changed).toBe(true);
    const again = setChannelSettings(first.lock, "github", "ivy", {
      repos: ["a/b"],
    });
    expect(again.changed).toBe(false);
    expect(again.lock).toBe(first.lock);
    expect(channelSettings(first.lock, "github", "sam")).toEqual({});
  });

  it("is empty for a channel that isn't installed at all", () => {
    expect(channelSettings(emptyLock(), "github", "ivy")).toEqual({});
  });

  it("survives a marketplace update — a version bump must not silently un-configure a channel", () => {
    const configured = setChannelSettings(
      upsertInstall(emptyLock(), {
        ...bundleEntry,
        id: "github",
        type: "channel",
        member: "pm",
        includes: undefined,
        version: "0.6.0",
        files: [PLATFORM_PATH, WRAPPER_PATH],
      }),
      "github",
      "pm",
      { repos: ["a/b"], wakeOnNewIssues: true },
    ).lock;
    // The folded 0.7.0 update overwrites the channel file and drops the platform half — the
    // operator's wake settings must ride across untouched.
    const plan = planInstall(
      memberCtx({
        template: foldedChannelTpl,
        packageJson: null,
        lock: configured,
        repoPaths: [WRAPPER_PATH, PLATFORM_PATH],
      }),
    );
    const next = parseLock(
      JSON.parse(
        plan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    expect(channelSettings(next, "github", "pm")).toEqual({
      repos: ["a/b"],
      wakeOnNewIssues: true,
    });
  });
});

describe("lock helpers round-trip", () => {
  const entry: InstallEntry = {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    version: "0.1.0",
    hash: "abc",
    registry: REGISTRY,
    member: "pm",
    files: ["agents/pm/agent/tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
  };

  it("upsert then serialize/parse is stable", () => {
    const lock = upsertInstall(emptyLock(), entry);
    const parsed = parseLock(JSON.parse(serializeLock(lock)));
    expect(parsed).toEqual(lock);
    expect(findInstall(parsed, "cloudflare-deploy", "pm")).toEqual(entry);
  });

  it("upsert replaces the same (id, member), not appends", () => {
    let lock = upsertInstall(emptyLock(), entry);
    lock = upsertInstall(lock, { ...entry, version: "0.2.0" });
    expect(lock.installs).toHaveLength(1);
    expect(findInstall(lock, "cloudflare-deploy", "pm")!.version).toBe("0.2.0");
  });

  it("the same id under a different member is a distinct install", () => {
    let lock = upsertInstall(emptyLock(), entry);
    lock = upsertInstall(lock, { ...entry, member: "qa" });
    expect(lock.installs).toHaveLength(2);
  });

  it("remove drops exactly the (id, member) entry", () => {
    const lock = upsertInstall(emptyLock(), entry);
    const after = removeInstall(lock, "cloudflare-deploy", "pm");
    expect(after.installs).toEqual([]);
  });
});

describe("planUninstall", () => {
  const entry: InstallEntry = {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    version: "0.1.0",
    hash: "abc",
    registry: REGISTRY,
    member: "pm",
    files: [
      "agents/pm/agent/tools/cloudflare-deploy.ts",
      "agents/pm/agent/tools/helper.ts",
    ],
    dependencies: { wrangler: "^3.0.0" },
  };
  const lock: HarnesstLock = upsertInstall(emptyLock(), entry);

  it("deletes the entry's files, drops it from the lock, lists deps left", () => {
    const plan = planUninstall({
      lock,
      id: "cloudflare-deploy",
      memberName: "pm",
      repoPaths: entry.files,
    });
    expect(plan.notFound).toBe(false);
    expect(plan.deletions).toEqual(entry.files);
    expect(plan.depsLeft).toEqual(["wrangler"]);
    const parsed = parseLock(JSON.parse(plan.lockWrite.content));
    expect(findInstall(parsed, "cloudflare-deploy", "pm")).toBeUndefined();
  });

  it("only deletes files still present on the branch", () => {
    const plan = planUninstall({
      lock,
      id: "cloudflare-deploy",
      memberName: "pm",
      repoPaths: ["agents/pm/agent/tools/cloudflare-deploy.ts"],
    });
    expect(plan.deletions).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
  });

  it("reports notFound for an install that isn't in the lock", () => {
    const plan = planUninstall({
      lock,
      id: "nope",
      memberName: "pm",
      repoPaths: [],
    });
    expect(plan.notFound).toBe(true);
    expect(plan.deletions).toEqual([]);
  });

  it("removes sandbox add-ons and regenerates the managed sandbox module", () => {
    const installPlan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const installedLock = parseLock(
      JSON.parse(
        installPlan.writes.find((w) => w.path === "harnesst-lock.json")!.content,
      ),
    );
    const entry = findInstall(installedLock, "agent-browser", "pm")!;
    const plan = planUninstall({
      lock: installedLock,
      id: "agent-browser",
      memberName: "pm",
      repoPaths: entry.files,
    });
    expect(plan.deletions).toEqual([
      "agents/pm/agent/sandbox/addons/agent-browser.ts",
      "agents/pm/agent/skills/agent-browser.md",
    ]);
    expect(plan.writes.map((w) => w.path)).toEqual([
      "harnesst-lock.json",
      "agents/pm/agent/sandbox/sandbox.ts",
    ]);
    expect(
      plan.writes.find((w) => w.path === "agents/pm/agent/sandbox/sandbox.ts")!
        .content,
    ).toContain("const addons = [];");
  });
});
