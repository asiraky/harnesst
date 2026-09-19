import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface ArtifactProvenance {
  version: 1;
  gitSha: string;
  agentRoot: string;
  sourceDigest: string;
  contextDigest: string;
  /** Source and identified platform files, relative to /app. */
  files: Record<string, string>;
  platformFiles: string[];
  runtimeDigest: string;
  buildDigest: string;
}
const excluded = new Set([".git", "node_modules", ".output", ".eve"]);
export function manifestDigest(files: Record<string, string>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
}
export async function sourceManifest(
  root: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      const stat = await lstat(target);
      if (stat.isSymbolicLink())
        files[relative] = `symlink:${await readlink(target)}`;
      else if (stat.isDirectory()) await visit(target);
      else if (stat.isFile())
        files[relative] = `sha256:${createHash("sha256")
          .update(await readFile(target))
          .digest("hex")}`;
      else
        throw new Error(
          `Artifact verification failed: unsupported source entry ${relative}`,
        );
    }
  }
  await visit(root);
  return files;
}

// Runs inside both the image and the live container. Check bytes, links and unexpected agent
// files (including a stale file deleted by the commit), without executing customer code.
const VERIFY_SCRIPT = `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const expected=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
function fail(p){throw new Error('Artifact verification failed: source mismatch at '+p)}
for(const [p,want] of Object.entries(expected)){
 if(p.startsWith('/')||p.split('/').includes('..'))fail(p);
 let got;try{const f=path.join('/app',p),s=fs.lstatSync(f);got=s.isSymbolicLink()?'symlink:'+fs.readlinkSync(f):'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}catch{fail(p)}
 if(got!==want)fail(p);
}
function walk(dir){if(!fs.existsSync('/app/'+dir))return;for(const e of fs.readdirSync('/app/'+dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())walk(p);else if(!(p in expected))fail(p)}}
walk('agent');`;

export async function inspectImageDigest(image: string): Promise<string> {
  const { stdout } = await exec("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  const digest = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("Artifact verification failed: invalid image digest");
  return digest;
}
async function verifyFiles(
  prefix: string[],
  files: Record<string, string>,
): Promise<void> {
  try {
    await exec(
      "docker",
      [
        ...prefix,
        "-e",
        VERIFY_SCRIPT,
        Buffer.from(JSON.stringify(files)).toString("base64"),
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    const detail = error as { stderr?: string; message?: string };
    const mismatch = (detail.stderr ?? detail.message ?? "").match(
      /(?:^|\n)(?:Error: )?(Artifact verification failed: source mismatch at [^\r\n]+)/,
    );
    throw new Error(
      mismatch?.[1] ??
        "Artifact verification failed: could not read the image's source files",
    );
  }
}
export async function verifyArtifactImage(
  image: string,
  provenance: ArtifactProvenance,
): Promise<void> {
  const digest = await inspectImageDigest(image);
  if (digest !== provenance.runtimeDigest)
    throw new Error(
      "Artifact verification failed: runtime image digest differs from the release",
    );
  await verifyFiles(
    ["run", "--rm", "--network", "none", "--entrypoint", "node", digest],
    provenance.files,
  );
}
export async function verifyBuildImage(
  provenance: ArtifactProvenance,
): Promise<void> {
  if (
    (await inspectImageDigest(provenance.buildDigest)) !==
    provenance.buildDigest
  )
    throw new Error("Artifact verification failed: build image digest differs");
  await verifyFiles(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      provenance.buildDigest,
    ],
    provenance.files,
  );
}
export async function verifyArtifactContainer(
  containerId: string,
  provenance: ArtifactProvenance,
): Promise<void> {
  const { stdout } = await exec("docker", [
    "inspect",
    "--format",
    "{{.Image}}",
    containerId,
  ]);
  if (stdout.trim() !== provenance.runtimeDigest)
    throw new Error(
      "Artifact verification failed: container image differs from the release",
    );
  await verifyFiles(["exec", containerId, "node"], provenance.files);
}
