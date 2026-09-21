/**
 * Real eve build + runtime threshold regression, using an existing agent build image.
 * Usage: npx tsx scripts/smoke-inherited-compaction.ts <build-image>
 * No credentials, network calls to model providers, deployments, or Docker socket in the container.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { withAgentBuildContextWindow } from "../app/eve/model-build-context";
import {
  orgModelModuleSource,
  scaffoldOrgModelAgentModule,
} from "../app/eve/org-model-module";
import { resetAgentModelSource } from "../app/eve/reset-model";

const image = process.argv[2];
if (!image)
  throw new Error(
    "Pass an existing eve agent build image (with node_modules installed).",
  );
const directory = mkdtempSync(path.join(tmpdir(), "harnesst-compaction-"));
try {
  mkdirSync(path.join(directory, "agent"));
  mkdirSync(path.join(directory, "harnesst"));
  writeFileSync(
    path.join(directory, "agent/instructions.md"),
    "Reply to the user.",
  );
  writeFileSync(
    path.join(directory, "agent/agent.ts"),
    resetAgentModelSource(
      `import { defineAgent } from 'eve'; export default defineAgent({
      model: 'anthropic/claude-sonnet-4', modelContextWindowTokens: 200000,
      compaction: { thresholdPercent: 0.75 },
    });`,
      "intake",
      "",
      128000,
    ),
  );
  mkdirSync(path.join(directory, "agent/subagents/qa"), { recursive: true });
  writeFileSync(
    path.join(directory, "agent/subagents/qa/instructions.md"),
    "Review the answer.",
  );
  writeFileSync(
    path.join(directory, "agent/subagents/qa/agent.ts"),
    withAgentBuildContextWindow(
      scaffoldOrgModelAgentModule("intake", {
        subagentPath: "qa",
        description: "Review answers",
      }),
      64000,
    ),
  );
  writeFileSync(
    path.join(directory, "harnesst/model.ts"),
    orgModelModuleSource(),
  );
  writeFileSync(
    path.join(directory, "model.mjs"),
    ts.transpileModule(orgModelModuleSource(), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  );
  writeFileSync(
    path.join(directory, "runtime.mjs"),
    readFileSync(
      new URL(
        "../tests/fixtures/inherited-compaction/runtime.mjs",
        import.meta.url,
      ),
    ),
  );
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${directory}:/fixture:ro`,
      image,
      "sh",
      "-c",
      "rm -rf agent harnesst .eve .output; cp -r /fixture/agent /fixture/harnesst .; cp /fixture/model.mjs /fixture/runtime.mjs .; node_modules/.bin/eve build && node runtime.mjs",
    ],
    { stdio: "inherit" },
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
