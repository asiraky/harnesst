import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createHarnesstMcpServer } from "~/mcp/server.server";
import type { McpToolService } from "~/mcp/tools.server";

const readSkill = () =>
  readFile(
    new URL(
      "../../catalog/templates/skills/harnesst-mcp-authoring/files/skills/harnesst-mcp-authoring/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

const contracts = {
  list_projects: "",
  list_agents: "{ projectId }",
  list_releases: "{ projectId, agentId? }",
  list_environments: "{ projectId, agentId? }",
  stage_changes: "{ projectId, edits: [{ path, content, baseSha? }] }",
  publish_changes: "{ projectId, environment? }",
  discard_changes: "{ projectId, paths }",
  deploy_team_version: "{ projectId, gitSha, environment, rebuild? }",
  deploy_head: "{ projectId, environment }",
  get_deploy_status: "{ deploymentId }",
  retry_deployment: "{ deploymentId }",
  clear_failed: "{ environmentId }",
} as const;

const required = {
  list_projects: [],
  list_agents: ["projectId"],
  list_releases: ["projectId"],
  list_environments: ["projectId"],
  stage_changes: ["edits", "projectId"],
  publish_changes: ["projectId"],
  discard_changes: ["paths", "projectId"],
  deploy_team_version: ["environment", "gitSha", "projectId"],
  deploy_head: ["environment", "projectId"],
  get_deploy_status: ["deploymentId"],
  retry_deployment: ["deploymentId"],
  clear_failed: ["environmentId"],
} satisfies Record<keyof typeof contracts, string[]>;

const properties = {
  list_projects: [],
  list_agents: ["projectId"],
  list_releases: ["agentId", "projectId"],
  list_environments: ["agentId", "projectId"],
  stage_changes: ["edits", "projectId"],
  publish_changes: ["environment", "projectId"],
  discard_changes: ["paths", "projectId"],
  deploy_team_version: ["environment", "gitSha", "projectId", "rebuild"],
  deploy_head: ["environment", "projectId"],
  get_deploy_status: ["deploymentId"],
  retry_deployment: ["deploymentId"],
  clear_failed: ["environmentId"],
} satisfies Record<keyof typeof contracts, string[]>;

describe("harnesst MCP authoring catalog skill", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((fn) => fn()));
  });

  it("references the live MCP tool names and top-level argument contracts", async () => {
    const skill = await readSkill();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    // Tool listing does not invoke the service; the protocol adapter is the contract under test.
    const server = createHarnesstMcpServer({} as McpToolService);
    const client = new Client({
      name: "skill-contract-test",
      version: "1.0.0",
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(
      () => client.close(),
      () => server.close(),
    );

    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual(Object.keys(contracts).sort());
    for (const [name, signature] of Object.entries(contracts)) {
      expect(skill).toContain(`\`${name}(${signature})\``);
      const schema = byName.get(name)?.inputSchema;
      expect(schema, `${name} must be registered`).toBeDefined();
      expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
        properties[name as keyof typeof properties],
      );
      expect([...(schema?.required ?? [])].sort()).toEqual(
        required[name as keyof typeof required],
      );
    }
  });

  it("teaches the pipeline path and asynchronous deployment confirmation", async () => {
    const skill = await readSkill();

    expect(skill).toMatch(/stage_changes[\s\S]*publish_changes/);
    expect(skill).toMatch(/one call runs harnesst's whole pipeline/i);
    expect(skill).toMatch(/a failed build lands nothing/i);
    expect(skill).toMatch(
      /`deploymentIds`[\s\S]*get_deploy_status[\s\S]*`live` or\s+`failed`/,
    );
    expect(skill).toMatch(/does not expose repository file contents/i);
    expect(skill).toMatch(/do not commit or push directly/i);
  });
});
