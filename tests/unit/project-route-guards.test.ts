/**
 * Static guard: every route that takes a `:projectId` param must go through the per-repo
 * chokepoint (`requireProjectAccess` / `requireProject` / `requireFohProject`), so a repo the
 * viewer holds no grant on can never be reached by URL. Redirect-only shims carry no data and
 * are allowlisted by name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(process.cwd(), "app", "routes");
const GUARDS = /requireProjectAccess|requireProject\b|requireFohProject/;
/** Pure redirects: they read the param only to rebuild a URL. */
const REDIRECT_SHIMS = /^(legacy\.|shims\.)/;

describe("project routes", () => {
  it("every route reading params.projectId goes through a project guard", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(ROUTES_DIR)) {
      if (!/\.tsx?$/.test(file) || REDIRECT_SHIMS.test(file)) continue;
      const source = readFileSync(join(ROUTES_DIR, file), "utf8");
      if (!/params\.projectId|\{[^}]*\bprojectId\b[^}]*\}\s*=\s*(args\.)?params/.test(source))
        continue;
      if (!GUARDS.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("every `$projectId` route file imports a project guard", () => {
    const offenders = readdirSync(ROUTES_DIR).filter(
      (file) =>
        file.includes("$projectId") &&
        !GUARDS.test(readFileSync(join(ROUTES_DIR, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
