import { describe, expect, it } from "vitest";

import { resolveTemplate } from "~/marketplace/compose.server";
import {
  planInstall,
  TemplateAlreadyProvidedError,
} from "~/marketplace/install.server";
import {
  emptyLock,
  findInstall,
  parseLock,
  upsertInstall,
  type InstallEntry,
} from "~/marketplace/lock";
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";

async function resolvedDesigner() {
  return resolveTemplate(fixtureCatalog, "agent", "designer");
}

describe("Standalone Impeccable skill", () => {
  it("ships the vendored payload and its complete install contract", async () => {
    const template = await fixtureCatalog.template("skill", "impeccable");

    expect(template.manifest.version).toBe("0.1.0");
    expect(Object.keys(template.files)).toHaveLength(149);
    expect(template.files).toHaveProperty("skills/impeccable/SKILL.md");
    expect(template.files).toHaveProperty(
      "skills/impeccable/reference/harnesst-v1.md",
    );
    expect(template.files).not.toHaveProperty(
      "skills/impeccable/reference/designer-v1.md",
    );
    expect(template.manifest.dependencies).toEqual({ impeccable: "3.5.0" });
    expect(template.manifest.sandbox).toEqual({
      bootstrap: ["npm install --global --no-audit --no-fund impeccable@3.5.0"],
      env: {
        IMPECCABLE_NO_TELEMETRY: "1",
        IMPECCABLE_QUESTION_DISABLED: "1",
      },
      revalidationKey: "impeccable-skill-4.0.4-cli-3.5.0",
    });
    expect(template.manifest.secrets).toEqual([
      expect.objectContaining({ name: "OPENAI_API_KEY", sandbox: true }),
    ]);
  });

  it("plans cleanly onto a non-Designer agent", async () => {
    const template = await resolveTemplate(
      fixtureCatalog,
      "skill",
      "impeccable",
    );
    const plan = planInstall({
      template,
      registry: "fixture",
      repoPaths: [],
      drafts: [],
      packageJson: JSON.stringify({
        name: "researcher",
        private: true,
        dependencies: { eve: "^0.22.0" },
      }),
      lock: emptyLock(),
      target: {
        kind: "member",
        memberName: "researcher",
        root: "agents/researcher/agent",
      },
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.secrets).toEqual([
      expect.objectContaining({ name: "OPENAI_API_KEY", sandbox: true }),
    ]);
    expect(plan.writes.map((write) => write.path)).toEqual(
      expect.arrayContaining([
        "agents/researcher/agent/skills/impeccable/SKILL.md",
        "agents/researcher/agent/sandbox/addons/impeccable.ts",
      ]),
    );
    expect(
      plan.writes.find(
        (write) =>
          write.path === "agents/researcher/agent/sandbox/addons/impeccable.ts",
      )?.content,
    ).toContain("IMPECCABLE_NO_TELEMETRY");
  });

  it("fails loudly when a current Designer include already provides it", async () => {
    const [impeccable, designer] = await Promise.all([
      resolveTemplate(fixtureCatalog, "skill", "impeccable"),
      resolvedDesigner(),
    ]);
    const root = "agents/designer/agent";
    const provider: InstallEntry = {
      id: "designer",
      type: "agent",
      name: "Designer",
      version: "1.3.0",
      hash: "designer-hash",
      registry: "fixture",
      member: "designer",
      files: Object.keys(designer.files).map((path) => `${root}/${path}`),
      includes: designer.includes,
    };

    expect(() =>
      planInstall({
        template: impeccable,
        registry: "fixture",
        repoPaths: provider.files,
        drafts: [],
        packageJson: null,
        lock: upsertInstall(emptyLock(), provider),
        target: { kind: "member", memberName: "designer", root },
      }),
    ).toThrowError(TemplateAlreadyProvidedError);
    expect(() =>
      planInstall({
        template: impeccable,
        registry: "fixture",
        repoPaths: provider.files,
        drafts: [],
        packageJson: null,
        lock: upsertInstall(emptyLock(), provider),
        target: { kind: "member", memberName: "designer", root },
      }),
    ).toThrow(
      "Impeccable is already provided by Designer v1.3.0 — update Designer to update this.",
    );
  });

  it("recognizes Designer 1.2.1 ownership before includes existed", async () => {
    const impeccable = await resolveTemplate(
      fixtureCatalog,
      "skill",
      "impeccable",
    );
    const root = "agents/designer/agent";
    const provider: InstallEntry = {
      id: "designer",
      type: "agent",
      name: "Designer",
      version: "1.2.1",
      hash: "old-designer-hash",
      registry: "fixture",
      member: "designer",
      files: impeccable.manifest.files.map((path) =>
        `${root}/${path}`.replace(
          `${root}/skills/impeccable/reference/harnesst-v1.md`,
          `${root}/skills/impeccable/reference/designer-v1.md`,
        ),
      ),
    };

    expect(() =>
      planInstall({
        template: impeccable,
        registry: "fixture",
        repoPaths: provider.files,
        drafts: [],
        packageJson: null,
        lock: upsertInstall(emptyLock(), provider),
        target: { kind: "member", memberName: "designer", root },
      }),
    ).toThrow(
      "Impeccable is already provided by Designer v1.2.1 — update Designer to update this.",
    );
  });
});

describe("Designer template child roles", () => {
  it("ships role prompts for eve's built-in agent without the false capability claim", async () => {
    const template = await resolvedDesigner();
    const paths = Object.keys(template.files);
    const payload = [
      template.assistantSkill ?? "",
      ...Object.values(template.files),
    ].join("\n");

    expect(paths).toEqual(
      expect.arrayContaining([
        "skills/impeccable/reference/roles/asset-producer.md",
        "skills/impeccable/reference/roles/documenter.md",
        "skills/impeccable/reference/roles/finish-reviewer.md",
      ]),
    );
    expect(paths.some((path) => path.includes("/degraded/"))).toBe(false);
    expect(payload).not.toMatch(/eve has no subagents/i);
    expect(payload).not.toMatch(/no subagents in this harness/i);
    expect(payload).not.toMatch(/this harness has no subagent capability/i);
    expect(payload).not.toContain("reference/degraded/");
    expect(payload).not.toContain("[degraded/");
  });

  it("instructs inherited root copies to adopt each role and share task files", async () => {
    const template = await resolvedDesigner();
    const instructions = template.files["instructions.md"];
    const workflow =
      template.files["skills/impeccable/reference/harnesst-v1.md"];

    expect(instructions).toContain(
      "When your current task message names a file under `reference/roles/`",
    );
    expect(instructions).toMatch(
      /assigns Assessment A or B\s+from `reference\/critique\.md`/,
    );
    expect(instructions).toMatch(
      /do not restart\s+Designer's interview or build\s+workflow/i,
    );
    expect(workflow).toContain(
      "a child's writes under `/workspace/home` are immediately visible to the root",
    );
    expect(workflow).toContain("reference/roles/asset-producer.md");
    expect(workflow).toContain("reference/roles/finish-reviewer.md");
    expect(workflow).toContain("reference/roles/documenter.md");
  });

  it("requires structured finish-review and verdict results", async () => {
    const template = await resolvedDesigner();
    const workflow =
      template.files["skills/impeccable/reference/harnesst-v1.md"];
    const reviewer =
      template.files["skills/impeccable/reference/roles/finish-reviewer.md"];

    expect(workflow).toContain("Set `outputSchema` on the call");
    expect(workflow).toContain('"enum": ["rebuild", "fix", "ship"]');
    expect(workflow).toContain('"material_fixes"');
    expect(workflow).toContain('"enum": ["resolved", "partial", "unresolved"]');
    expect(reviewer).toContain("When the parent supplies an `outputSchema`");

    const reviewSchemas = [...workflow.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, unknown>)
      .filter((schema) => JSON.stringify(schema).includes('"disposition"'));
    expect(reviewSchemas).toHaveLength(2);
  });

  it("runs critique assessments as concurrent built-in agent calls", async () => {
    const template = await resolvedDesigner();
    const critique = template.files["skills/impeccable/reference/critique.md"];

    expect(critique).toContain(
      "Emit A and B as two `agent` calls in the same response",
    );
    expect(critique).toContain(
      "Run only the named assessment and return its contract to the parent",
    );
    expect(critique).toContain(
      "Method: dual-agent (A: isolated child · B: isolated child)",
    );
    expect(critique).not.toContain("<agent-id>");
    expect(critique).not.toContain("`spawn_agent` is not exposed");
    expect(critique).not.toContain("sub-agents declined by user");
  });

  it("composes Impeccable while keeping Designer's own sandbox pieces", async () => {
    const template = await resolvedDesigner();

    expect(template.manifest.version).toBe("1.3.0");
    expect(template.includes.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: "tool", id: "publish-artifact" },
      { type: "skill", id: "agent-browser" },
      { type: "skill", id: "impeccable" },
    ]);
    expect(template.manifest.dependencies?.impeccable).toBe("3.5.0");
    expect(template.manifest.sandbox?.bootstrap).toEqual(
      expect.arrayContaining([
        "npm install --global --no-audit --no-fund impeccable@3.5.0",
        "npm install --global --no-audit --no-fund http-server@14.1.1",
      ]),
    );
    expect(template.manifest.sandbox?.env).toMatchObject({
      IMPECCABLE_NO_TELEMETRY: "1",
      IMPECCABLE_QUESTION_DISABLED: "1",
    });
    expect(template.manifest.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "OPENAI_API_KEY", sandbox: true }),
      ]),
    );
  });

  it("updates an existing Designer in place with only the neutral adapter path deleted", async () => {
    const template = await resolvedDesigner();
    const root = "agents/designer/agent";
    const oldAdapter = `${root}/skills/impeccable/reference/designer-v1.md`;
    const newAdapter = `${root}/skills/impeccable/reference/harnesst-v1.md`;
    const priorFiles = [
      ...Object.keys(template.files).map((path) =>
        `${root}/${path}`.replace(newAdapter, oldAdapter),
      ),
      `${root}/sandbox/addons/designer.ts`,
    ].sort();
    const prior: InstallEntry = {
      id: "designer",
      type: "agent",
      name: "Designer",
      version: "1.2.1",
      hash: "old-designer-hash",
      registry: "fixture",
      member: "designer",
      files: priorFiles,
    };
    const plan = planInstall({
      template,
      registry: "fixture",
      repoPaths: priorFiles,
      drafts: [],
      packageJson: JSON.stringify({
        name: "designer",
        private: true,
        dependencies: template.manifest.dependencies,
      }),
      lock: upsertInstall(emptyLock(), prior),
      target: { kind: "member", memberName: "designer", root },
    });

    expect(plan.isUpdate).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.deletions).toEqual([oldAdapter]);
    const nextLock = parseLock(
      JSON.parse(
        plan.writes.find((write) => write.path === "harnesst-lock.json")!
          .content,
      ),
    );
    const entry = findInstall(nextLock, "designer", "designer")!;
    expect(entry.version).toBe("1.3.0");
    expect(entry.files).toContain(newAdapter);
    expect(entry.files).not.toContain(oldAdapter);
  });
});
