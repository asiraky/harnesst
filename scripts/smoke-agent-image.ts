#!/usr/bin/env tsx
/**
 * Build the smallest imported agent harnesst supports: no dependencies declared, plus the
 * platform-generated notify-user tool. This exercises the real reference Dockerfile so a change
 * cannot reintroduce the gap where `npm exec` can run Eve but authored imports and runtime startup
 * cannot resolve it from the project.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "harnesst-agent-image-smoke-"));

try {
  // eve-image.server's production dependency graph initializes the lazy DB client at import time;
  // the smoke never queries it, but CI intentionally has no application database configured.
  process.env.DATABASE_URL ||= "postgres://smoke:smoke@127.0.0.1:5432/smoke";
  const { HARNESST_EVE_DOCKERFILE } = await import("~/deploy/eve-image.server");
  const { NOTIFY_USER_TOOL_PATH, NOTIFY_USER_TOOL_SOURCE } =
    await import("~/team/tool-template");

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

  await exec("docker", ["build", "--target", "build", root], {
    maxBuffer: 64 * 1024 * 1024,
  });
  console.log("smoke-agent-image: ok (dependency-less imported agent)");
} finally {
  await rm(root, { recursive: true, force: true });
}
