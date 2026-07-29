#!/usr/bin/env tsx
/**
 * Lint over the files harnesst ships INTO an agent — the checks that guard a real build break but
 * have no function under test, so they belong here rather than in the vitest suite (issue #273).
 *
 * 1. Frontmatter of every shipped markdown file must be valid YAML. eve's discovery hard-fails the
 *    image build on unparseable authored-skill frontmatter, and a failed build surfaces to the user
 *    only as an endless "your assistant is starting up". Two breaks shipped this way inside one hour
 *    (#251 dropped an unknown key; #252 left a `": "` inside an unquoted description, which YAML
 *    reads as a nested mapping), so the shape is checked with a real parser.
 *
 *    `catalog/scripts/validate.mjs` cannot do this: it is deliberately dependency-free so the
 *    catalog can stand alone in the eve OSS repo, and its `frontmatterKeys()` is a column-0 regex
 *    that sees keys but never parses values. This is the parsing half of that contract, and it also
 *    covers `assistant-template/`, which the catalog validator does not look at.
 *
 * 2. Catalog ↔ capability-registry cross-check (issue #166). validate.mjs enforces the capability
 *    block's SHAPE with zero harnesst-app dependency; this is the other half it defers to, and it
 *    needs the app's registry modules — hence tsx rather than plain node.
 *
 * Exit 1 with readable errors on any failure.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { getCapability } from "~/capabilities/registry.server";
import { xeroCapability } from "~/capabilities/xero.server";
import { getProvider } from "~/connections/providers.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATES_ROOT = join(ROOT, "catalog/templates");

/** Keys eve accepts on an authored skill — mirrors SKILL_FRONTMATTER_KEYS in the catalog validator. */
const SKILL_FRONTMATTER_KEYS = ["name", "description"];

const errors: string[] = [];
const fail = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

function markdownFiles(base: string): string[] {
  const abs = join(ROOT, base);
  const out: string[] = [];
  const recurse = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) recurse(p);
      else if (entry.name.endsWith(".md")) {
        out.push(relative(ROOT, p).split(sep).join("/"));
      }
    }
  };
  try {
    if (statSync(abs).isDirectory()) recurse(abs);
  } catch {
    // Nothing to walk — the emptiness checks below catch a moved directory.
  }
  return out;
}

/** The leading `---` block's raw body, or null when the file has no frontmatter. */
function frontmatterBody(content: string): string | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return lines.slice(1, end).join("\n");
}

/** Skill markdown, by the path shapes eve discovers: `skills/<id>.md` or `skills/<id>/SKILL.md`. */
function isSkillPath(path: string): boolean {
  const parts = path.split("/");
  const i = parts.lastIndexOf("skills");
  if (i === -1) return false;
  const rest = parts.slice(i + 1);
  if (rest.length === 1) return true;
  if (rest.length === 2 && rest[1] === "SKILL.md") return true;
  return false; // references/, assets/, scripts/ — not a skill entry point
}

function lintFrontmatter() {
  const assistantSkills = markdownFiles("assistant-template/agent/skills");
  const shipped = [
    ...markdownFiles("assistant-template"),
    ...markdownFiles("catalog/templates"),
  ];

  // A rename that moves these directories must not turn this lint into a silent no-op.
  if (assistantSkills.length === 0) {
    fail(
      "assistant-template/agent/skills",
      "no markdown found — did the directory move?",
    );
  }
  if (shipped.length <= assistantSkills.length) {
    fail(
      "shipped markdown",
      "found no markdown outside the assistant skills — did a directory move?",
    );
  }

  for (const path of shipped) {
    const body = frontmatterBody(readFileSync(join(ROOT, path), "utf8"));
    if (body === null) continue; // no frontmatter block is legal; a malformed one is not
    try {
      parse(body);
    } catch (error) {
      fail(path, `frontmatter is not valid YAML — ${(error as Error).message}`);
    }
  }

  const skills = shipped.filter(isSkillPath);
  if (!skills.some((p) => p.startsWith("assistant-template/"))) {
    fail(
      "assistant-template",
      "no authored skills discovered — did the directory move?",
    );
  }
  if (!skills.some((p) => p.startsWith("catalog/"))) {
    fail(
      "catalog/templates",
      "no authored skills discovered — did the directory move?",
    );
  }

  for (const path of skills) {
    const body = frontmatterBody(readFileSync(join(ROOT, path), "utf8"));
    // A flat skill may omit frontmatter entirely — eve infers the description from the first line.
    if (body === null) continue;

    let parsed: unknown;
    try {
      parsed = parse(body);
    } catch {
      continue; // already reported above
    }
    if (typeof parsed !== "object" || parsed === null) {
      fail(path, "frontmatter must be a mapping");
      continue;
    }

    const fm = parsed as Record<string, unknown>;
    if (
      typeof fm.description !== "string" ||
      fm.description.trim().length === 0
    ) {
      fail(path, "frontmatter must declare a non-empty description");
    }
    const unknown = Object.keys(fm).filter(
      (k) => !SKILL_FRONTMATTER_KEYS.includes(k),
    );
    if (unknown.length > 0) {
      fail(
        path,
        `unknown frontmatter key(s) ${unknown.join(", ")} (only ${SKILL_FRONTMATTER_KEYS.join(
          ", ",
        )}) — eve's discovery fails the build on them`,
      );
    }
  }
}

interface DiskTemplate {
  dir: string;
  manifest: {
    id: string;
    type: string;
    files?: string[];
    auth?: { provider: string; scopes?: string[] };
    capability?: { groups: string[] };
  };
}

function loadTemplates(): DiskTemplate[] {
  const out: DiskTemplate[] = [];
  for (const typeDir of readdirSync(TEMPLATES_ROOT)) {
    const base = join(TEMPLATES_ROOT, typeDir);
    if (!statSync(base).isDirectory()) continue;
    for (const id of readdirSync(base)) {
      const dir = join(base, id);
      if (!statSync(dir).isDirectory()) continue;
      out.push({
        dir,
        manifest: JSON.parse(readFileSync(join(dir, "template.json"), "utf8")),
      });
    }
  }
  return out;
}

function lintCapabilityBlocks() {
  const templates = loadTemplates();
  const withCapability = templates.filter((t) => t.manifest.capability);

  if (!withCapability.some((t) => t.manifest.id === "xero")) {
    fail(
      "catalog/templates",
      "the xero template no longer ships a capability block",
    );
  }

  for (const t of withCapability) {
    const where = `catalog/templates/.../${t.manifest.id}`;
    const providerId = t.manifest.auth?.provider ?? "";
    const provider = getProvider(providerId);
    if (provider?.credentialDelivery !== "capability") {
      fail(
        where,
        `auth.provider "${providerId}" is not a registered credentialDelivery: "capability" provider`,
      );
    }
    const definition = getCapability(providerId);
    if (!definition) {
      fail(
        where,
        `provider "${providerId}" has no registered capability definition`,
      );
      continue;
    }
    const known = new Set(definition.operationGroups.map((g) => g.id));
    for (const id of t.manifest.capability!.groups) {
      if (!known.has(id)) {
        fail(where, `capability.groups references unknown group "${id}"`);
      }
    }
  }

  // Reads default-on server-side, writes opt-in — but the template must offer every registry group,
  // so a group added to the definition can never be unreachable from the marketplace.
  const xero = templates.find((t) => t.manifest.id === "xero");
  if (xero) {
    const offered = [...(xero.manifest.capability?.groups ?? [])].sort();
    const registered = xeroCapability.operationGroups.map((g) => g.id).sort();
    if (offered.join(",") !== registered.join(",")) {
      fail(
        "catalog/templates/connections/xero",
        `capability.groups [${offered.join(", ")}] does not match the registry's [${registered.join(
          ", ",
        )}]`,
      );
    }

    // One thin tool file per whitelisted operation: a new registry operation with no tool file is
    // an operation no agent can reach.
    for (const group of xeroCapability.operationGroups) {
      for (const op of group.operations) {
        const toolPath = `tools/xero-${op.id.replace(/_/g, "-")}.ts`;
        if (!xero.manifest.files?.includes(toolPath)) {
          fail(
            "catalog/templates/connections/xero",
            `operation "${op.id}" has no tool file — manifest does not list ${toolPath}`,
          );
          continue;
        }
        try {
          statSync(join(xero.dir, "files", toolPath));
        } catch {
          fail(
            "catalog/templates/connections/xero",
            `${toolPath} is listed but missing on disk`,
          );
        }
      }
    }
  }
}

lintFrontmatter();
lintCapabilityBlocks();

if (errors.length > 0) {
  console.error(`lint-shipped: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("lint-shipped: ok");
