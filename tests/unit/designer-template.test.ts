import { describe, expect, it } from "vitest";

import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";

describe("Designer template child roles", () => {
  it("ships role prompts for eve's built-in agent without the false capability claim", async () => {
    const template = await fixtureCatalog.template("agent", "designer");
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
    const template = await fixtureCatalog.template("agent", "designer");
    const instructions = template.files["instructions.md"];
    const workflow =
      template.files["skills/impeccable/reference/designer-v1.md"];

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
    const template = await fixtureCatalog.template("agent", "designer");
    const workflow =
      template.files["skills/impeccable/reference/designer-v1.md"];
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
    const template = await fixtureCatalog.template("agent", "designer");
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
});
