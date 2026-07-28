/**
 * The template content hash — the ONE drift-detection rule, shared by the install planner
 * (install.server.ts) and the composition resolver (compose.server.ts) so a template's provenance
 * matches the `index.json` row it came from.
 *
 * sha1(hex) over the canonical manifest plus every file in sorted path order (`path\0content`),
 * joined by newlines. This MUST stay in lockstep with the catalog's build-index.mjs /
 * validate.mjs (which re-implement it in plain Node for the eve OSS repo) and
 * tests/unit/marketplace.test.ts (which re-implements it independently as the guardrail). A
 * template's OWN hash never depends on what it `includes` — includes are flattened at install
 * time, not hashed into the parent — so this hashes exactly the bytes the catalog indexes.
 */
import { createHash } from "node:crypto";

import type { CatalogTemplate } from "~/seams/types";

/** Deterministic JSON (object keys sorted recursively) — the hash's canonical form. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content hash of a fully-loaded template — sha1(hex) over the canonical manifest plus every
 * file in sorted path order. Kept in lockstep with the catalog scripts and the unit tests.
 */
export function templateContentHash(template: CatalogTemplate): string {
  const parts = [stableStringify(template.manifest)];
  for (const path of Object.keys(template.files).sort()) {
    parts.push(`${path}\0${template.files[path]}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/**
 * Content hash of ONE materialized platform file (issue #254) — sha256(hex) over the exact bytes
 * the installer wrote to a `harnesst/…` path, recorded per path in the lock entry's
 * `platformFiles` and re-checked against disk by the publish gate.
 *
 * Deliberately a different question from `templateContentHash`, and deliberately a different
 * function so nobody conflates them: that one hashes a whole TEMPLATE and answers "which catalog
 * version did we install?", which cannot tell an untouched file from a customised one — the exact
 * blindness that let an update overwrite two live agents' channel code. This one answers "are the
 * bytes still the bytes we wrote?".
 */
export function platformFileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
