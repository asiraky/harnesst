/**
 * Catalog-level COMPOSITION — the include resolver (PRD §7.8, marketplace composition).
 *
 * A channel like Discord is defined ONCE as its own marketplace artifact; agent (and other)
 * templates bundle it by reference via the manifest's `includes`. This module sits ON TOP of the
 * unchanged CatalogSource seam: it depth-first resolves those references and FLATTENS them into a
 * single materialized template, so an installed repo contains ordinary files under the target's
 * root — never a live reference. The planner (install.server.ts) then treats the resolved template
 * exactly like a hand-written one.
 *
 * Update semantics fall out of this design unchanged: includes resolve from the SAME catalog
 * snapshot the parent came from (no per-include version pinning), and the parent template's own
 * version bump is the update gate — an install receives newer included files only when the parent
 * publishes a new version and the user updates it.
 *
 * The flatten rules are deliberately asymmetric and encoded once here (mirrored by the catalog CI
 * in validate.mjs so the same violations fail before publish):
 *  - files      union of every include + the parent; a path shipped by two artifacts is an ERROR
 *               (materialization can't write one path twice).
 *  - deps       merged includes-first then the parent on top; a name collision — the LATER (more
 *               parental) range wins silently.
 *  - secrets    union by name (includes-first then parent); first occurrence keeps its
 *               description; sandbox flags OR together.
 *  - auths      union by provider (issue #30): every include's + the parent's OAuth connection
 *               descriptors, deduped by provider with scopes unioned. Surfaced on the resolved
 *               template (NOT folded into the manifest) so the install wizard can render a Connect
 *               step for each — a bundle carries a connector's auth by including the connection.
 *  - sandbox    one merged setup: bootstrap concatenated includes-first then parent-last; env
 *               merged with the parent winning collisions; revalidationKey = the non-empty keys
 *               joined with "|" (includes-first, parent-last).
 *  - model/eve  the parent's only — an include never dictates the host agent's model or eve range.
 *
 * The resolved `hash` is the PARENT's OWN content hash (own manifest + own files) so it still
 * matches the parent's `index.json` row; each ResolvedInclude.hash is likewise that include's own
 * content hash. Both use the shared hash rule (hash.server.ts) — never a fork.
 */
import type {
  AuthScopeGroup,
  TemplateManifest,
  TemplateType,
} from "./manifest";
import { templateContentHash } from "./hash.server";
import type { CatalogSource, CatalogTemplate } from "~/seams/types";

/** One resolved include reference — provenance recorded in the lock alongside the flattened files. */
export interface ResolvedInclude {
  id: string;
  type: TemplateType;
  name: string;
  /** The include's own version (from its manifest) at resolution time. */
  version: string;
  /** The include's OWN content hash — matches its `index.json` row, not the flattened form. */
  hash: string;
}

/** One auth-brokered connection descriptor surfaced by composition (issue #30). */
export interface ResolvedAuth {
  /** The connection template that declared it (provenance / display). */
  templateId: string;
  provider: string;
  kind: "oauth2";
  /** Baseline scopes, always requested (empty when the template declares only groups — #165). */
  scopes: string[];
  /**
   * User-selectable permission levels (issue #165), merged by id across composed templates:
   * same provider + same group id = one level whose scopes union (first occurrence keeps the
   * label/description, `default` ORs).
   */
  scopeGroups?: AuthScopeGroup[];
  /**
   * Capability operation-group ids offered by the composed templates (issue #166), unioned per
   * provider in first-occurrence order. Ids only — the definitions live in harnesst's capability
   * registry, not in templates.
   */
  capabilityGroups?: string[];
}

/** A template with every include flattened into it — what the planner installs. */
export interface ResolvedTemplate {
  /** Parent manifest with flattened files/deps/secrets/sandbox; `includes` removed. */
  manifest: TemplateManifest;
  /** install-relative path → content: the union of every include's files plus the parent's. */
  files: Record<string, string>;
  /** The PARENT's own content hash — matches its index row (includes never change it). */
  hash: string;
  /**
   * The PARENT's own assistant skill (issue #274) — never merged from includes: a composite's
   * skill is the author's contract for the whole bundle, so it must cover what it bundles itself
   * (frontmatter can't survive concatenation, and one install gets one skill).
   */
  assistantSkill: string | null;
  /**
   * Flattened include references at every depth, each with its own name/version/hash (composition
   * provenance). Recording the whole resolved tree lets lock-only readers see through nested
   * bundles without re-walking a possibly newer catalog.
   */
  includes: ResolvedInclude[];
  /**
   * OAuth connection descriptors the install must broker (issue #30): the parent's own `auth`
   * plus every include's, deduped by provider (scopes unioned). Empty for templates with no
   * connector. Kept OFF the manifest — it's an install-wizard concern, not a materialized file.
   */
  auths: ResolvedAuth[];
}

/** Depth cap on include nesting — a defensive bound; real catalogs nest one or two deep. */
const MAX_DEPTH = 8;

type SandboxSetup = NonNullable<TemplateManifest["sandbox"]>;

/** A readable artifact label for collision errors, e.g. "channel/discord". */
function label(manifest: TemplateManifest): string {
  return `${manifest.type}/${manifest.id}`;
}

/**
 * Resolve a template and every template it includes into one flattened `ResolvedTemplate`.
 * Depth-first in manifest `includes` order; recursion allowed. Throws on a cycle (naming it), on
 * exceeding the depth cap, on including an `agent`, or on two artifacts shipping the same path.
 */
export async function resolveTemplate(
  source: CatalogSource,
  type: TemplateType,
  id: string,
): Promise<ResolvedTemplate> {
  return resolve(source, type, id, []);
}

async function resolve(
  source: CatalogSource,
  type: TemplateType,
  id: string,
  stack: string[],
): Promise<ResolvedTemplate> {
  const node = `${type}/${id}`;
  if (stack.includes(node)) {
    throw new Error(
      `Include cycle detected: ${[...stack, node].join(" → ")}.`,
    );
  }
  if (stack.length >= MAX_DEPTH) {
    throw new Error(
      `Include nesting exceeds the depth cap of ${MAX_DEPTH}: ${[...stack, node].join(" → ")}.`,
    );
  }

  const template = await source.template(type, id);
  const manifest = template.manifest;
  // The parent's OWN content hash (own manifest + own files) — matches its index row. Computed
  // BEFORE flattening: includes never affect a template's hash.
  const ownHash = templateContentHash(template);

  const nextStack = [...stack, node];
  const resolvedIncludes: ResolvedTemplate[] = [];
  const provenance: ResolvedInclude[] = [];

  for (const inc of manifest.includes ?? []) {
    // Cheap guard (schema already rejects an `agent` include, but defend the resolver too).
    if ((inc.type as TemplateType) === "agent") {
      throw new Error(
        `Template ${node} includes an agent (${inc.id}) — agents install as their own team member and can't be bundled by reference.`,
      );
    }
    const child = await resolve(source, inc.type, inc.id, nextStack);
    // The GitHub source parses remote bytes, so a mislabeled reference could resolve to an
    // agent-typed manifest — reject that too.
    if (child.manifest.type === "agent") {
      throw new Error(
        `Template ${node} includes ${label(child.manifest)}, which is an agent — agents can't be bundled by reference.`,
      );
    }
    resolvedIncludes.push(child);
    provenance.push({
      id: child.manifest.id,
      type: child.manifest.type,
      name: child.manifest.name,
      version: child.manifest.version,
      hash: child.hash,
    });
    provenance.push(...child.includes);
  }

  // ── files: union of every include (in order) then the parent; duplicates are an error ──
  const files: Record<string, string> = {};
  const fileList: string[] = [];
  const owner = new Map<string, string>();
  const addFiles = (src: ResolvedTemplate | CatalogTemplate) => {
    const from = label(src.manifest);
    for (const path of src.manifest.files) {
      if (owner.has(path)) {
        throw new Error(
          `Duplicate file path "${path}" — shipped by both ${owner.get(path)} and ${from}. Two composed artifacts can't materialize the same file.`,
        );
      }
      owner.set(path, from);
      files[path] = src.files[path];
      fileList.push(path);
    }
  };
  for (const child of resolvedIncludes) addFiles(child);
  addFiles(template);

  // ── dependencies: includes-first then parent on top (later, more-parental range wins) ──
  const deps: Record<string, string> = {};
  for (const child of resolvedIncludes) {
    Object.assign(deps, child.manifest.dependencies ?? {});
  }
  Object.assign(deps, manifest.dependencies ?? {});

  // ── secrets: union by name (includes-first then parent); first occurrence keeps its
  // description; sandbox/provisioned/generated flags OR together ──
  const secretByName = new Map<
    string,
    {
      name: string;
      description?: string;
      sandbox?: boolean;
      provisioned?: boolean;
      generated?: boolean;
    }
  >();
  const addSecrets = (list: TemplateManifest["secrets"]) => {
    for (const s of list ?? []) {
      const existing = secretByName.get(s.name);
      if (!existing) {
        secretByName.set(s.name, {
          name: s.name,
          ...(s.description !== undefined ? { description: s.description } : {}),
          ...(s.sandbox ? { sandbox: true } : {}),
          ...(s.provisioned ? { provisioned: true } : {}),
          ...(s.generated ? { generated: true } : {}),
        });
      } else {
        // First occurrence wins the description; sandbox/provisioned/generated OR across all.
        if (s.sandbox) existing.sandbox = true;
        if (s.provisioned) existing.provisioned = true;
        if (s.generated) existing.generated = true;
      }
    }
  };
  for (const child of resolvedIncludes) addSecrets(child.manifest.secrets);
  addSecrets(manifest.secrets);
  const secrets = [...secretByName.values()];

  // ── auths: union by provider, includes-first then parent; scopes unioned per provider;
  // scope groups (issue #165) merged by id — two composed connectors sharing a group id for the
  // SAME provider define one permission level, so their scopes UNION (dropping either side would
  // silently 403 the other connector at runtime); the first occurrence keeps its label/
  // description (the secrets rule) and `default` ORs across all. Groups are deep-copied on entry
  // so the merge never mutates the source template's manifest ──
  const authByProvider = new Map<string, ResolvedAuth>();
  const copyGroup = (g: AuthScopeGroup): AuthScopeGroup => ({
    ...g,
    scopes: [...g.scopes],
  });
  const addAuth = (auth: ResolvedAuth) => {
    const existing = authByProvider.get(auth.provider);
    if (!existing) {
      authByProvider.set(auth.provider, {
        ...auth,
        scopes: [...auth.scopes],
        ...(auth.scopeGroups
          ? { scopeGroups: auth.scopeGroups.map(copyGroup) }
          : {}),
        ...(auth.capabilityGroups
          ? { capabilityGroups: [...auth.capabilityGroups] }
          : {}),
      });
      return;
    }
    for (const scope of auth.scopes) {
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
    }
    for (const group of auth.scopeGroups ?? []) {
      const groups = (existing.scopeGroups ??= []);
      const dup = groups.find((g) => g.id === group.id);
      if (!dup) {
        groups.push(copyGroup(group));
        continue;
      }
      for (const scope of group.scopes) {
        if (!dup.scopes.includes(scope)) dup.scopes.push(scope);
      }
      if (group.default) dup.default = true;
    }
    // Capability groups (issue #166): ids union in first-occurrence order — two composed
    // connectors offering a group means one offering (the registry defines it once).
    for (const id of auth.capabilityGroups ?? []) {
      const groups = (existing.capabilityGroups ??= []);
      if (!groups.includes(id)) groups.push(id);
    }
  };
  for (const child of resolvedIncludes) {
    for (const a of child.auths) addAuth(a);
  }
  if (manifest.auth) {
    addAuth({
      templateId: manifest.id,
      provider: manifest.auth.provider,
      kind: manifest.auth.kind,
      scopes: manifest.auth.scopes ?? [],
      ...(manifest.auth.scopeGroups
        ? { scopeGroups: manifest.auth.scopeGroups }
        : {}),
      // The capability block rides the same provider's descriptor (issue #166; the schema
      // guarantees capability only appears alongside auth).
      ...(manifest.capability
        ? { capabilityGroups: manifest.capability.groups }
        : {}),
    });
  }
  const auths = [...authByProvider.values()];

  // ── sandbox: one merged setup, includes-first then parent-last (parent wins env collisions) ──
  const sandbox = mergeSandbox(
    resolvedIncludes.map((c) => c.manifest.sandbox),
    manifest.sandbox,
  );

  // The resolved manifest is the parent's, with flattened fields substituted and `includes`
  // stripped so the lock's dependency/secret snapshots are exactly the flattened truth.
  const resolvedManifest: TemplateManifest = { ...manifest };
  delete resolvedManifest.includes;
  resolvedManifest.files = fileList;
  setOrDelete(resolvedManifest, "dependencies", deps, Object.keys(deps).length > 0);
  setOrDelete(resolvedManifest, "secrets", secrets, secrets.length > 0);
  setOrDelete(resolvedManifest, "sandbox", sandbox, sandbox !== undefined);
  // `auth` (and its `capability` rider, issue #166) is an install-wizard concern surfaced via
  // `auths` below — never a materialized field.
  delete resolvedManifest.auth;
  delete resolvedManifest.capability;

  return {
    manifest: resolvedManifest,
    files,
    hash: ownHash,
    assistantSkill: template.assistantSkill,
    includes: provenance,
    auths,
  };
}

/** Assign `value` to `manifest[key]` when `keep`, else remove the key entirely (no empty fields). */
function setOrDelete<K extends keyof TemplateManifest>(
  manifest: TemplateManifest,
  key: K,
  value: TemplateManifest[K],
  keep: boolean,
): void {
  if (keep) manifest[key] = value;
  else delete manifest[key];
}

/**
 * Merge include sandbox setups (in order) with the parent's on top into one setup, or undefined
 * when nothing contributes: bootstrap concatenated includes-first then parent-last; env merged
 * with the parent winning; revalidationKey = the non-empty keys joined with "|".
 */
function mergeSandbox(
  includeSetups: Array<SandboxSetup | undefined>,
  parentSetup: SandboxSetup | undefined,
): SandboxSetup | undefined {
  const ordered = [...includeSetups, parentSetup].filter(
    (s): s is SandboxSetup => s !== undefined,
  );
  if (ordered.length === 0) return undefined;

  const bootstrap: string[] = [];
  const env: Record<string, string> = {};
  const keys: string[] = [];
  for (const setup of ordered) {
    for (const cmd of setup.bootstrap ?? []) bootstrap.push(cmd);
    Object.assign(env, setup.env ?? {}); // parent is last → wins collisions
    if (setup.revalidationKey) keys.push(setup.revalidationKey);
  }

  const merged: SandboxSetup = {};
  if (bootstrap.length > 0) merged.bootstrap = bootstrap;
  if (Object.keys(env).length > 0) merged.env = env;
  if (keys.length > 0) merged.revalidationKey = keys.join("|");
  // Every branch above was empty → the ordered setups were all `{}`; still nothing to emit.
  if (
    !merged.bootstrap &&
    !merged.env &&
    !merged.revalidationKey
  ) {
    return undefined;
  }
  return merged;
}
