/**
 * The marketplace template format — the contract of PRD §7.8 ("Recruit — the marketplace").
 *
 * A template is *files + a manifest*. This module defines that manifest (`template.json`) and
 * the catalog index (`index.json`) as Zod schemas, and it is the SINGLE source of truth for the
 * format: the catalog CI (`marketplace/scripts/validate.mjs`) and harnesst's own catalog readers
 * (`app/seams/oss/catalog.*`) both validate against these rules. (The CI script re-implements
 * them in plain Node so `marketplace/` can travel to the eve OSS repo self-contained — that
 * duplication is deliberate and flagged there.)
 *
 * Client-safe: pure Zod + types, no server imports, so route components and loaders alike can
 * reference the inferred types.
 *
 * The one rule with teeth is `files`: these paths get materialized into customer repositories
 * during install (phase 2), so path traversal must be impossible at the schema layer — absolute
 * paths, `..` segments, and backslashes are rejected here, not downstream.
 */
import { z } from "zod";

import { PLATFORM_ROOT } from "~/eve/parse";

/**
 * The prefix that makes a `files` entry PLATFORM-owned (issue #254). Platform ownership is a path
 * convention, not a manifest field: a template declares it by shipping the file under `harnesst/`,
 * and the installer materializes it at the platform root — the directory sibling to the agent root
 * (app/eve/parse.ts), outside every path eve's discovery inspects. Platform files are rewritten on
 * every update and hash-verified at publish; nothing else may write them.
 */
export const PLATFORM_FILE_PREFIX = `${PLATFORM_ROOT}/`;

/** Whether a manifest `files` entry materializes at the platform root instead of the agent root. */
export function isPlatformFile(file: string): boolean {
  return (
    file.startsWith(PLATFORM_FILE_PREFIX) &&
    file.length > PLATFORM_FILE_PREFIX.length
  );
}

/**
 * The hierarchy levels a template can target (PRD §7.8 — "turtles all the way down"). `channel`
 * and `connection` join the original four as first-class marketplace artifacts (composition): a
 * channel like Discord is defined ONCE and included by reference into agent templates. Like
 * tool/skill/subagent they install INTO an existing member; only `agent` installs as a new one.
 * `bundle` (issue #42) is pure composition — a named group of includable assets that installs
 * into an existing member as one unit; the agent is conceptually "a bundle that also seeds a
 * new member".
 */
export const TEMPLATE_TYPES = [
  "tool",
  "skill",
  "subagent",
  "channel",
  "connection",
  "bundle",
  "agent",
] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/**
 * Types a template may `includes`-reference: everything except `agent`. An agent is a whole team
 * member — it installs as its own root, so it can't be flattened into a parent's file tree.
 */
export const INCLUDABLE_TYPES = TEMPLATE_TYPES.filter(
  (t) => t !== "agent",
) as Exclude<TemplateType, "agent">[];
export type IncludableType = (typeof INCLUDABLE_TYPES)[number];

/** kebab-case slug: lowercase, digits, single hyphens; matches the on-disk directory name. */
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a kebab-case slug");

/** Semver `x.y.z` — validated by regex; we deliberately don't pull in a semver package. */
const semver = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semver version (x.y.z)");

/**
 * A relative install path. Rejects the three traversal vectors — absolute paths, `..`
 * segments, and backslashes — because these strings become file writes in a customer repo.
 */
const relativeFilePath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/"),
    "must be a relative path (no leading slash)",
  )
  .refine((p) => !p.includes("\\"), "must use forward slashes")
  .refine(
    (p) => !p.split("/").includes(".."),
    "must not contain '..' path segments",
  );

/** UPPER_SNAKE_CASE — the env-var convention for a required secret name. */
const secretName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be UPPER_SNAKE_CASE");

/** An npm package name (loose validation — we only merge it into package.json, never resolve it). */
const npmName = z.string().min(1).max(214);

const sandboxSetupSchema = z.object({
  /**
   * Shell commands run once while eve builds the reusable sandbox template. Use this for
   * CLIs and browser/runtime dependencies the agent should have before a turn starts.
   */
  bootstrap: z.array(z.string().min(1)).optional(),
  /** Extra environment defaults forwarded to the sandbox backend. */
  env: z.record(z.string().min(1), z.string()).optional(),
  /** External version/input key that should force eve to rebuild the sandbox template. */
  revalidationKey: z.string().min(1).optional(),
});

export const templateManifestSchema = z
  .object({
  id: slug,
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  description: z.string().min(1),
  version: semver,
  /** A semver *range* the template targets (e.g. ">=0.1.0") — opaque here; we never parse ranges. */
  eve: z.string().min(1),
  /**
   * Install-relative paths the template ships. Non-empty for every type except `bundle`: a
   * bundle is pure composition, so it may ship nothing of its own (its `includes` carry the
   * files) — see the superRefine below.
   */
  files: z.array(relativeFilePath),
  /** npm name → version range, JSON-merged into the target's package.json at install (PRD §7.8). */
  dependencies: z.record(npmName, z.string().min(1)).optional(),
  /**
   * Secrets the template needs, by name — the wizard collects values at install. `sandbox: true`
   * marks one for the agent's sandbox shell (HARNESST_SANDBOX_ENV convention): the install flips the
   * exposure flag so terminal-driven agents get their credentials without a manual Settings trip.
   */
  secrets: z
    .array(
      z.object({
        name: secretName,
        description: z.string().optional(),
        sandbox: z.boolean().optional(),
        /**
         * Marks a secret that a guided harnesst flow sets (e.g. the GitHub App manifest flow on the
         * Deployment tab) rather than one collected at install — the wizard renders no input
         * for it.
         */
        provisioned: z.boolean().optional(),
        /**
         * A secret nobody types (issue #163) — harnesst mints a random value at first deploy and
         * keeps it stable across redeploys. Never prompted; mutually exclusive with provisioned.
         */
        generated: z.boolean().optional(),
      }),
    )
    .optional(),
  /**
   * Auth-brokered connection descriptor (issue #30) — ONLY valid on a `connection` template
   * (enforced in the superRefine below). It drives the install wizard's Connect step: harnesst runs
   * an operator-brokered OAuth flow for `provider`, requesting `scopes`, and stores the resulting
   * grant so deploy can inject it. `kind` is `"oauth2"` for now (the only brokered flow).
   *
   * Permission levels (issue #165): `scopes` is the always-requested baseline; `scopeGroups`
   * declares named, user-selectable levels (e.g. "Read mail" / "Send mail") the installer ticks
   * at install time — the effective request is baseline ∪ selected groups. At least one of the
   * two must be present (superRefine); a template with only `scopes` behaves exactly as before.
   *
   * `principalType` is deliberately omitted: Phase 1 grants are APP-scoped (one shared grant per
   * agent, captured at install). It joins here when user-scoped connections land.
   */
  auth: z
    .object({
      provider: slug,
      kind: z.literal("oauth2"),
      /** Baseline scopes, always requested. Optional when scopeGroups is present. */
      scopes: z.array(z.string().min(1)).min(1).optional(),
      /** Named, user-selectable permission levels. Order = display order. */
      scopeGroups: z
        .array(
          z.object({
            id: slug,
            /** Short human label, e.g. "Read mail". */
            label: z.string().min(1),
            /** What enabling this lets the agent do, in plain words. */
            description: z.string().min(1),
            scopes: z.array(z.string().min(1)).min(1),
            /** Pre-ticked in the install wizard. */
            default: z.boolean().optional(),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  /**
   * Brokered-capability enablement (issue #166) — ONLY valid alongside `auth` on a `connection`
   * template (superRefine below). Where `auth.scopeGroups` selects what the PROVIDER's token can
   * do, `capability.groups` names the operation groups (defined in harnesst's capability registry,
   * `app/capabilities/`) this template offers the installer; the selection is enforced PER CALL
   * by harnesst's capability route, so changing it later needs no reconnect. Group ids must exist in
   * the provider's capability definition (validated by catalog CI + harnesst's registry cross-check).
   */
  capability: z
    .object({
      /** Operation-group ids this template wants, in display order. */
      groups: z.array(slug).min(1),
    })
    .optional(),
  /** Sandbox setup installed alongside this template, merged by harnesst into the agent sandbox. */
  sandbox: sandboxSetupSchema.optional(),
  /** Suggested model, for agent-type templates. */
  model: z.string().optional(),
  /**
   * Provider-side setup a customer must do before this template works — rendered as Markdown on
   * the detail page, *before* install. This is where a template carries the install knowledge a
   * secret's description can't hold: creating an app on the provider, pointing a webhook at the
   * agent's endpoint, scopes to grant. Mainly used by channels; any template may set it.
   */
  setup: z.string().min(1).optional(),
  /**
   * Other catalog templates this one bundles by reference (composition). At install/update time
   * the resolver (compose.server.ts) flattens each include's files/deps/secrets/sandbox into this
   * template, so installed repos get materialized files — never live references. No version
   * pinning: includes resolve from the same catalog snapshot the parent came from, and the
   * parent's own version bump is what delivers newer included artifacts. `agent` is not includable
   * (a whole team member can't flatten into a parent); cycles and path collisions are CI failures.
   */
  includes: z
    .array(
      z.object({
        type: z.enum(
          INCLUDABLE_TYPES as [IncludableType, ...IncludableType[]],
        ),
        id: slug,
      }),
    )
    .optional(),
  })
  .superRefine((m, ctx) => {
    // Only a bundle may ship no files of its own (pure grouping); everything else must ship ≥1.
    if (m.type !== "bundle" && m.files.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: "array",
        inclusive: true,
        path: ["files"],
        message: "files must be non-empty (only a bundle may ship no files of its own)",
      });
    }
    // A file-less bundle with no includes would install nothing — reject it as authored noise.
    if (m.type === "bundle" && m.files.length === 0 && (m.includes?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["includes"],
        message: "a bundle with no files must include at least one template",
      });
    }
    // A secret is either operator/flow-set (provisioned) or harnesst-minted (generated) — never both.
    (m.secrets ?? []).forEach((s, i) => {
      if (s.provisioned && s.generated) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["secrets", i, "generated"],
          message: "a secret can't be both provisioned and generated",
        });
      }
    });
    // `auth` is a connection-template concern only — a brokered OAuth grant belongs to a
    // connector, not to a tool/skill/agent/etc. (bundles carry auth by INCLUDING a connection).
    if (m.auth && m.type !== "connection") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth"],
        message: "auth is only valid on a connection template",
      });
    }
    // An auth block must request SOMETHING: baseline scopes, selectable groups, or both (#165).
    if (m.auth && !m.auth.scopes && !m.auth.scopeGroups) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth"],
        message: "auth must declare scopes, scopeGroups, or both",
      });
    }
    // A capability block rides a connection's auth (issue #166): the operation whitelist consumes
    // the SAME brokered grant, so a capability without an auth block has nothing to execute with.
    if (m.capability && m.type !== "connection") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capability"],
        message: "capability is only valid on a connection template",
      });
    }
    if (m.capability && !m.auth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capability"],
        message: "capability requires an auth block (the grant its operations consume)",
      });
    }
    // Capability group ids are the lock's selection keys too — duplicates are ambiguous.
    if (m.capability) {
      const seen = new Set<string>();
      m.capability.groups.forEach((id, i) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["capability", "groups", i],
            message: `duplicate capability group id "${id}"`,
          });
        }
        seen.add(id);
      });
    }
    // Scope-group ids are the lock's selection keys — duplicates would make a choice ambiguous.
    if (m.auth?.scopeGroups) {
      const seen = new Set<string>();
      m.auth.scopeGroups.forEach((g, i) => {
        if (seen.has(g.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["auth", "scopeGroups", i, "id"],
            message: `duplicate scope group id "${g.id}"`,
          });
        }
        seen.add(g.id);
      });
    }
  });

export type TemplateManifest = z.infer<typeof templateManifestSchema>;

/** One named, user-selectable permission level on a connection template's auth block (#165). */
export type AuthScopeGroup = NonNullable<
  NonNullable<TemplateManifest["auth"]>["scopeGroups"]
>[number];

/** One row of the catalog index — the browse-list projection (PRD §7.8: "browse from index.json"). */
export const catalogEntrySchema = z.object({
  id: slug,
  type: z.enum(TEMPLATE_TYPES),
  name: z.string().min(1),
  version: semver,
  description: z.string().min(1),
  /** Hex content hash of the template (manifest + sorted file contents) — drift detection. */
  hash: z.string().regex(/^[0-9a-f]+$/, "must be a hex hash"),
});

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogIndexSchema = z.object({
  templates: z.array(catalogEntrySchema),
});

export type CatalogIndex = z.infer<typeof catalogIndexSchema>;

/**
 * Whether a string is a valid template id (kebab-case slug). Route loaders MUST gate URL
 * params through this before handing them to a CatalogSource — the fixture impl joins the id
 * into a filesystem path, so an unvalidated id is a path-traversal vector.
 */
export function isTemplateSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Parse+validate an unknown value as a TemplateManifest, throwing zod's error on failure. */
export function parseManifest(json: unknown): TemplateManifest {
  return templateManifestSchema.parse(json);
}

/** Parse+validate an unknown value as a CatalogIndex, throwing zod's error on failure. */
export function parseIndex(json: unknown): CatalogIndex {
  return catalogIndexSchema.parse(json);
}
