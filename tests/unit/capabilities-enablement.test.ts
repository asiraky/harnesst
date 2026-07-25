/**
 * Capability-group enablement (issue #166) — the lock/install mechanics, exactly parallel to
 * scope-groups.test.ts's coverage of #165:
 *
 *  - the install snapshots `capabilityGroups` (offered) + `selectedCapabilityGroups` (chosen) —
 *    the posted choice when one exists, else the REGISTRY definition's default-flagged groups
 *    (write groups are never defaults) — and ALWAYS writes the field, so absence fail-closes;
 *  - the enablement the route checks per call is the union of the member's installs;
 *  - `setSelectedCapabilityGroups` (the Deployment-tab edit) rewrites only the matching
 *    provider's snapshots, drops unoffered ids, and reports no-ops — and because the route reads
 *    the lock per call, that edit needs no reconnect and no redeploy to take effect.
 */
import { describe, expect, it } from "vitest";

import {
  capabilityChoicesByProvider,
  enabledCapabilityGroupsByProvider,
  selectedCapabilityGroupIds,
  setSelectedCapabilityGroups,
} from "~/capabilities/enablement";
import { resolveTemplate } from "~/marketplace/compose.server";
import { planInstall, type PlanContext } from "~/marketplace/install.server";
import {
  emptyLock,
  findInstall,
  type HarnesstLock,
  type InstallEntry,
} from "~/marketplace/lock";
import { templateManifestSchema } from "~/marketplace/manifest";
import type { CatalogTemplate } from "~/seams/types";
import { fakeCatalog } from "../fakes/catalog";

const ALL_GROUPS = [
  "reference-read",
  "bills-read",
  "contacts-read",
  "contacts-write",
  "bills-draft",
];
/** The registry's default-flagged xero groups — the reads; both writes are opt-in. */
const DEFAULT_GROUPS = ["reference-read", "bills-read", "contacts-read"];

const XERO_SCOPES = [
  "offline_access",
  "accounting.invoices",
  "accounting.contacts",
  "accounting.settings.read",
  "accounting.attachments",
];

/** A xero-style capability connection template (provider real, so registry defaults apply). */
const xeroTpl: CatalogTemplate = {
  manifest: {
    id: "xero",
    type: "connection",
    name: "Xero",
    description: "Bookkeeping operations.",
    version: "0.1.0",
    eve: ">=0.20.0",
    files: ["tools/xero-create-draft-bill.ts"],
    auth: { provider: "xero", kind: "oauth2", scopes: XERO_SCOPES },
    capability: { groups: ALL_GROUPS },
  },
  files: { "tools/xero-create-draft-bill.ts": "export default {};\n" },
};

function memberCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    template: xeroTpl,
    registry: "fixture",
    repoPaths: [],
    drafts: [],
    packageJson: null,
    lock: emptyLock(),
    target: { kind: "member", memberName: "books", root: "agents/books/agent" },
    ...over,
  };
}

function xeroEntry(
  selectedCapabilityGroups: string[] | undefined,
  over: Partial<InstallEntry> = {},
): InstallEntry {
  return {
    id: "xero",
    type: "connection",
    name: "Xero",
    version: "0.1.0",
    hash: "h",
    registry: "fixture",
    member: "books",
    files: [],
    auth: [
      {
        provider: "xero",
        kind: "oauth2",
        scopes: XERO_SCOPES,
        capabilityGroups: ALL_GROUPS,
        ...(selectedCapabilityGroups !== undefined
          ? { selectedCapabilityGroups }
          : {}),
      },
    ],
    ...over,
  };
}

function lockOf(...installs: InstallEntry[]): HarnesstLock {
  return { version: 1, installs };
}

describe("install snapshot — capabilityGroups + selectedCapabilityGroups", () => {
  it("snapshots offered groups and defaults the selection to the registry's default-flagged reads", () => {
    const plan = planInstall(memberCtx());
    const lock = JSON.parse(
      plan.writes.find((s) => s.path === "harnesst-lock.json")!.content,
    ) as HarnesstLock;
    const entry = findInstall(lock, "xero", "books")!;
    expect(entry.auth?.[0]).toMatchObject({
      provider: "xero",
      capabilityGroups: ALL_GROUPS,
      // Write groups (contacts-write, bills-draft) are NEVER pre-selected by default.
      selectedCapabilityGroups: DEFAULT_GROUPS,
    });
  });

  it("honors the installer's posted choice, dropping ids the template doesn't offer", async () => {
    const plan = planInstall(
      memberCtx({
        capabilitySelections: {
          xero: ["bills-draft", "reference-read", "delete-everything"],
        },
      }),
    );
    const lock = JSON.parse(
      plan.writes.find((s) => s.path === "harnesst-lock.json")!.content,
    ) as HarnesstLock;
    const entry = findInstall(lock, "xero", "books")!;
    // Snapshot declaration order, not the posted order; the forged id is gone.
    expect(entry.auth?.[0].selectedCapabilityGroups).toEqual([
      "reference-read",
      "bills-draft",
    ]);
  });

  it("writes an EMPTY selection when the installer unticks everything (explicit least privilege)", () => {
    const plan = planInstall(memberCtx({ capabilitySelections: { xero: [] } }));
    const lock = JSON.parse(
      plan.writes.find((s) => s.path === "harnesst-lock.json")!.content,
    ) as HarnesstLock;
    expect(
      findInstall(lock, "xero", "books")!.auth?.[0].selectedCapabilityGroups,
    ).toEqual([]);
  });
});

describe("enablement derivation — what the capability route checks per call", () => {
  it("reads the stored selection, filtered to the offered ids", () => {
    const lock = lockOf(xeroEntry(["bills-draft", "bogus-group"]));
    expect(enabledCapabilityGroupsByProvider(lock, "books")).toEqual(
      new Map([["xero", ["bills-draft"]]]),
    );
  });

  it("fail-closes on a snapshot without a stored selection (predates the framework)", () => {
    const lock = lockOf(xeroEntry(undefined));
    expect(selectedCapabilityGroupIds(lock.installs[0].auth![0])).toEqual([]);
    expect(enabledCapabilityGroupsByProvider(lock, "books")).toEqual(
      new Map([["xero", []]]),
    );
  });

  it("unions the selections across the member's installs of one provider", () => {
    const lock = lockOf(
      xeroEntry(["reference-read"]),
      xeroEntry(["bills-draft"], { id: "xero-billing" }),
    );
    expect(enabledCapabilityGroupsByProvider(lock, "books")).toEqual(
      new Map([["xero", ["bills-draft", "reference-read"]]]),
    );
  });

  it("scopes to the member — another agent's installs never leak enablement", () => {
    const lock = lockOf(xeroEntry(["bills-draft"], { member: "other" }));
    expect(enabledCapabilityGroupsByProvider(lock, "books").size).toBe(0);
    expect(enabledCapabilityGroupsByProvider(lock, "other")).toEqual(
      new Map([["xero", ["bills-draft"]]]),
    );
  });
});

describe("setSelectedCapabilityGroups — the Deployment-tab edit", () => {
  it("rewrites the matching provider's snapshots and reports the change", () => {
    const lock = lockOf(xeroEntry(DEFAULT_GROUPS));
    const { lock: next, changed } = setSelectedCapabilityGroups(
      lock,
      "books",
      "xero",
      ["reference-read", "bills-draft"],
    );
    expect(changed).toBe(true);
    expect(next.installs[0].auth?.[0].selectedCapabilityGroups).toEqual([
      "reference-read",
      "bills-draft",
    ]);
    // The edit is immediately visible to the per-call derivation: no reconnect, no redeploy.
    expect(enabledCapabilityGroupsByProvider(next, "books")).toEqual(
      new Map([["xero", ["bills-draft", "reference-read"]]]),
    );
    // Pure: the input lock is untouched.
    expect(lock.installs[0].auth?.[0].selectedCapabilityGroups).toEqual(DEFAULT_GROUPS);
  });

  it("drops browser-supplied ids the snapshot doesn't offer", () => {
    const lock = lockOf(xeroEntry([]));
    const { lock: next } = setSelectedCapabilityGroups(lock, "books", "xero", [
      "bills-draft",
      "forged-group",
    ]);
    expect(next.installs[0].auth?.[0].selectedCapabilityGroups).toEqual([
      "bills-draft",
    ]);
  });

  it("reports no change when the selection is already stored", () => {
    const lock = lockOf(xeroEntry(["reference-read"]));
    const { changed } = setSelectedCapabilityGroups(lock, "books", "xero", [
      "reference-read",
    ]);
    expect(changed).toBe(false);
  });

  it("leaves other members and other providers untouched", () => {
    const other = xeroEntry(["bills-draft"], { member: "other" });
    const lock = lockOf(xeroEntry(["reference-read"]), other);
    const { lock: next } = setSelectedCapabilityGroups(lock, "books", "xero", []);
    expect(next.installs[0].auth?.[0].selectedCapabilityGroups).toEqual([]);
    expect(next.installs[1]).toBe(other);
  });
});

describe("capabilityChoicesByProvider — the editors' rows", () => {
  it("dedupes offered ids across installs, keeping a group selected when ANY install selects it", () => {
    const lock = lockOf(
      xeroEntry(["reference-read"]),
      xeroEntry(["bills-draft"], { id: "xero-billing" }),
    );
    expect(capabilityChoicesByProvider(lock, "books").get("xero")).toEqual(
      ALL_GROUPS.map((id) => ({
        id,
        selected: id === "reference-read" || id === "bills-draft",
      })),
    );
  });
});

describe("manifest schema — the capability block's rules", () => {
  const base = {
    id: "xero",
    type: "connection" as const,
    name: "Xero",
    description: "Bookkeeping operations.",
    version: "0.1.0",
    eve: ">=0.20.0",
    files: ["tools/xero-create-draft-bill.ts"],
    auth: { provider: "xero", kind: "oauth2" as const, scopes: XERO_SCOPES },
  };

  it("parses a capability block riding a connection's auth", () => {
    const parsed = templateManifestSchema.parse({
      ...base,
      capability: { groups: ["bills-draft"] },
    });
    expect(parsed.capability?.groups).toEqual(["bills-draft"]);
  });

  it("refuses capability on a non-connection template", () => {
    const result = templateManifestSchema.safeParse({
      ...base,
      type: "tool",
      auth: undefined,
      capability: { groups: ["bills-draft"] },
    });
    expect(result.success).toBe(false);
  });

  it("refuses capability without an auth block (nothing to execute with)", () => {
    const result = templateManifestSchema.safeParse({
      ...base,
      auth: undefined,
      capability: { groups: ["bills-draft"] },
    });
    expect(result.success).toBe(false);
  });

  it("refuses duplicate group ids (they're the lock's selection keys)", () => {
    const result = templateManifestSchema.safeParse({
      ...base,
      capability: { groups: ["bills-draft", "bills-draft"] },
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveTemplate — capability groups propagate through composition", () => {
  it("surfaces capabilityGroups on the resolved auth and drops the manifest rider", async () => {
    const source = fakeCatalog([xeroTpl]);
    const resolved = await resolveTemplate(source, "connection", "xero");
    expect(resolved.auths).toEqual([
      {
        templateId: "xero",
        provider: "xero",
        kind: "oauth2",
        scopes: XERO_SCOPES,
        capabilityGroups: ALL_GROUPS,
      },
    ]);
    // `capability` is an install-wizard concern like `auth` — never a materialized field.
    expect(resolved.manifest.capability).toBeUndefined();
    expect(resolved.manifest.auth).toBeUndefined();
  });

  it("a bundle unions capability group ids per provider in first-occurrence order", async () => {
    const billing: CatalogTemplate = {
      manifest: {
        id: "xero-billing",
        type: "connection",
        name: "Xero billing",
        description: "Bills only.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: ["tools/xero-search-bills.ts"],
        auth: { provider: "xero", kind: "oauth2", scopes: XERO_SCOPES },
        capability: { groups: ["bills-read", "bills-draft"] },
      },
      files: { "tools/xero-search-bills.ts": "export default {};\n" },
    };
    const bundle: CatalogTemplate = {
      manifest: {
        id: "books-pack",
        type: "bundle",
        name: "Books pack",
        description: "Full bookkeeping.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: [],
        includes: [
          { type: "connection", id: "xero-billing" },
          { type: "connection", id: "xero" },
        ],
      },
      files: {},
    };
    const source = fakeCatalog([xeroTpl, billing, bundle]);
    const resolved = await resolveTemplate(source, "bundle", "books-pack");
    expect(resolved.auths).toHaveLength(1);
    expect(resolved.auths[0].capabilityGroups).toEqual([
      "bills-read",
      "bills-draft",
      "reference-read",
      "contacts-read",
      "contacts-write",
    ]);
  });
});
