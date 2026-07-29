#!/usr/bin/env node
/**
 * Catalog CI gate — validate every template in marketplace/ against the format, and prove
 * index.json is in sync (PRD §7.8: "validated + indexed by catalog CI, no build step").
 *
 * The format rules below deliberately DUPLICATE app/marketplace/manifest.ts (the Zod schema).
 * That's intentional: this directory is destined to live in the eve OSS repo as `marketplace/`
 * and must validate itself with zero dependency on harnesst's app code (README.md). manifest.ts and
 * this script are two encodings of one contract — change one, change the other; the harnesst unit
 * tests (tests/unit/marketplace.test.ts) cover the schema side.
 *
 * Beyond the per-manifest rules it checks the structural invariants a schema can't see:
 *   - each template's declared `files` list matches its files/ subtree exactly (both directions)
 *   - every id is unique and equals its directory name
 *   - index.json exists, lists every template exactly once, and every hash matches recomputation
 *   - composition (`includes`): every reference exists, there are no cycles, and the RESOLVED
 *     (flattened) file set of every template has no duplicate final paths — mirroring the harnesst
 *     resolver's union rule (app/marketplace/compose.server.ts), so a violation fails BEFORE
 *     publish rather than at install time.
 *
 * Exit 1 with readable errors on any failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex, loadTemplates } from "./build-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = ["tool", "skill", "subagent", "channel", "connection", "bundle", "agent"];
/** Types a template may `includes`-reference — everything except `agent`. */
const INCLUDABLE = TYPES.filter((t) => t !== "agent");
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

/** Mirror of manifest.ts's relative-path rule — no absolute paths, no `..`, no backslashes. */
function badPath(p) {
  if (typeof p !== "string" || p.length === 0)
    return "must be a non-empty string";
  if (p.startsWith("/")) return "must be relative (no leading slash)";
  if (p.includes("\\")) return "must use forward slashes";
  if (p.split("/").includes("..")) return "must not contain '..' segments";
  return null;
}

/** Mirror of manifest.ts's manifest rules. Pushes readable errors under `where`. */
function validateManifest(where, m) {
  if (!KEBAB.test(m.id ?? ""))
    fail(where, `id "${m.id}" is not a kebab-case slug`);
  if (!TYPES.includes(m.type))
    fail(where, `type "${m.type}" is not one of ${TYPES.join(", ")}`);
  if (!m.name) fail(where, "name is required");
  if (!m.description) fail(where, "description is required");
  if (!SEMVER.test(m.version ?? ""))
    fail(where, `version "${m.version}" is not semver x.y.z`);
  if (!m.eve) fail(where, "eve range is required");

  // Only a bundle may ship no files of its own (pure composition — its includes carry them).
  if (!Array.isArray(m.files) || (m.files.length === 0 && m.type !== "bundle")) {
    fail(where, "files must be a non-empty array (only a bundle may be empty)");
  } else {
    for (const p of m.files) {
      const reason = badPath(p);
      if (reason) fail(where, `file path "${p}" ${reason}`);
    }
  }
  // A file-less bundle with no includes would install nothing.
  if (
    m.type === "bundle" &&
    Array.isArray(m.files) &&
    m.files.length === 0 &&
    (m.includes?.length ?? 0) === 0
  ) {
    fail(where, "a bundle with no files must include at least one template");
  }

  if (m.dependencies !== undefined) {
    for (const [name, range] of Object.entries(m.dependencies)) {
      if (!name) fail(where, "dependency name must be non-empty");
      if (typeof range !== "string" || range.length === 0) {
        fail(where, `dependency "${name}" range must be a non-empty string`);
      }
    }
  }

  if (m.secrets !== undefined) {
    if (!Array.isArray(m.secrets)) fail(where, "secrets must be an array");
    else
      for (const s of m.secrets) {
        if (!UPPER_SNAKE.test(s?.name ?? "")) {
          fail(where, `secret name "${s?.name}" is not UPPER_SNAKE_CASE`);
        }
        // A secret is either flow-set (provisioned) or harnesst-minted (generated) — never both.
        if (s?.provisioned && s?.generated) {
          fail(where, `secret "${s.name}" can't be both provisioned and generated`);
        }
      }
  }

  // auth (issue #30): a brokered OAuth connector descriptor — connection templates only.
  // `scopes` is the always-requested baseline; `scopeGroups` (issue #165) declares named,
  // user-selectable permission levels. At least one of the two must be present.
  if (m.auth !== undefined) {
    if (!m.auth || typeof m.auth !== "object" || Array.isArray(m.auth)) {
      fail(where, "auth must be an object { provider, kind, scopes?, scopeGroups? }");
    } else {
      if (m.type !== "connection") {
        fail(where, "auth is only valid on a connection template");
      }
      if (!KEBAB.test(m.auth.provider ?? "")) {
        fail(where, `auth.provider "${m.auth.provider}" is not a kebab-case slug`);
      }
      if (m.auth.kind !== "oauth2") {
        fail(where, `auth.kind "${m.auth.kind}" must be "oauth2"`);
      }
      const badScopeList = (list) =>
        !Array.isArray(list) ||
        list.length === 0 ||
        list.some((s) => typeof s !== "string" || s.length === 0);
      if (m.auth.scopes !== undefined && badScopeList(m.auth.scopes)) {
        fail(where, "auth.scopes must be a non-empty array of non-empty strings");
      }
      if (m.auth.scopeGroups !== undefined) {
        if (!Array.isArray(m.auth.scopeGroups) || m.auth.scopeGroups.length === 0) {
          fail(where, "auth.scopeGroups must be a non-empty array");
        } else {
          const seen = new Set();
          for (const g of m.auth.scopeGroups) {
            if (!g || typeof g !== "object" || Array.isArray(g)) {
              fail(where, "each scope group must be an object { id, label, description, scopes }");
              continue;
            }
            if (!KEBAB.test(g.id ?? "")) {
              fail(where, `scope group id "${g.id}" is not a kebab-case slug`);
            }
            if (seen.has(g.id)) {
              fail(where, `duplicate scope group id "${g.id}"`);
            }
            seen.add(g.id);
            if (!g.label) fail(where, `scope group "${g.id}" needs a label`);
            if (!g.description) {
              fail(where, `scope group "${g.id}" needs a description`);
            }
            if (badScopeList(g.scopes)) {
              fail(
                where,
                `scope group "${g.id}" scopes must be a non-empty array of non-empty strings`,
              );
            }
            if (g.default !== undefined && typeof g.default !== "boolean") {
              fail(where, `scope group "${g.id}" default must be a boolean`);
            }
          }
        }
      }
      if (m.auth.scopes === undefined && m.auth.scopeGroups === undefined) {
        fail(where, "auth must declare scopes, scopeGroups, or both");
      }
    }
  }
  // capability (issue #166): operation-group enablement riding a connection's auth block. Group
  // ids must exist in harnesst's capability registry — that cross-check lives in harnesst's lint
  // (scripts/lint-shipped.ts), because this script deliberately has no dependency on harnesst app
  // code; the SHAPE is enforced here.
  if (m.capability !== undefined) {
    if (
      !m.capability ||
      typeof m.capability !== "object" ||
      Array.isArray(m.capability)
    ) {
      fail(where, "capability must be an object { groups }");
    } else {
      if (m.type !== "connection") {
        fail(where, "capability is only valid on a connection template");
      }
      if (m.auth === undefined) {
        fail(where, "capability requires an auth block (the grant its operations consume)");
      }
      if (!Array.isArray(m.capability.groups) || m.capability.groups.length === 0) {
        fail(where, "capability.groups must be a non-empty array");
      } else {
        const seen = new Set();
        for (const id of m.capability.groups) {
          if (!KEBAB.test(id ?? "")) {
            fail(where, `capability group id "${id}" is not a kebab-case slug`);
          }
          if (seen.has(id)) fail(where, `duplicate capability group id "${id}"`);
          seen.add(id);
        }
      }
    }
  }
  if (m.sandbox !== undefined) {
    if (
      !m.sandbox ||
      typeof m.sandbox !== "object" ||
      Array.isArray(m.sandbox)
    ) {
      fail(where, "sandbox must be an object");
    } else {
      if (
        m.sandbox.bootstrap !== undefined &&
        (!Array.isArray(m.sandbox.bootstrap) ||
          m.sandbox.bootstrap.some(
            (cmd) => typeof cmd !== "string" || cmd.length === 0,
          ))
      ) {
        fail(where, "sandbox.bootstrap must be an array of non-empty strings");
      }
      if (
        m.sandbox.env !== undefined &&
        (!m.sandbox.env ||
          typeof m.sandbox.env !== "object" ||
          Array.isArray(m.sandbox.env) ||
          Object.entries(m.sandbox.env).some(
            ([name, value]) => !name || typeof value !== "string",
          ))
      ) {
        fail(where, "sandbox.env must be an object of string values");
      }
      if (
        m.sandbox.revalidationKey !== undefined &&
        (typeof m.sandbox.revalidationKey !== "string" ||
          m.sandbox.revalidationKey.length === 0)
      ) {
        fail(where, "sandbox.revalidationKey must be a non-empty string");
      }
    }
  }
  if (m.model !== undefined && typeof m.model !== "string") {
    fail(where, "model must be a string");
  }
  if (
    m.setup !== undefined &&
    (typeof m.setup !== "string" || m.setup.length === 0)
  ) {
    fail(where, "setup must be a non-empty string");
  }

  if (m.includes !== undefined) {
    if (!Array.isArray(m.includes)) {
      fail(where, "includes must be an array of { type, id }");
    } else {
      for (const inc of m.includes) {
        if (!inc || typeof inc !== "object" || Array.isArray(inc)) {
          fail(where, "each include must be an object { type, id }");
          continue;
        }
        if (!INCLUDABLE.includes(inc.type)) {
          fail(
            where,
            `include type "${inc.type}" is not one of ${INCLUDABLE.join(", ")}`,
          );
        }
        if (!KEBAB.test(inc.id ?? "")) {
          fail(where, `include id "${inc.id}" is not a kebab-case slug`);
        }
      }
    }
  }
}

/**
 * Authored skill markdown (issue: legal-advisor shipped `disable-model-invocation`, a Claude Code
 * key eve doesn't know). eve's discovery rejects any unknown frontmatter key with a hard error, so
 * a template carrying one installs cleanly and then breaks the customer's NEXT build — the failure
 * surfaces at publish, far from the catalog. Keep authored skills to the public eve shape.
 *
 * Which files are skills mirrors eve's scan of `agent/skills/`: a packaged skill is
 * `skills/<id>/SKILL.md` (frontmatter with `description` required); a flat skill is `skills/<id>.md`
 * (frontmatter optional). Anything deeper — `references/`, `assets/`, `scripts/` — is a sibling
 * file, not a skill, and is left alone.
 */
const SKILL_FRONTMATTER_KEYS = ["name", "description"];

function skillKind(path) {
  const parts = path.split("/");
  if (parts[0] !== "skills" || !path.endsWith(".md")) return null;
  if (parts.length === 2) return "flat"; // skills/<id>.md
  if (parts.length === 3 && parts[2] === "SKILL.md") return "packaged"; // skills/<id>/SKILL.md
  return null; // references/, assets/, scripts/, …
}

/**
 * Top-level keys of a leading `---` frontmatter block, or null when there is none. Deliberately
 * shallow (no YAML dependency — this directory stands alone): nested mapping lines are indented,
 * so only column-0 `key:` lines count.
 */
function frontmatterKeys(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return lines
    .slice(1, end)
    .map((line) => /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1])
    .filter(Boolean);
}

/** Enforce the eve authored-skill shape on one shipped file. */
function validateSkillMarkdown(where, path, content) {
  const kind = skillKind(path);
  if (!kind) return;
  const keys = frontmatterKeys(content);
  if (keys === null) {
    if (kind === "packaged") {
      fail(where, `"${path}" needs frontmatter with a description (packaged skills require it)`);
    }
    return; // a flat skill may omit frontmatter — eve infers the description from the first line.
  }
  for (const key of keys) {
    if (!SKILL_FRONTMATTER_KEYS.includes(key)) {
      fail(
        where,
        `"${path}" frontmatter key "${key}" is not part of the public eve skill shape ` +
          `(only ${SKILL_FRONTMATTER_KEYS.join(", ")}) — eve's discovery fails the build on it`,
      );
    }
  }
  if (!keys.includes("description")) {
    fail(where, `"${path}" frontmatter must declare a description`);
  }
}

/** Every file path (relative to `base`) under `base`, using forward slashes. */
function walkFiles(base) {
  const out = [];
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) recurse(abs);
      else out.push(relative(base, abs).split(sep).join("/"));
    }
  };
  try {
    if (statSync(base).isDirectory()) recurse(base);
  } catch {
    // no files/ dir — the empty set will mismatch a non-empty manifest below.
  }
  return out;
}

function main() {
  const templates = loadTemplates();
  const seenIds = new Map(); // id -> where (uniqueness across the whole catalog)

  for (const t of templates) {
    const where = `templates/${t.type}s/${t.id}`;
    validateManifest(where, t.manifest);

    // id must equal the directory name.
    if (t.manifest.id !== t.id) {
      fail(
        where,
        `manifest id "${t.manifest.id}" does not match directory name "${t.id}"`,
      );
    }
    // ids unique across the catalog.
    if (seenIds.has(t.manifest.id)) {
      fail(
        where,
        `duplicate id "${t.manifest.id}" (also in ${seenIds.get(t.manifest.id)})`,
      );
    } else {
      seenIds.set(t.manifest.id, where);
    }

    // files list must match files/ exactly, both directions.
    const declared = new Set(t.manifest.files ?? []);
    const onDisk = new Set(walkFiles(join(t.dir, "files")));
    for (const p of declared) {
      if (!onDisk.has(p))
        fail(where, `declares "${p}" but it is missing under files/`);
    }
    for (const p of onDisk) {
      if (!declared.has(p))
        fail(where, `ships "${p}" under files/ but it is not in the manifest`);
    }

    // Shipped skill markdown must match the shape eve's discovery accepts.
    for (const [p, content] of Object.entries(t.files)) {
      validateSkillMarkdown(where, p, content);
    }
  }

  // ── Scope-group identity: same provider + same group id ⇒ same scopes (issues #165, #173) ──
  // Group ids are provider-level identities (README.md): composing two connectors for the same
  // provider merges same-id groups into ONE permission level whose scopes UNION. Divergent scope
  // sets under one id would make that checkbox silently authorize both sets (ticking "Read mail"
  // also granting calendar read), so authors must either genuinely share a level (identical
  // scopes) or namespace their ids (gmail-read / calendar-read). Checked catalog-wide: any two
  // templates are composable by a future bundle.
  const groupIdentity = new Map(); // `${provider} ${groupId}` -> { where, scopes: string[] }
  for (const t of templates) {
    const auth = t.manifest.auth;
    if (!auth?.provider || !Array.isArray(auth.scopeGroups)) continue;
    const where = `templates/${t.type}s/${t.id}`;
    for (const g of auth.scopeGroups) {
      if (!g || !Array.isArray(g.scopes)) continue; // shape errors already reported above
      const key = `${auth.provider} ${g.id}`;
      const scopes = [...new Set(g.scopes)].sort();
      const first = groupIdentity.get(key);
      if (!first) {
        groupIdentity.set(key, { where, scopes });
        continue;
      }
      const same =
        first.scopes.length === scopes.length &&
        first.scopes.every((s, i) => s === scopes[i]);
      if (!same) {
        fail(
          where,
          `scope group "${g.id}" for provider "${auth.provider}" is also declared by ` +
            `${first.where} with different scopes — group ids are provider-level identities ` +
            `(composing them unions the scopes into one checkbox), so use identical scopes or ` +
            `namespace the ids (e.g. "gmail-read" / "calendar-read")`,
        );
      }
    }
  }

  // ── Composition: references exist, no cycles, and no duplicate RESOLVED file paths ──
  // Mirrors app/marketplace/compose.server.ts's union rule: a template's flattened file set is
  // every include's files (transitively, includes-first) plus its own; a path shipped twice — by
  // two artifacts or the same artifact reached via two include paths — is an error.
  const byKey = new Map(); // `${type}/${id}` -> template
  for (const t of templates) {
    byKey.set(`${t.manifest.type}/${t.manifest.id}`, t);
  }

  /** Resolve a template's flattened file owners, reporting cycles / missing refs / duplicates. */
  function checkResolvedFiles(startKey) {
    const owner = new Map(); // path -> owning `${type}/${id}`
    const visit = (key, stack) => {
      const where = `templates/${key.split("/")[0]}s/${key.split("/")[1]}`;
      if (stack.includes(key)) {
        fail(where, `include cycle: ${[...stack, key].join(" → ")}`);
        return false;
      }
      const t = byKey.get(key);
      if (!t) {
        // Reported against whoever referenced it (the previous stack frame), or itself if root.
        const from = stack.length > 0 ? stack[stack.length - 1] : key;
        fail(
          `templates/${from.split("/")[0]}s/${from.split("/")[1]}`,
          `includes "${key}", which is not a template in the catalog`,
        );
        return false;
      }
      const nextStack = [...stack, key];
      // Includes first (depth-first, in order), then this template's own files.
      for (const inc of t.manifest.includes ?? []) {
        if (!visit(`${inc.type}/${inc.id}`, nextStack)) return false;
      }
      for (const p of t.manifest.files ?? []) {
        if (owner.has(p)) {
          fail(
            where,
            `resolved file path "${p}" is shipped by both ${owner.get(p)} and ${key} — composed artifacts can't materialize the same file`,
          );
          return false;
        }
        owner.set(p, key);
      }
      return true;
    };
    visit(startKey, []);
  }

  for (const t of templates) {
    checkResolvedFiles(`${t.manifest.type}/${t.manifest.id}`);
  }

  // index.json must exist and match a fresh rebuild exactly (presence, one row each, hashes).
  let onDisk;
  try {
    onDisk = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8"));
  } catch {
    fail("index.json", "missing or unparseable — run `npm run catalog:index`");
  }
  if (onDisk) {
    const expected = buildIndex(templates);
    const expectedById = new Map(
      expected.templates.map((r) => [`${r.type}/${r.id}`, r]),
    );
    const listed = new Set();
    for (const row of onDisk.templates ?? []) {
      const key = `${row.type}/${row.id}`;
      if (listed.has(key)) fail("index.json", `lists ${key} more than once`);
      listed.add(key);
      const want = expectedById.get(key);
      if (!want)
        fail("index.json", `lists ${key}, which is not a template on disk`);
      else if (want.hash !== row.hash) {
        fail(
          "index.json",
          `hash for ${key} is stale — run \`npm run catalog:index\``,
        );
      }
    }
    for (const key of expectedById.keys()) {
      if (!listed.has(key))
        fail("index.json", `missing ${key} — run \`npm run catalog:index\``);
    }
  }

  if (errors.length > 0) {
    console.error(`Catalog validation failed (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `Catalog OK — ${templates.length} template(s) valid and in sync.`,
  );
}

main();
