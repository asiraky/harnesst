/**
 * The instance env contract, checked from both ends (issue #235).
 *
 * Code harnesst writes INTO a customer's repo reads `process.env.HARNESST_*`; the deploy
 * controller injects those names into the container. Nothing links the two halves — the generated
 * half is committed in someone else's repository and never regenerates — so when the #213 rename
 * moved the controller and left the repos behind, every pre-rename agent silently lost its whole
 * sandbox environment: `process.env.EDEN_SANDBOX_ENV` was simply `undefined`.
 *
 * These tests are the link. Every generated artifact is scanned, and:
 *
 *  1. no legacy `eden` token survives anywhere in generated code, and
 *  2. every `HARNESST_*` name it reads is one `app/deploy/instance-env.ts` says an instance gets.
 *
 * Then the controller is read back against the same list, so a name can't be injected without
 * being declared. A future rename that touches one side now fails here rather than in production.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  harnesstEnvNamesIn,
  isInstanceEnvName,
  INSTANCE_ENV_NAMES,
} from "~/deploy/instance-env";
import { hasLegacyNames, findLegacyNames } from "~/eve/legacy-names";
import { scaffoldAgentModule, setModel } from "~/eve/agentModule";
import {
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "~/eve/org-model-module";
import { DEFAULT_SANDBOX_MODULE } from "~/eve/templates";
import { planInstall, type PlanContext } from "~/marketplace/install.server";
import { emptyLock } from "~/marketplace/lock";
import type { CatalogTemplate } from "~/seams/types";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** A skill with sandbox work — the only way to get the managed sandbox module out of the planner. */
const sandboxSkill: CatalogTemplate = {
  manifest: {
    id: "agent-browser",
    type: "skill",
    name: "Agent Browser",
    description: "Browser automation.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["skills/agent-browser.md"],
    sandbox: {
      bootstrap: ["npm install -g agent-browser@0.31.1"],
      env: { AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium" },
      revalidationKey: "agent-browser@0.31.1",
    },
  },
  files: { "skills/agent-browser.md": "# Agent Browser\n" },
};

function managedSandboxModule(): string {
  const ctx: PlanContext = {
    template: sandboxSkill,
    registry: "fixture",
    repoPaths: [],
    drafts: [],
    packageJson: null,
    lock: emptyLock(),
    target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
  };
  const write = planInstall(ctx).writes.find(
    (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
  );
  if (!write) throw new Error("planner stopped emitting a sandbox module");
  return write.content;
}

/** Every `.ts` file the catalog materializes into a repo, keyed by its repo-relative source path. */
function catalogTemplateFiles(): Array<{ label: string; content: string }> {
  const root = path.join(REPO_ROOT, "catalog/templates");
  const out: Array<{ label: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".ts")) {
        out.push({
          label: path.relative(REPO_ROOT, full),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The complete inventory of code harnesst puts inside a customer's repo: what the scaffolders
 * emit, what the install planner materializes, and every file the catalog ships.
 */
function generatedArtifacts(): Array<{ label: string; content: string }> {
  const scaffolded = scaffoldAgentModule("anthropic/claude-opus-5");
  return [
    { label: "DEFAULT_SANDBOX_MODULE", content: DEFAULT_SANDBOX_MODULE },
    { label: "managed sandbox module", content: managedSandboxModule() },
    { label: "scaffoldAgentModule", content: scaffolded },
    {
      label: "setModel",
      content: setModel(scaffolded, "openai/gpt-5.6", { effort: "high" }),
    },
    {
      label: "scaffoldOrgModelAgentModule",
      content: scaffoldOrgModelAgentModule("sam"),
    },
    { label: "orgModelModuleSource", content: orgModelModuleSource() },
    ...catalogTemplateFiles(),
  ];
}

describe("generated code — instance env contract", () => {
  it("has artifacts to check (the scan itself can rot)", () => {
    const artifacts = generatedArtifacts();
    expect(artifacts.length).toBeGreaterThan(10);
    expect(artifacts.every((a) => a.content.length > 0)).toBe(true);
  });

  it("carries no pre-rename eden token", () => {
    const stale = generatedArtifacts()
      .filter((a) => hasLegacyNames(a.content))
      .map((a) => `${a.label}: ${findLegacyNames(a.content).join(", ")}`);
    expect(stale).toEqual([]);
  });

  it("reads only env names the deploy controller sets", () => {
    const unknown = generatedArtifacts().flatMap((a) =>
      harnesstEnvNamesIn(a.content)
        .filter((name) => !isInstanceEnvName(name))
        .map((name) => `${a.label}: ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it("actually reads the contract names it is supposed to (the scan works)", () => {
    const read = new Set(
      generatedArtifacts().flatMap((a) => harnesstEnvNamesIn(a.content)),
    );
    // The four that made issue #235 visible in production, one per generated surface.
    expect(read).toContain("HARNESST_SANDBOX_ENV");
    expect(read).toContain("HARNESST_MODEL_GATEWAY_URL");
    expect(read).toContain("HARNESST_DISCORD_SEND_URL");
    expect(read).toContain("HARNESST_TEAM_TOKEN");
  });
});

describe("deploy controller — instance env contract", () => {
  const controller = readFileSync(
    path.join(REPO_ROOT, "app/deploy/controller.server.ts"),
    "utf8",
  );

  it("injects only declared names", () => {
    // Every `envVars.HARNESST_X = …` / `envVars.HARNESST_X ??= …` assignment in the controller.
    const injected = [
      ...controller.matchAll(/envVars\.(HARNESST_[A-Z0-9_]+)\s*\??=/g),
    ].map((m) => m[1]);
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.filter((name) => !isInstanceEnvName(name))).toEqual([]);
  });

  it("declares no name that nothing on either side uses", () => {
    const used = new Set([
      ...generatedArtifacts().flatMap((a) => harnesstEnvNamesIn(a.content)),
      ...[...controller.matchAll(/(HARNESST_[A-Z0-9_]+)/g)].map((m) => m[1]),
    ]);
    expect(INSTANCE_ENV_NAMES.filter((name) => !used.has(name))).toEqual([]);
  });
});
