#!/usr/bin/env node
/**
 * Regenerate marketplace/index.json from the templates/ tree — the browse projection harnesst
 * lists from (PRD §7.8, "browse from index.json only").
 *
 * Deterministic by construction so the file only churns on real content changes: entries are
 * sorted by type then id, and each template's hash is the sha1 (hex) of its canonicalized
 * manifest plus its file contents in sorted path order. That hash rule is the drift guarantee —
 * validate.mjs and the harnesst unit tests recompute it and compare.
 *
 * Plain Node, zero imports from app/: this whole directory is destined to travel to the eve OSS
 * repo as `marketplace/`, so it must stand alone (see README.md).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = join(ROOT, "templates");

/** type → plural directory name (and back). The seed lays out templates/<type>s/<id>/. */
const TYPE_DIRS = {
  tool: "tools",
  skill: "skills",
  subagent: "subagents",
  channel: "channels",
  connection: "connections",
  bundle: "bundles",
  agent: "agents",
};

/** Deterministic JSON: object keys sorted recursively, so the same value hashes the same way. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The content hash: sha1(hex) over the canonical manifest and every file, files taken in
 * sorted path order as `path\0content`, joined by newlines. Keep this in lockstep with
 * validate.mjs and tests/unit/marketplace.test.ts.
 */
export function templateHash(manifest, files) {
  const parts = [stableStringify(manifest)];
  for (const path of Object.keys(files).sort()) {
    parts.push(`${path}\0${files[path]}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/** Walk templates/, returning { manifest, files } for every template on disk (unsorted). */
export function loadTemplates() {
  const out = [];
  for (const [type, dirName] of Object.entries(TYPE_DIRS)) {
    const typePath = join(TEMPLATES_DIR, dirName);
    let ids;
    try {
      ids = readdirSync(typePath, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // no templates of this type yet
    }
    for (const id of ids) {
      const dir = join(typePath, id);
      const manifest = JSON.parse(readFileSync(join(dir, "template.json"), "utf8"));
      const files = {};
      for (const rel of manifest.files ?? []) {
        files[rel] = readFileSync(join(dir, "files", rel), "utf8");
      }
      out.push({ type, id, dir, manifest, files });
    }
  }
  return out;
}

export function buildIndex(templates) {
  const rows = templates
    .map(({ manifest, files }) => ({
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      hash: templateHash(manifest, files),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  return { templates: rows };
}

function main() {
  const index = buildIndex(loadTemplates());
  writeFileSync(join(ROOT, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`Wrote index.json with ${index.templates.length} template(s).`);
}

// Run only as a script; the exports above let validate.mjs share the hash + walk.
if (import.meta.url === `file://${process.argv[1]}`) main();
