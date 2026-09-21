import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledTemplate } from "~/marketplace/compose.server";
import { githubCatalog } from "~/seams/oss/catalog.github.server";
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";
import { githubCache } from "~/github/cache.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  githubCache.invalidate("catalog:");
});
describe("installed templates outliving their catalog entries", () => {
  it("treats a removed local manifest as unavailable", async () => {
    expect(
      await resolveInstalledTemplate(
        fixtureCatalog,
        "agent",
        "missing-installed-agent",
      ),
    ).toBeNull();
  });
  it("treats a removed GitHub manifest as unavailable", async () => {
    vi.stubEnv("HARNESST_CATALOG_REPO", "fixture/catalog");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    expect(
      await resolveInstalledTemplate(
        githubCatalog,
        "agent",
        "missing-installed-agent",
      ),
    ).toBeNull();
  });
  it("does not hide a missing file declared by an existing template", async () => {
    vi.stubEnv("HARNESST_CATALOG_REPO", "fixture/catalog");
    const template = await fixtureCatalog.template("agent", "designer");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("template.json")
          ? Response.json(template.manifest)
          : new Response("missing", { status: 404 }),
      ),
    );
    await expect(
      resolveInstalledTemplate(githubCatalog, "agent", "designer"),
    ).rejects.toThrow("Catalog fetch failed");
  });
});
