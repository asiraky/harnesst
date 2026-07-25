/**
 * Fixture CatalogSource — reads the first-party catalog seed committed in-repo at
 * `<root>/catalog/` (PRD §7.8; the seam's dev/test default, index.server.ts). The directory is
 * named `catalog/` HERE because Vite's dev server would otherwise serve `marketplace/index.json`
 * over the `/marketplace` route on a hard reload; its destination in the eve OSS repo is still
 * `marketplace/` — the copy step renames it.
 *
 * This is what runs when `EDEN_CATALOG_REPO` isn't set: no network, just node:fs against the
 * seed directory. It exists so harnesst's browse experience works out of the box and so the unit
 * tests can exercise the real parse path against the real seed (tests/unit/marketplace.test.ts).
 *
 * Every manifest/index read goes through parseManifest/parseIndex — the fixture trusts the
 * bytes on disk no more than the GitHub impl trusts the wire.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseIndex,
  parseManifest,
  type CatalogIndex,
  type TemplateType,
} from "~/marketplace/manifest";
import type { CatalogSource, CatalogTemplate } from "../types";

/** Seed root, resolved from the process CWD (the repo root when harnesst runs). */
function catalogRoot(): string {
  return join(process.cwd(), "catalog");
}

/**
 * Directory name for a template type — the plural of the type: "tool" → "tools". The seed
 * lays templates out at `catalog/templates/<type>s/<id>/`.
 */
function typeDir(type: TemplateType): string {
  return `${type}s`;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export const fixtureCatalog: CatalogSource = {
  name: "fixture",

  async index(): Promise<CatalogIndex> {
    return parseIndex(await readJson(join(catalogRoot(), "index.json")));
  },

  async template(type: TemplateType, id: string): Promise<CatalogTemplate> {
    const dir = join(catalogRoot(), "templates", typeDir(type), id);
    const manifest = parseManifest(await readJson(join(dir, "template.json")));

    // Load exactly the files the manifest declares (relative to the template's files/ subtree).
    const entries = await Promise.all(
      manifest.files.map(
        async (rel) => [rel, await readFile(join(dir, "files", rel), "utf8")] as const,
      ),
    );
    return { manifest, files: Object.fromEntries(entries) };
  },
};
