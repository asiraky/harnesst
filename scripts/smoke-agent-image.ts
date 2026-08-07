#!/usr/bin/env tsx
/**
 * Build and boot the smallest imported agent harnesst supports. Besides proving the reference
 * Dockerfile can supply Eve to a dependency-less repo, this crosses Eve's real build/runtime
 * boundary for delegation tools: the image is built without HARNESST_TEAMMATES, then started with
 * a roster, and a fake OpenAI-compatible model asserts the runtime tool descriptions and schemas.
 * The fake model calls ask-teammate too, proving a session-scoped dynamic executor survives Eve's
 * durable metadata replay into the action step.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "harnesst-agent-image-smoke-"));
const imageTag = `harnesst-agent-image-smoke:${process.pid}`;
let containerId: string | undefined;
let modelRequests: Array<Record<string, unknown>> = [];
let relayRequest: Record<string, unknown> | undefined;

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >)
    : {};

  if (request.url === "/api/team/ask") {
    relayRequest = body;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, answer: "runtime relay reached" }));
    return;
  }
  if (request.url !== "/v1/chat/completions") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  modelRequests.push(body);
  response.setHeader("content-type", "text/event-stream");
  const firstCall = modelRequests.length === 1;
  const delta = firstCall
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "delegation-smoke-call",
            type: "function",
            function: {
              name: "ask-teammate",
              arguments: JSON.stringify({
                teammate: "runtime-peer",
                message: "Confirm the runtime executor works.",
              }),
            },
          },
        ],
      }
    : { role: "assistant", content: "done" };
  response.write(
    `data: ${JSON.stringify({
      id: `smoke-${modelRequests.length}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "smoke-model",
      choices: [
        {
          index: 0,
          delta,
          finish_reason: firstCall ? "tool_calls" : "stop",
        },
      ],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "0.0.0.0", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("smoke model server did not bind a TCP port");
}
const hostPort = address.port;

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  // eve-image.server's production dependency graph initializes the lazy DB client at import time;
  // the smoke never queries it, but CI intentionally has no application database configured.
  process.env.DATABASE_URL ||= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
  const { HARNESST_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
  const {
    ASK_TEAMMATE_TOOL_PATH,
    ASK_TEAMMATE_TOOL_SOURCE,
    NOTIFY_USER_TOOL_PATH,
    NOTIFY_USER_TOOL_SOURCE,
    TELL_TEAMMATE_TOOL_PATH,
    TELL_TEAMMATE_TOOL_SOURCE,
  } = await import("~/team/tool-template");

  await mkdir(path.join(root, path.dirname(NOTIFY_USER_TOOL_PATH)), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "harnesst-agent-image-smoke",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "agent/agent.ts"),
    `import { defineAgent } from "eve";\n\nexport default defineAgent({ model: "openai/gpt-5.4" });\n`,
  );
  await writeFile(
    path.join(root, "agent/instructions.md"),
    "You are the harnesst agent-image smoke fixture.\n",
  );
  await writeFile(
    path.join(root, NOTIFY_USER_TOOL_PATH),
    NOTIFY_USER_TOOL_SOURCE,
  );
  await writeFile(path.join(root, "Dockerfile"), HARNESST_EVE_DOCKERFILE);

  // Keep the original compatibility coverage: a dependency-less imported repo can compile because
  // the reference image installs its fallback Eve release before authored imports are resolved.
  await exec("docker", ["build", "--target", "build", root], {
    maxBuffer: 64 * 1024 * 1024,
  });

  // The runtime regression uses the production Eve release from issue #361 plus a local fake model.
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "harnesst-agent-image-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@ai-sdk/openai-compatible": "3.0.7",
          eve: "0.22.6",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "agent/agent.ts"),
    `import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const smoke = createOpenAICompatible({
  name: "smoke",
  baseURL: "http://host.docker.internal:${hostPort}/v1",
  apiKey: "smoke-key",
});

export default defineAgent({
  model: smoke.chatModel("smoke-model"),
  modelContextWindowTokens: 100_000,
});
`,
  );
  await writeFile(
    path.join(root, ASK_TEAMMATE_TOOL_PATH),
    ASK_TEAMMATE_TOOL_SOURCE,
  );
  await writeFile(
    path.join(root, TELL_TEAMMATE_TOOL_PATH),
    TELL_TEAMMATE_TOOL_SOURCE,
  );

  // Deliberately no HARNESST_TEAMMATES build arg/env: the manifest must not freeze an empty roster.
  await exec("docker", ["build", "-t", imageTag, root], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const started = await exec("docker", [
    "run",
    "--detach",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--publish",
    "127.0.0.1::3000",
    "--env",
    `HARNESST_TEAMMATES=${JSON.stringify([
      {
        name: "runtime-peer",
        role: "Available only in the running container.",
      },
    ])}`,
    "--env",
    `HARNESST_TEAM_URL=http://host.docker.internal:${hostPort}`,
    "--env",
    "HARNESST_TEAM_TOKEN=smoke-token",
    imageTag,
  ]);
  containerId = started.stdout.trim();

  const port = (await exec("docker", ["port", containerId, "3000/tcp"])).stdout
    .trim()
    .split(":")
    .at(-1);
  if (!port) throw new Error("smoke container did not publish Eve's port");

  const healthUrl = `http://127.0.0.1:${port}/eve/v1/health`;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const health = await fetch(healthUrl);
      if (health.ok) break;
    } catch {}
    if (Date.now() >= deadline)
      throw new Error("Eve smoke container did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const turn = await fetch(`http://127.0.0.1:${port}/eve/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Delegate this smoke test." }),
  });
  if (!turn.ok) {
    throw new Error(
      `Eve rejected the smoke turn (${turn.status}): ${await turn.text()}`,
    );
  }
  await waitFor(
    () => modelRequests.length >= 2,
    "the completed model/tool loop",
  );
  await waitFor(
    () => relayRequest !== undefined,
    "the replayed delegation executor",
  );

  const tools = modelRequests[0]?.tools;
  if (!Array.isArray(tools))
    throw new Error("model request did not contain tools");
  for (const name of ["ask-teammate", "tell-teammate"]) {
    const tool = tools.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as { function?: { name?: unknown } }).function?.name ===
          name,
    ) as
      | {
          function?: {
            description?: unknown;
            parameters?: { properties?: { teammate?: { enum?: unknown } } };
          };
        }
      | undefined;
    if (!tool) throw new Error(`model request omitted ${name}`);
    if (!String(tool.function?.description).includes("runtime-peer")) {
      throw new Error(`${name} description used the build-time empty roster`);
    }
    const teammateEnum = tool.function?.parameters?.properties?.teammate?.enum;
    if (JSON.stringify(teammateEnum) !== JSON.stringify(["runtime-peer"])) {
      throw new Error(`${name} schema did not expose the runtime roster`);
    }
  }
  if (
    relayRequest?.mode !== "ask" ||
    relayRequest.teammate !== "runtime-peer"
  ) {
    throw new Error(
      "replayed ask-teammate executor sent the wrong relay request",
    );
  }

  console.log("smoke-agent-image: ok (runtime delegation roster and executor)");
} finally {
  if (containerId) {
    await exec("docker", ["stop", containerId]).catch(() => {});
  }
  await exec("docker", ["image", "rm", imageTag]).catch(() => {});
  server.close();
  await rm(root, { recursive: true, force: true });
}
