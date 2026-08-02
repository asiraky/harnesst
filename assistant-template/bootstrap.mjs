// Container boot: materialize the user config layer before the agent compiles.
//
// eve discovers instructions.md / skills / schedules at BUILD time, not at `eve start`
// so the entrypoint fetches the project's PUBLISHED .harnesst/assistant
// config from harnesst, writes it into this fixed image, and — if any user layer was written —
// re-runs `eve build` before `eve start`. On persistent fetch failure it starts with the fixed
// layer only, so a control-plane hiccup never bricks the assistant.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const API_URL = process.env.HARNESST_API_URL;
const TOKEN = process.env.HARNESST_ASSISTANT_TOKEN;
const APP = process.cwd();
const INSTRUCTIONS = join(APP, "agent", "instructions.md");
const USER_MARKER = join(APP, ".harnesst-user-layer");
const ENV_FILE = join(APP, ".harnesst-assistant-env");
const MARKER = "\n\n## Project instructions (user-configured)\n\n";
const MANAGED_SKILL_PREFIXES = ["harnesst-user-", "harnesst-installed-"];

/** Quote an arbitrary value as one POSIX-shell assignment without allowing expansion. */
function shellAssignment(name, value) {
  const quoted = "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return `${name}=${quoted}\n`;
}

async function fetchBundle() {
  if (!API_URL || !TOKEN) {
    console.warn(
      "[assistant] HARNESST_API_URL / HARNESST_ASSISTANT_TOKEN unset — fixed layer only.",
    );
    return null;
  }
  const url = API_URL.replace(/\/+$/, "") + "/api/assistant/bundle";
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { authorization: "Bearer " + TOKEN },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.json();
      console.warn(
        `[assistant] bundle fetch ${res.status} (attempt ${attempt}/5)`,
      );
    } catch (error) {
      console.warn(
        `[assistant] bundle fetch failed (attempt ${attempt}/5): ${error?.message ?? error}`,
      );
    }
    await new Promise((r) => setTimeout(r, Math.min(attempt * 1500, 6000)));
  }
  console.warn(
    "[assistant] bundle fetch gave up — starting with the fixed layer only.",
  );
  return null;
}

async function reset() {
  // Idempotent across restarts (docker start re-runs this): strip any previously-applied user
  // layer so appends/dirs never stack. Truncate instructions.md at the marker, and wipe the
  // materialized user dirs + flag files.
  try {
    const current = await readFile(INSTRUCTIONS, "utf8");
    const cut = current.indexOf(MARKER);
    if (cut >= 0) await writeFile(INSTRUCTIONS, current.slice(0, cut));
  } catch {
    /* instructions.md always exists in the image; ignore */
  }
  await rm(join(APP, "agent", "skills", "user"), {
    recursive: true,
    force: true,
  });
  await rm(join(APP, "agent", "skills", "installed"), {
    recursive: true,
    force: true,
  });
  // Managed skills are flat files with reserved prefixes. Remove the previous boot's copies;
  // keep removing the legacy directories above so upgraded containers clean the invalid layout.
  const skillsDir = join(APP, "agent", "skills");
  const skillEntries = await readdir(skillsDir).catch(() => []);
  const staleManagedSkills = [];
  for (const name of skillEntries) {
    if (MANAGED_SKILL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      staleManagedSkills.push(
        rm(join(skillsDir, name), { recursive: true, force: true }),
      );
    }
  }
  await Promise.all(staleManagedSkills);
  await rm(join(APP, "agent", "schedules", "user"), {
    recursive: true,
    force: true,
  });
  await rm(USER_MARKER, { force: true });
  await rm(ENV_FILE, { force: true });
}

async function main() {
  // Whether the PREVIOUS boot materialized a user layer (marker "1"): if it did and this bundle
  // turns out empty (last skill uninstalled, all config deleted), the compiled artifact still
  // carries the old layer — ONE more rebuild is needed to compile the removal out. Marker "0"
  // records exactly that removal boot, so the boot after it takes the fast path again.
  const hadUserLayer = await readFile(USER_MARKER, "utf8").then(
    (content) => content === "1",
    () => false,
  );
  await reset();
  const bundle = await fetchBundle();
  if (!bundle || typeof bundle !== "object") return;

  let wroteUserLayer = false;

  // Managed flat skills and user schedules → their validated agent-relative bundle paths.
  const files =
    bundle.files && typeof bundle.files === "object" ? bundle.files : {};
  for (const [rel, content] of Object.entries(files)) {
    if (typeof content !== "string") continue;
    const dest = join(APP, "agent", rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content);
    wroteUserLayer = true;
  }

  // User instructions appended to the fixed instructions.md under a clear marker.
  if (typeof bundle.instructions === "string" && bundle.instructions.trim()) {
    const fixed = await readFile(INSTRUCTIONS, "utf8");
    await writeFile(
      INSTRUCTIONS,
      fixed + MARKER + bundle.instructions.trim() + "\n",
    );
    wroteUserLayer = true;
  }

  // Per-project model override (published .harnesst/assistant/assistant.json) wins over the deploy
  // env default. Written to an env file the entrypoint sources; does NOT require a rebuild.
  if (typeof bundle.model === "string" && bundle.model.trim()) {
    let environment = shellAssignment(
      "HARNESST_ASSISTANT_MODEL",
      bundle.model.trim(),
    );
    if (
      typeof bundle.effort === "string" &&
      ["none", "minimal", "low", "medium", "high", "xhigh"].includes(
        bundle.effort,
      )
    ) {
      environment += shellAssignment("HARNESST_ASSISTANT_EFFORT", bundle.effort);
    }
    await writeFile(ENV_FILE, environment);
  }

  // An empty bundle after a non-empty one still needs ONE rebuild (to compile the layer's
  // removal out) — the entrypoint rebuilds on the marker's presence, and "0" won't read as a
  // user layer next boot.
  if (wroteUserLayer) await writeFile(USER_MARKER, "1");
  else if (hadUserLayer) await writeFile(USER_MARKER, "0");
  console.log(
    `[assistant] user layer ${wroteUserLayer ? "materialized (rebuild required)" : hadUserLayer ? "removed (rebuild required)" : "empty (fixed layer)"}.`,
  );
}

main().catch((error) => {
  console.error("[assistant] bootstrap error (starting anyway):", error);
});
