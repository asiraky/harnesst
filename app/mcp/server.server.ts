import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import type { McpToolService } from "~/mcp/tools.server";

const projectInput = {
  projectId: z.string().min(1).describe("Eden project ID"),
};

const deploymentInput = {
  deploymentId: z.string().min(1).describe("Eden deployment row ID"),
};

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Construct one MCP protocol server for an already-authenticated caller.
 *
 * Authentication and organization/user scoping live in the injected service. Keeping those
 * concerns outside the protocol adapter also lets the HTTP route bind one service to one MCP
 * session without sending the caller back through Eden's resource routes.
 */
export function createEdenMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: "eden", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      description:
        "List the Eden projects visible to the authenticated caller.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(await service.listProjects()),
  );

  server.registerTool(
    "list_agents",
    {
      description: "List the agents in an Eden project.",
      inputSchema: projectInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listAgents(input)),
  );

  server.registerTool(
    "list_releases",
    {
      description:
        "List releases for a project, optionally limited to one agent.",
      inputSchema: {
        ...projectInput,
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Eden agent ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listReleases(input)),
  );

  server.registerTool(
    "list_environments",
    {
      description:
        "List deployment environments for a project, optionally limited to one agent.",
      inputSchema: {
        ...projectInput,
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Eden agent ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listEnvironments(input)),
  );

  server.registerTool(
    "get_deploy_status",
    {
      description:
        "Get a deployment's current asynchronous status and Git/release/deployment drift.",
      inputSchema: deploymentInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await service.getDeployStatus(input)),
  );

  server.registerTool(
    "deploy_team_version",
    {
      description:
        "Queue a team repository release at an existing Git commit. Returns a deployment row immediately; poll get_deploy_status until it is live or failed.",
      inputSchema: {
        ...projectInput,
        gitSha: z.string().min(1).describe("Git commit SHA to deploy"),
        environment: z.string().min(1).describe("Target environment name"),
        rebuild: z
          .boolean()
          .optional()
          .describe("Force a rebuild of an existing release"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.deployTeamVersion(input)),
  );

  server.registerTool(
    "deploy_head",
    {
      description:
        "Queue the repository's current default-branch head. Returns a deployment row immediately; poll get_deploy_status until it is live or failed.",
      inputSchema: {
        ...projectInput,
        environment: z.string().min(1).describe("Target environment name"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.deployHead(input)),
  );

  server.registerTool(
    "retry_deployment",
    {
      description:
        "Retry a failed deployment asynchronously. Returns its deployment row immediately.",
      inputSchema: deploymentInput,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.retryDeployment(input)),
  );

  server.registerTool(
    "clear_failed",
    {
      description: "Clear the failed deployment state for an environment.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Eden environment ID"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => toolResult(await service.clearFailed(input)),
  );

  server.registerTool(
    "stage_changes",
    {
      description:
        "Save one or more agent edits as drafts in Eden's shared staging area. This is the first step of the authoring flow: save changes, then publish_changes takes EVERY saved draft live through Eden's pipeline (check, build, commit, version, deploy). This tool only writes drafts — it never touches GitHub.",
      inputSchema: {
        ...projectInput,
        edits: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .describe("Editable repo-relative agent path"),
              content: z
                .string()
                .nullable()
                .describe(
                  "Complete UTF-8 file content, or null to stage deletion",
                ),
              baseSha: z
                .string()
                .min(1)
                .nullable()
                .optional()
                .describe("Optional source blob SHA used as a conflict hint"),
            }),
          )
          .min(1)
          .describe("Edits validated as one batch before staging begins"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => toolResult(await service.stageChanges(input)),
  );

  server.registerTool(
    "publish_changes",
    {
      description:
        "Publish EVERY saved draft through Eden's full pipeline: check, build, commit to the default branch, cut a version per agent, and deploy the whole team into the project's live environment. A failed build lands nothing and keeps the drafts saved. Runs synchronously and returns the commit sha, release ids, and queued deployment ids; poll get_deploy_status for the deploys.",
      inputSchema: {
        ...projectInput,
        environment: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Target environment name — required only when the project has several environments and no live environment recorded yet; the answer is remembered",
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.publishChanges(input)),
  );

  server.registerTool(
    "discard_changes",
    {
      description:
        "Discard selected saved drafts from Eden without publishing. This removes only unpublished drafts from the staging area and never touches GitHub.",
      inputSchema: {
        ...projectInput,
        paths: z
          .array(z.string().min(1).describe("Staged repo-relative agent path"))
          .min(1),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => toolResult(await service.discardChanges(input)),
  );

  return server;
}
