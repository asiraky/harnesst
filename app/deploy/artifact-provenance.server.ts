import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import dockerignore from "@balena/dockerignore";

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
      if (dir === root && excluded.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      const stat = await lstat(target);
      if (stat.isSymbolicLink())
        files[relative] = `symlink:${await readlink(target)}:mode:120000`;
      else if (stat.isDirectory()) await visit(target);
      else if (stat.isFile())
        files[relative] = `sha256:${createHash("sha256")
          .update(await readFile(target))
          .digest("hex")}:mode:${stat.mode & 0o111 ? "100755" : "100644"}`;
      else
        throw new Error(
          `Artifact verification failed: unsupported source entry ${relative}`,
        );
    }
  }
  await visit(root);
  return files;
}

/** Match Docker's case-sensitive context exclusions; agent configuration is never optional. */
export async function runtimeSourceManifest(
  root: string,
  files: Record<string, string>,
): Promise<Record<string, string>> {
  let patterns = "";
  for (const name of ["Dockerfile.dockerignore", ".dockerignore"]) {
    try {
      patterns = await readFile(path.join(root, name), "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const matcher = dockerignore({ ignorecase: false }).add(patterns);
  return Object.fromEntries(
    Object.entries(files).filter(([name]) => {
      if (
        name === "Dockerfile" ||
        name === ".dockerignore" ||
        name === "Dockerfile.dockerignore"
      )
        return false;
      if (!matcher.ignores(name)) return true;
      if (name === "agent" || name.startsWith("agent/"))
        throw new Error(
          `Artifact verification failed: .dockerignore excludes required configuration ${name}`,
        );
      return false;
    }),
  );
}

// Runs inside both the image and the live container. Check bytes, links and unexpected agent
// files (including a stale file deleted by the commit), without executing customer code.
const VERIFY_SCRIPT = `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const expected=JSON.parse(fs.readFileSync(0,'utf8'));
function fail(p){throw new Error('Artifact verification failed: source mismatch at '+p)}
for(const [p,want] of Object.entries(expected)){
 if(p.startsWith('/')||p.split('/').includes('..'))fail(p);
 let got;try{const f=path.join('/app',p),s=fs.lstatSync(f);got=s.isSymbolicLink()?'symlink:'+fs.readlinkSync(f):'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');if(/:mode:[0-7]+$/.test(want))got+=':mode:'+(s.isSymbolicLink()?'120000':s.mode&73?'100755':'100644')}catch{fail(p)}
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
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "docker",
        [...prefix, "-e", VERIFY_SCRIPT],
        { maxBuffer: 16 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve();
        },
      );
      child.stdin?.on("error", reject);
      child.stdin?.end(JSON.stringify(files));
    });
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
    ["run", "-i", "--rm", "--network", "none", "--entrypoint", "node", digest],
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
      "-i",
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
  await verifyFiles(["exec", "-i", containerId, "node"], provenance.files);
}

/** Verify the previously checked image and unchanged source layer before starting channels. */
export async function verifyStoppedArtifactContainer(
  containerId: string,
  provenance: ArtifactProvenance,
): Promise<void> {
  const { stdout: digest } = await exec("docker", [
    "inspect",
    "--format",
    "{{.Image}}",
    containerId,
  ]);
  if (digest.trim() !== provenance.runtimeDigest)
    throw new Error(
      "Artifact verification failed: container image differs from the release. Redeploy to rebuild and verify this release.",
    );
  const { stdout: changes } = await exec("docker", ["diff", containerId]);
  const expected = Object.keys(provenance.files).map((name) => `/app/${name}`);
  for (const line of changes.split("\n")) {
    if (!line) continue;
    const operation = line.slice(0, 1),
      changed = line.slice(2);
    if (
      changed === "/app/agent" ||
      changed.startsWith("/app/agent/") ||
      expected.includes(changed) ||
      (operation !== "C" &&
        expected.some((name) => name.startsWith(changed + "/")))
    ) {
      throw new Error(
        `Artifact verification failed: source changed in stopped container at ${changed}. Redeploy to rebuild and verify this release.`,
      );
    }
  }
}
