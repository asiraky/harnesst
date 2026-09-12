/** Local mobile QA: real auth/database, deterministic read-only GitHub fixtures. */
import { createServer, loadEnv } from "vite";
import { seedArtifacts } from "./artifacts.mjs";
import { writeFileSync } from "node:fs";
Object.assign(process.env, loadEnv("development", process.cwd(), ""));
const database = new URL(process.env.DATABASE_URL);
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  !database.pathname.startsWith("/harnesst_mobile_")
)
  throw new Error(
    "Use a local dedicated database named harnesst_mobile_<name>",
  );
process.env.HARNESST_DISABLE_WORKER = "1";
process.env.HARNESST_DISABLE_SPLITTER = "1";
process.env.HARNESST_DISABLE_RECONCILER = "1";
process.env.MARKETING_HOST = "127.0.0.1";
const sha = "a".repeat(40);
const files = {};
for (const root of [
  "agent",
  "agents/ivy/agent",
  "agents/researcher/agent",
  "agents/ivy/agent/subagents/fact-checker",
  ".harnesst/assistant",
]) {
  Object.assign(files, {
    [`${root}/agent.ts`]:
      'export default { description: "Research customer requests and prepare detailed weekly reports", model: "anthropic/claude-sonnet-4" };',
    [`${root}/instructions.md`]:
      "# Customer operations assistant\n\nHelp the team research customer requests, verify sources, and prepare a clear weekly report.\n\n## Working practices\n- Check facts against the source.\n- Ask before sending messages.\n- Include links and next steps in every handoff.",
    [`${root}/tools/search-customer-records.ts`]:
      'export default { description: "Search customer records", execute: async ({query}) => ({query, results: []}) };',
    [`${root}/skills/weekly-report/SKILL.md`]:
      "# Weekly report\nSummarize customer feedback and highlight follow-up actions.",
    [`${root}/schedules/weekly-report.md`]:
      '---\ncron: "0 9 * * 1"\n---\nPrepare the weekly customer report',
    [`${root}/sandbox.ts`]: "export default { timeout: 60000 };",
    [`${root}/channels/support.ts`]: 'export default { name: "support" };',
  });
}
const sourceFiles = (repo) =>
  Object.fromEntries(
    Object.entries(files).filter(([p]) =>
      repo === "customer-operations"
        ? !p.startsWith("agent/")
        : !p.startsWith("agents/"),
    ),
  );
globalThis.__mobileOctokit = {
  rest: {
    repos: {
      get: async () => ({ data: { default_branch: "main" } }),
      getBranch: async () => ({ data: { commit: { sha } } }),
      getCommit: async () => ({
        data: {
          sha,
          commit: {
            message: "Improve weekly customer reporting",
            author: { name: "Alex Morgan", date: new Date().toISOString() },
          },
        },
      }),
      listCommits: async () => ({
        data: [
          {
            sha,
            author: { login: "alex-morgan" },
            commit: {
              author: { name: "Alex Morgan", date: new Date().toISOString() },
            },
          },
        ],
      }),
      getContent: async ({ path, repo }) => {
        const content = sourceFiles(repo)[path];
        if (content === undefined)
          throw Object.assign(new Error("Not found"), { status: 404 });
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
            sha,
          },
        };
      },
    },
    git: {
      getTree: async ({ repo }) => ({
        data: {
          tree: Object.keys(sourceFiles(repo)).map((path) => ({
            path,
            type: "blob",
            sha,
          })),
          truncated: false,
        },
      }),
      getRef: async () => ({ data: { object: { sha } } }),
    },
  },
  paginate: async () =>
    ["customer-operations", "daily-research"].map((name) => ({
      owner: { login: "northstar" },
      name,
      full_name: `northstar/${name}`,
      default_branch: "main",
      private: true,
    })),
};
const server = await createServer({
  server: {
    watch: { ignored: ["**/artifacts/mobile-sweep/**", "**/.artifacts/**"] },
  },
  plugins: [
    {
      name: "mobile-preview-github",
      enforce: "pre",
      transform(code, id) {
      if (id.endsWith("/tests/e2e/fake-eve.ts")) return code.replace("url.pathname.split", 'url.pathname.replace("/harnesst/v1/session", "/eve/v1/session").split');
        if (id.endsWith("/app/models/provider-catalog.server.ts"))
          return code.replace(
            'if (provider === "codex") return listCodexModels();',
            'return [{ id: "preview-model", name: "Customer research model", description: "Local preview model", contextWindow: 200000, maxOutputTokens: 16000, tags: [], inputPerMTok: 3, outputPerMTok: 15, providers: [provider], supportedEfforts: ["low", "medium", "high"] }];',
          );
        if (!id.endsWith("/app/github/client.server.ts")) return;
        return code
          .replace(
            "export function getGitHubConfig(): GitHubAppConfig {",
            'export function getGitHubConfig(): GitHubAppConfig { return { appId: 1, privateKey: "preview", clientId: "preview", clientSecret: "preview", slug: "mobile-preview" };',
          )
          .replace(
            "export async function getInstallationOctokit(grantId: string | number) {",
            "export async function getInstallationOctokit(grantId: string | number) { return globalThis.__mobileOctokit;",
          );
      },
    },
  ],
});
const { db } = await server.ssrLoadModule("/app/db/client.server.ts");
const s = await server.ssrLoadModule("/app/db/schema.ts");
const harness = await server.ssrLoadModule("/tests/e2e/harness.ts");
const { startFakeEve } = await server.ssrLoadModule("/tests/e2e/fake-eve.ts");
const eve = await startFakeEve();
eve.onTurn(({ sessionId, body, turnIndex }) => {
  const turnId = `preview-${turnIndex}`;
  eve.emit(sessionId, "session.started", {
    runtime: { modelId: "preview-model" },
  });
  eve.emit(sessionId, "message.received", { message: body.message, turnId });
  eve.emit(sessionId, "step.started", { turnId, sequence: 1, stepIndex: 0 });
  const message =
    '## Customer feedback summary\n\nThe report is ready for review. **24 customer conversations** were grouped into onboarding, reporting, and integrations.\n\n| Theme | Customers | Recommendation |\n| --- | --- | --- |\n| Onboarding | 12 | Update the setup guide |\n| Reporting | 8 | Share the weekly report |\n\n```json\n{ "status": "ready", "report": "weekly-customer-feedback-september" }\n```\n\nWhat would you like to explore next?';
  eve.emit(sessionId, "message.appended", { turnId, messageSoFar: message });
  eve.emit(sessionId, "message.completed", { turnId, message });
  eve.emit(sessionId, "step.completed", {
    turnId,
    sequence: 1,
    stepIndex: 0,
    usage: { inputTokens: 1250, outputTokens: 240 },
  });
  eve.emit(sessionId, "turn.completed", { turnId });
  eve.emit(sessionId, "session.waiting", {});
  eve.end(sessionId);
});
const existing = await db.select().from(s.projects);
if (!existing.length) {
  const owner = await harness.signUp("Alex Morgan", "mobile@example.test");
  const orgId = await harness.createWorkspace(
    owner,
    "Northstar Customer Operations",
    "northstar-mobile",
  );
  const [installation] = await db
    .insert(s.githubInstallations)
    .values({
      orgId,
      installationId: "mobile-fixture",
      accountLogin: "northstar",
      verifiedAt: new Date(),
      verifiedByUserId: owner.userId,
    })
    .returning();
  const routes = [];
  for (const [name, layout] of [
    ["customer-operations", "team"],
    ["daily-research", "single"],
  ]) {
    const [project] = await db
      .insert(s.projects)
      .values({
        orgId,
        name:
          name === "customer-operations"
            ? "Customer operations and weekly reporting"
            : "Daily research assistant",
        slug: name,
        layout,
        repoOwner: "northstar",
        repoName: name,
        repoInstallationId: installation.id,
      })
      .returning();
    for (const member of layout === "team"
      ? ["ivy", "researcher"]
      : ["agent"]) {
      const [agent] = await db
        .insert(s.agents)
        .values({
          projectId: project.id,
          name: member,
          root: layout === "team" ? `agents/${member}/agent` : "agent",
        })
        .returning();
      const [env] = await db
        .insert(s.environments)
        .values({
          projectId: project.id,
          agentId: agent.id,
          name: "production",
        })
        .returning();
      const [release] = await db
        .insert(s.releases)
        .values({
          projectId: project.id,
          agentId: agent.id,
          version: "v1.4.2",
          gitSha: sha,
        })
        .returning();
      await db.insert(s.deployments).values({
        environmentId: env.id,
        releaseId: release.id,
        status: "live",
        trafficWeight: 100,
        url: eve.url,
      });
      for (let i = 0; i < 5; i++) {
        await db.insert(s.runs).values({
          projectId: project.id,
          agentId: agent.id,
          releaseId: release.id,
          status: i === 1 ? "failed" : "completed",
          channel: i % 2 ? "schedule" : "http",
          tokensInput: 12000 + i * 1200,
          tokensOutput: 1450,
          wallClockMs: 32456,
          error:
            i === 1
              ? "Customer records service timed out. Please retry the request."
              : null,
          finishedAt: new Date(),
        });
        const [session] = await db
          .insert(s.playgroundSessions)
          .values({
            projectId: project.id,
            agentId: agent.id,
            environmentId: env.id,
            createdBy: owner.userId,
            surface: "foh",
            title: [
              "Prepare the weekly customer feedback report",
              "Review enterprise onboarding questions",
              "Follow up on outstanding support requests",
              "Compare product feedback across regions",
              "Archived planning discussion",
            ][i],
            status: "waiting",
            openingMessage:
              "## Weekly customer feedback\n\nI reviewed **24 conversations** and found three recurring themes: onboarding, reporting, and integrations.\n\n| Theme | Customers | Next step |\n| --- | --- | --- |\n| Onboarding | 12 | Improve the setup guide |\n| Reporting | 8 | Share the weekly report |\n\nWould you like me to prepare a detailed summary for the team?",
            archivedAt: i === 4 ? new Date() : null,
          })
          .returning();
        routes.push(`/t/${name}/${agent.id}/s/${session.id}`);
      }
      await db.insert(s.artifacts).values({
        projectId: project.id,
        agentId: agent.id,
        name: "weekly-customer-feedback-report-september.md",
        title: "Weekly customer feedback and recommended follow-up actions",
        kind: "document",
        contentType: "text/markdown",
        byteSize: 128,
        sha256: sha,
        storagePath: "mobile-preview.md",
        streamIndex: 0,
      });
    }
  }
  const colleague = await harness.signUp(
    "Sam Taylor",
    "sam.taylor@example.test",
  );
  await harness.addMember(colleague, orgId);
  writeFileSync(
    "/tmp/harnesst-mobile-routes.json",
    JSON.stringify(routes, null, 2),
  );
}
await db.update(s.deployments).set({ url: eve.url });
const projects = await db.select().from(s.projects);
const { createApiKeyConnection } = await server.ssrLoadModule(
  "/app/models/provider-connections.server.ts",
);
if (!(await db.select().from(s.modelProviderConnections)).length) {
  const connection = await createApiKeyConnection(
    {
      orgId: projects[0].orgId,
      provider: "anthropic",
      label: "Northstar research",
      apiKey: "local-preview-only",
    },
    { validate: async () => {} },
  );
  await db
    .insert(s.workspaceSettings)
    .values({
      orgId: projects[0].orgId,
      assistantModel: `anthropic/${connection.id}/preview-model`,
    })
    .onConflictDoNothing();
}
const sessions = await db.select().from(s.playgroundSessions);
const runs = await db.select().from(s.runs);
const roster = await db.select().from(s.agents);
writeFileSync(
  "/tmp/harnesst-mobile-routes.json",
  JSON.stringify(
    sessions.map(
      (session) =>
        `/t/${projects.find((p) => p.id === session.projectId).slug}/${session.agentId}/s/${session.id}`,
    ),
    null,
    2,
  ),
);
const recordedSteps = await db.select().from(s.runSteps);
{
  for (const run of runs
    .slice(0, 3)
    .filter((run) => !recordedSteps.some((step) => step.runId === run.id)))
    await db.insert(s.runSteps).values([
      {
        runId: run.id,
        seq: 0,
        type: "message",
        data: {
          role: "user",
          text:
            "Review https://example.test/reports/" +
            "customer-feedback-".repeat(12),
        },
      },
      {
        runId: run.id,
        seq: 1,
        type: "tool_call",
        toolName: "search-customer-records",
        durationMs: 1250,
        data: {
          input: { query: "September feedback" },
          output: { matches: 24 },
        },
      },
      {
        runId: run.id,
        seq: 2,
        type: "message",
        data: {
          role: "assistant",
          text: "Reviewed 24 customer conversations. The main requests were onboarding improvements and weekly reporting.",
        },
      },
    ]);
}
writeFileSync(
  "/tmp/harnesst-mobile-run-routes.json",
  JSON.stringify(
    runs.map((run) => {
      const project = projects.find((p) => p.id === run.projectId);
      const agent = roster.find((a) => a.id === run.agentId);
      return `/repos/${project.slug}${project.layout === "team" && agent ? `/agents/${agent.name}` : ""}/runs/${run.id}`;
    }),
    null,
    2,
  ),
);
await seedArtifacts(server, db, s);
await server.listen();
server.printUrls();
console.log(
  "Mobile preview: mobile@example.test / correct-horse-battery-staple",
);
