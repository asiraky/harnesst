import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import type { McpToolService } from "~/mcp/tools.server";

const projectInput = {
  projectId: z.string().min(1).describe("harnesst project ID"),
};

const deploymentInput = {
  deploymentId: z.string().min(1).describe("harnesst deployment row ID"),
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
 * session without sending the caller back through harnesst's resource routes.
 */
export function createHarnesstMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: "harnesst", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      description:
        "List the harnesst projects visible to the authenticated caller.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(await service.listProjects()),
  );

  server.registerTool(
    "list_agents",
    {
      description: "List the agents in a harnesst project.",
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
          .describe("Optional harnesst agent ID"),
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
          .describe("Optional harnesst agent ID"),
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
        environmentId: z.string().min(1).describe("harnesst environment ID"),
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
        "Stage one or more agent edits in harnesst's draft area. This is the first step of the authoring flow: stage changes, publish them as one branch and one pull request, then optionally merge that reviewed harnesst PR. This tool never writes to the default branch.",
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
        "Publish selected staged drafts through harnesst's enforced review path: exactly one fresh harnesst/publish-* branch, one commit, and one pull request targeting the project's default branch. It never commits directly to the default branch; use merge_change later only if review is complete.",
      inputSchema: {
        ...projectInput,
        paths: z
          .array(z.string().min(1).describe("Staged repo-relative agent path"))
          .min(1),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Optional pull request title"),
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
    "list_open_changes",
    {
      description:
        "List open harnesst-authored pull requests for a project's connected repository. Use this after publish_changes to review the one-PR change set before optionally calling merge_change; no direct default-branch write tool exists.",
      inputSchema: {
        ...projectInput,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum open harnesst pull requests to return (default 20)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await service.listOpenChanges(input)),
  );

  server.registerTool(
    "merge_change",
    {
      description:
        "Merge an already-open harnesst pull request only after harnesst resolves its server-side branch and confirms it targets this project's default branch. This optional review step is the only authoring tool that can land changes on the default branch; there is no direct-commit surface.",
      inputSchema: {
        ...projectInput,
        pullRequestNumber: z
          .number()
          .int()
          .positive()
          .describe("Open harnesst pull request number to merge"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.mergeChange(input)),
  );

  server.registerTool(
    "discard_changes",
    {
      description:
        "Discard selected staged drafts from harnesst without publishing or touching GitHub. This removes only unpublished staging-area edits and never closes a pull request or writes to the default branch.",
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
