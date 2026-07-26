/**
 * GitHub-raw CatalogSource — the production pointer at the first-party catalog living inside
 * the eve OSS repo's `marketplace/` directory (PRD §7.8 Distribution).
 *
 * Env-driven, mirroring resolveDeployTarget()'s style (index.server.ts):
 *   HARNESST_CATALOG_REPO   "owner/repo"   — required to activate this impl
 *   HARNESST_CATALOG_PATH   default "marketplace"
 *   HARNESST_CATALOG_REF    default "main"
 *
 * The eve repo is public OSS, so we fetch over plain `https://raw.githubusercontent.com/...`
 * with no GitHub App auth. Every fetch is routed through the shared SWR cache (github/cache)
 * so repeat browses are a memory hit and one key never triggers two network calls at once —
 * the same idiom as github/cached.server.ts. Non-200s throw an error naming the failing URL.
 */
import { githubCache } from "~/github/cache.server";
import {
  parseIndex,
  parseManifest,
  type CatalogIndex,
  type TemplateType,
} from "~/marketplace/manifest";
import type { CatalogSource, CatalogTemplate } from "../types";

const INDEX_TTL_MS = 5 * 60_000;
const TEMPLATE_TTL_MS = 5 * 60_000;

interface CatalogPointer {
  repo: string;
  path: string;
  ref: string;
}

/** Read the env pointer, or throw if the catalog repo isn't configured (should never reach here). */
function pointer(): CatalogPointer {
  const repo = process.env.HARNESST_CATALOG_REPO;
  if (!repo) {
    throw new Error(
      "HARNESST_CATALOG_REPO is not set — the GitHub catalog source needs an owner/repo pointer.",
    );
  }
  return {
    repo,
    path: process.env.HARNESST_CATALOG_PATH ?? "marketplace",
    ref: process.env.HARNESST_CATALOG_REF ?? "main",
  };
}

/** raw.githubusercontent URL for a catalog-relative path (e.g. "index.json"). */
function rawUrl(ptr: CatalogPointer, rel: string): string {
  return `https://raw.githubusercontent.com/${ptr.repo}/${ptr.ref}/${ptr.path}/${rel}`;
}

/** Directory name for a template type — plural: "tool" → "tools". */
function typeDir(type: TemplateType): string {
  return `${type}s`;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Catalog fetch failed (${res.status} ${res.statusText}) for ${url}. ` +
        `Check HARNESST_CATALOG_REPO / HARNESST_CATALOG_REF and that the path exists.`,
    );
  }
  return res.text();
}

async function fetchJson(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url));
}

export const githubCatalog: CatalogSource = {
  name: "github",

  async index(): Promise<CatalogIndex> {
    const ptr = pointer();
    const key = `catalog:index:${ptr.repo}:${ptr.ref}`;
    return githubCache.get(key, INDEX_TTL_MS, async () =>
      parseIndex(await fetchJson(rawUrl(ptr, "index.json"))),
    );
  },

  async template(type: TemplateType, id: string): Promise<CatalogTemplate> {
    const ptr = pointer();
    const key = `catalog:tpl:${ptr.repo}:${ptr.ref}:${type}:${id}`;
    return githubCache.get(key, TEMPLATE_TTL_MS, async () => {
      const base = `templates/${typeDir(type)}/${id}`;
      const manifest = parseManifest(
        await fetchJson(rawUrl(ptr, `${base}/template.json`)),
      );
      // Fetch every declared file in parallel; assemble and cache the whole template.
      const entries = await Promise.all(
        manifest.files.map(
          async (rel) =>
            [rel, await fetchText(rawUrl(ptr, `${base}/files/${rel}`))] as const,
        ),
      );
      return { manifest, files: Object.fromEntries(entries) };
    });
  },
};
