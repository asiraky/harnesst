/** Real-Docker regression for #393. Optional HARNESST_PROBE_BASE uses an existing Node image. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeContextMtimes } from "../app/deploy/eve-image.server";
import {
  inspectImageDigest,
  manifestDigest,
  sourceManifest,
  verifyArtifactImage,
  type ArtifactProvenance,
} from "../app/deploy/artifact-provenance.server";
const exec = promisify(execFile);
const scratch = await mkdtemp(path.join(tmpdir(), "harnesst-393-"));
const tags: string[] = [];
try {
  const base = process.env.HARNESST_PROBE_BASE ?? "node:24-slim";
  const members = ["intake", "infra", "implementer"];
  await Promise.all(
    members.map(async (member) => {
      const dir = path.join(scratch, member);
      await mkdir(path.join(dir, "agent"), { recursive: true });
      await writeFile(
        path.join(dir, "Dockerfile"),
        `FROM ${base} AS build\nWORKDIR /app\nRUN rm -rf agent .output\nCOPY agent ./agent\nRUN mkdir .output && cp agent/model.json .output/model.json\nFROM build\nCMD ["node", "-e", "console.log(require('./.output/model.json').model)"]\n`,
      );
      let previousModel: string | undefined;
      for (const model of [
        "codex/agkfcrrnbnrv/gpt-5.6-sol",
        "codex/aibgvjibqqal/gpt-5.6-sol",
        "codex/aibgvjibqqal/gpt-5.6-sol",
      ]) {
        await writeFile(
          path.join(dir, "agent/model.json"),
          JSON.stringify({ member, model }),
        );
        await normalizeContextMtimes(dir);
        const files = await sourceManifest(dir);
        const tag = `harnesst/issue-393-probe:${member}-${randomUUID()}`;
        tags.push(tag);
        const { stderr } = await exec(
          "docker",
          ["build", "--progress=plain", "-t", tag, dir],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        const digest = await inspectImageDigest(tag);
        const provenance: ArtifactProvenance = {
          version: 1,
          gitSha: "smoke",
          agentRoot: "agent",
          sourceDigest: manifestDigest(files),
          contextDigest: manifestDigest(files),
          files: { "agent/model.json": files["agent/model.json"] },
          platformFiles: [],
          runtimeDigest: digest,
          buildDigest: digest,
        };
        await verifyArtifactImage(digest, provenance);
        const { stdout } = await exec("docker", [
          "run",
          "--rm",
          "--network",
          "none",
          "--entrypoint",
          "node",
          digest,
          "-e",
          "console.log(require('/app/.output/model.json').model)",
        ]);
        if (stdout.trim() !== model)
          throw new Error(
            `${member}: compiled/runtime model differs from source`,
          );
        if (previousModel === model) {
          const compileStep = stderr.match(
            /#(\d+) \[[^\]]+\] RUN mkdir \.output/,
          );
          if (!compileStep || !stderr.includes(`#${compileStep[1]} CACHED`))
            throw new Error(
              `${member}: unchanged compile did not cache\n${stderr}`,
            );
          console.log(
            `${member}: unchanged source reused the cached compilation (${digest})`,
          );
        } else
          console.log(
            `${member}: exact source and compiled runtime verified for ${model}`,
          );
        previousModel = model;
      }
    }),
  );
} finally {
  for (const tag of tags) await exec("docker", ["rmi", tag]).catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
