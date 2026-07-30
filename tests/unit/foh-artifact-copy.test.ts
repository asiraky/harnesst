/**
 * `copyArtifactFromInstance` (#290) against a fake docker streamer — the confinement half.
 *
 * The path check in `artifact-media.ts` is textual, so it says nothing about where a LINK inside the
 * home volume points. `docker cp -L` used to dereference it, which let anything image-shaped
 * elsewhere in the instance container be published. So the path is resolved to its real path inside
 * the container FIRST, re-checked against the home root, and copied without `-L` — and a link that
 * appears between the two steps arrives as a payload-less entry and is refused.
 */
import { describe, expect, it } from "vitest";

import {
  copyArtifactBundleFromInstance,
  copyArtifactFromInstance,
  filesInTar,
  firstFileInTar,
  type DockerStreamer,
  type StreamResult,
} from "~/foh/artifact-copy.server";

const TAR_BLOCK = 512;

/**
 * One tar entry: type "0" is a regular file, "2" a symlink (no payload), "5" a directory, "x" a PAX
 * extension record.
 */
function tarEntry(
  name: string,
  body: Buffer,
  type: "0" | "2" | "5" | "x" = "0",
  linkName = "",
): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, "utf8");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  header.write(type, 156, 1, "utf8");
  if (linkName) header.write(linkName, 157, 100, "utf8");
  const padded = Math.ceil(body.length / TAR_BLOCK) * TAR_BLOCK;
  return Buffer.concat([header, body, Buffer.alloc(padded - body.length, 0)]);
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09]);

/**
 * A streamer that answers the resolve step with `verdict\ndetail` and the copy step with a tar,
 * recording every argv it was handed so the test can assert what docker was actually asked to do.
 */
function fakeDocker(over: {
  resolve?: StreamResult;
  copy?: StreamResult;
}): DockerStreamer & { calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerStreamer = async (args) => {
    calls.push(args);
    if (args[0] === "exec") {
      return (
        over.resolve ?? {
          ok: true as const,
          stdout: Buffer.from("file\n/workspace/home/artifacts/chart.png"),
        }
      );
    }
    return (
      over.copy ?? { ok: true as const, stdout: tarEntry("chart.png", PNG) }
    );
  };
  return Object.assign(run, { calls });
}

const input = {
  deploymentId: "dep_1",
  path: "/workspace/home/artifacts/chart.png",
  maxBytes: 1024 * 1024,
};

describe("copyArtifactFromInstance", () => {
  it("copies the path the container resolved, and never with -L", async () => {
    const docker = fakeDocker({
      resolve: {
        ok: true,
        stdout: Buffer.from("file\n/workspace/home/agent-browser/screenshots/2.png"),
      },
    });

    const result = await copyArtifactFromInstance(input, docker);

    expect(result).toEqual({ ok: true, bytes: PNG });
    const [resolve, copy] = docker.calls;
    expect(resolve[0]).toBe("exec");
    // The path travels as its own argv entry: nothing is interpolated into a shell.
    expect(resolve.at(-1)).toBe(input.path);
    expect(copy).not.toContain("-L");
    // The RESOLVED path is what is read — not the one the agent named.
    expect(copy).toContain(
      "harnesst-inst-dep_1:/workspace/home/agent-browser/screenshots/2.png",
    );
  });

  it("refuses a link that resolves outside the home volume", async () => {
    const docker = fakeDocker({
      resolve: { ok: true, stdout: Buffer.from("file\n/root/.config/creds.png") },
    });

    const result = await copyArtifactFromInstance(input, docker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/points outside \/workspace\/home/);
    // Refused BEFORE the copy: the bytes are never read at all.
    expect(docker.calls).toHaveLength(1);
  });

  it("refuses a link swapped in after the resolve (the copy sees a link entry)", async () => {
    const docker = fakeDocker({
      copy: {
        ok: true,
        stdout: tarEntry("chart.png", Buffer.alloc(0), "2", "/root/.ssh/id.png"),
      },
    });

    const result = await copyArtifactFromInstance(input, docker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not a regular file/);
  });

  it("reports a missing file, a directory and a link loop as readable refusals", async () => {
    const cases: Array<[StreamResult, RegExp]> = [
      [{ ok: true, stdout: Buffer.from("error\nENOENT") }, /no file at/i],
      [{ ok: true, stdout: Buffer.from("error\nELOOP") }, /loop of links/i],
      [
        { ok: true, stdout: Buffer.from("notfile\n/workspace/home/artifacts") },
        /not a regular file/i,
      ],
    ];
    for (const [resolve, expected] of cases) {
      const result = await copyArtifactFromInstance(
        input,
        fakeDocker({ resolve }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(expected);
    }
  });

  it("reports a stopped or missing instance as unreachable, not as a broken file", async () => {
    const docker = fakeDocker({
      resolve: {
        ok: false,
        error: "Error response from daemon: Container abc is not running",
      },
    });

    const result = await copyArtifactFromInstance(input, docker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/can't reach this agent's instance/i);
  });

  it("refuses an oversized file while it is still streaming", async () => {
    const docker = fakeDocker({
      copy: { ok: false, error: "overflow", overflow: true },
    });

    const result = await copyArtifactFromInstance(
      { ...input, maxBytes: 25 * 1024 * 1024 },
      docker,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/larger than the 25 MB artifact limit/);
  });
});

describe("firstFileInTar", () => {
  it("skips a leading directory entry and returns the regular file", () => {
    const tar = Buffer.concat([
      tarEntry("artifacts/", Buffer.alloc(0), "5"),
      tarEntry("artifacts/chart.png", PNG),
    ]);
    expect(firstFileInTar(tar)).toEqual({ name: "artifacts/chart.png", bytes: PNG });
  });

  it("returns null for an archive whose only entry carries no payload", () => {
    expect(
      firstFileInTar(tarEntry("chart.png", Buffer.alloc(0), "2", "/etc/shadow")),
    ).toBeNull();
  });
});

/**
 * The bundle walk (#291) is strict where `firstFileInTar` is lenient, and that asymmetry IS the
 * confinement boundary: resolving a directory's realpath proves nothing about the files under it, so
 * a link entry inside the archive is the only signal left that a member points elsewhere. Skipping
 * one would publish a page missing its linked file; interpreting one would publish the link's target.
 */
describe("filesInTar", () => {
  const html = Buffer.from("<html>hi</html>");

  it("returns every regular file and ignores directory entries", () => {
    const tar = Buffer.concat([
      tarEntry("site/", Buffer.alloc(0), "5"),
      tarEntry("site/index.html", html),
      tarEntry("site/assets/", Buffer.alloc(0), "5"),
      tarEntry("site/assets/app.css", Buffer.from("body{}")),
    ]);

    const walk = filesInTar(tar, 10);

    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.files.map((f) => f.name)).toEqual([
      "site/index.html",
      "site/assets/app.css",
    ]);
    expect(walk.files[0].bytes).toEqual(html);
  });

  it("refuses a link entry rather than skipping past it", () => {
    const tar = Buffer.concat([
      tarEntry("site/index.html", html),
      tarEntry("site/secret.png", Buffer.alloc(0), "2", "/root/.ssh/id.png"),
    ]);
    expect(filesInTar(tar, 10)).toEqual({ ok: false, reason: "link" });
  });

  it("refuses more files than the cap allows", () => {
    const tar = Buffer.concat([
      tarEntry("site/a.html", html),
      tarEntry("site/b.css", html),
      tarEntry("site/c.css", html),
    ]);
    expect(filesInTar(tar, 2)).toEqual({ ok: false, reason: "count" });
    expect(filesInTar(tar, 3).ok).toBe(true);
  });

  it("refuses extension records instead of mis-framing the header that follows one", () => {
    const pax = Buffer.concat([
      tarEntry("PaxHeaders/index.html", Buffer.from("30 path=whatever\n"), "x"),
      tarEntry("site/index.html", html),
    ]);
    expect(filesInTar(pax, 10)).toEqual({ ok: false, reason: "extended" });
  });

  it("refuses a header whose size runs past the end of the archive", () => {
    const truncated = tarEntry("site/index.html", html).subarray(
      0,
      TAR_BLOCK + 4,
    );
    expect(filesInTar(truncated, 10)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("copyArtifactBundleFromInstance", () => {
  const html = Buffer.from("<html>hi</html>");
  const css = Buffer.from("body{color:red}");
  const bundleInput = {
    deploymentId: "dep_1",
    path: "/workspace/home/artifacts/site",
    maxBytes: 1024 * 1024,
    maxFiles: 10,
  };
  const dirDocker = (copy: StreamResult) =>
    fakeDocker({
      resolve: {
        ok: true,
        stdout: Buffer.from("dir\n/workspace/home/artifacts/site"),
      },
      copy,
    });

  it("re-roots every member against the directory's basename", async () => {
    const docker = dirDocker({
      ok: true,
      stdout: Buffer.concat([
        tarEntry("site/", Buffer.alloc(0), "5"),
        tarEntry("site/index.html", html),
        tarEntry("site/assets/app.css", css),
      ]),
    });

    const result = await copyArtifactBundleFromInstance(bundleInput, docker);

    expect(result).toEqual({
      ok: true,
      files: [
        { name: "index.html", bytes: html },
        { name: "assets/app.css", bytes: css },
      ],
    });
    // The RESOLVED directory is copied, and never with -L.
    expect(docker.calls[1]).toContain(
      "harnesst-inst-dep_1:/workspace/home/artifacts/site",
    );
    expect(docker.calls[1]).not.toContain("-L");
  });

  it("takes a single HTML file, whose archive is one entry named after the file", async () => {
    const docker = fakeDocker({
      // A plain file resolves as one: the bundle copy accepts a directory as well, not instead.
      resolve: {
        ok: true,
        stdout: Buffer.from("file\n/workspace/home/artifacts/page.html"),
      },
      copy: { ok: true, stdout: tarEntry("page.html", html) },
    });

    const result = await copyArtifactBundleFromInstance(
      { ...bundleInput, path: "/workspace/home/artifacts/page.html" },
      docker,
    );

    expect(result).toEqual({ ok: true, files: [{ name: "page.html", bytes: html }] });
  });

  it("refuses an entry that does not sit under the copied root rather than re-rooting it", async () => {
    const docker = dirDocker({
      ok: true,
      stdout: Buffer.concat([
        tarEntry("site/index.html", html),
        tarEntry("../../etc/passwd", Buffer.from("root:x:0:0")),
      ]),
    });

    const result = await copyArtifactBundleFromInstance(bundleInput, docker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/from outside the directory/);
  });

  it("turns the walk's refusals into copy the agent can act on", async () => {
    const link = await copyArtifactBundleFromInstance(
      bundleInput,
      dirDocker({
        ok: true,
        stdout: Buffer.concat([
          tarEntry("site/index.html", html),
          tarEntry("site/logo.png", Buffer.alloc(0), "2", "/root/id.png"),
        ]),
      }),
    );
    expect(link.ok).toBe(false);
    if (link.ok) return;
    expect(link.error).toMatch(/contains a symlink/i);

    const tooMany = await copyArtifactBundleFromInstance(
      { ...bundleInput, maxFiles: 1 },
      dirDocker({
        ok: true,
        stdout: Buffer.concat([
          tarEntry("site/index.html", html),
          tarEntry("site/app.css", css),
        ]),
      }),
    );
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.error).toMatch(/at most 1 files/);
  });

  it("refuses a page bigger than the byte ceiling once the members are SUMMED", async () => {
    // Neither member is over the limit on its own — charging per file is how a page would spend the
    // ceiling a stylesheet at a time.
    const big = Buffer.alloc(700 * 1024, 0x61);
    const docker = dirDocker({
      ok: true,
      stdout: Buffer.concat([
        tarEntry("site/index.html", big),
        tarEntry("site/app.css", big),
      ]),
    });

    const result = await copyArtifactBundleFromInstance(
      { ...bundleInput, maxBytes: 1024 * 1024 },
      docker,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/larger than the 1 MB artifact limit/);
  });

  it("refuses an empty directory and an all-empty page", async () => {
    const empty = await copyArtifactBundleFromInstance(
      bundleInput,
      dirDocker({ ok: true, stdout: tarEntry("site/", Buffer.alloc(0), "5") }),
    );
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toMatch(/no files to publish/i);

    const blank = await copyArtifactBundleFromInstance(
      bundleInput,
      dirDocker({ ok: true, stdout: tarEntry("site/index.html", Buffer.alloc(0)) }),
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error).toMatch(/is empty/i);
  });

  it("still refuses a directory that resolves outside the home volume", async () => {
    const docker = fakeDocker({
      resolve: { ok: true, stdout: Buffer.from("dir\n/root/.ssh") },
    });

    const result = await copyArtifactBundleFromInstance(bundleInput, docker);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/points outside \/workspace\/home/);
    expect(docker.calls).toHaveLength(1);
  });
});
