/**
 * Selectable permission levels — scope groups (issue #165).
 *
 * The mechanism, all against literals: a connection template declares named scope groups; the
 * install snapshots the groups + the installer's selection into the lock; the effective required
 * scopes are baseline ∪ selected groups (requiredScopesByProvider); editing the selection from
 * the Deployment tab (setSelectedGroups) flips the existing coverage state — widening →
 * under-scoped (needs reconnect), narrowing → still connected. Group-less templates must behave
 * byte-for-byte as before groups existed (the google-sheets regression).
 */
import { describe, expect, it } from "vitest";

import { connectionRowState } from "~/connections/oauth.server";
import { resolveTemplate } from "~/marketplace/compose.server";
import { planInstall, type PlanContext } from "~/marketplace/install.server";
import {
  effectiveAuthScopes,
  emptyLock,
  findInstall,
  parseLock,
  requiredScopesByProvider,
  scopeGroupsByProvider,
  selectedGroupIds,
  serializeLock,
  setSelectedGroups,
  type HarnesstLock,
  type InstallEntry,
} from "~/marketplace/lock";
import type { CatalogTemplate } from "~/seams/types";
import { fakeCatalog } from "../fakes/catalog";

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const SHEETS = "https://www.googleapis.com/auth/spreadsheets";

const GROUPS = [
  {
    id: "read",
    label: "Read mail",
    description: "Search and read messages.",
    scopes: [READ],
    default: true,
  },
  {
    id: "labels",
    label: "Manage labels",
    description: "Apply/remove labels; includes read access.",
    scopes: [MODIFY],
  },
  {
    id: "send",
    label: "Send mail",
    description: "Send messages as the connected account.",
    scopes: [SEND],
  },
];

/** A gmail-style connection template: no baseline scopes, three selectable groups. */
const gmailTpl: CatalogTemplate = {
  manifest: {
    id: "gmail",
    type: "connection",
    name: "Gmail",
    description: "Mail access.",
    version: "0.1.0",
    eve: ">=0.20.0",
    files: ["connections/gmail.ts"],
    auth: { provider: "google", kind: "oauth2", scopeGroups: GROUPS },
  },
  files: { "connections/gmail.ts": "export default {};\n" },
};

/** A plain (group-less) connector — the pre-#165 shape that must not change. */
const sheetsTpl: CatalogTemplate = {
  manifest: {
    id: "google-sheets",
    type: "connection",
    name: "Google Sheets",
    description: "Sheets access.",
    version: "0.2.0",
    eve: ">=0.20.0",
    files: ["connections/google-sheets.ts"],
    auth: { provider: "google", kind: "oauth2", scopes: [SHEETS] },
  },
  files: { "connections/google-sheets.ts": "export default {};\n" },
};

function memberCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    template: gmailTpl,
    registry: "fixture",
    repoPaths: [],
    drafts: [],
    packageJson: null,
    lock: emptyLock(),
    target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
    ...over,
  };
}

function lockEntry(
  over: Partial<InstallEntry> & { auth?: InstallEntry["auth"] },
): InstallEntry {
  return {
    id: "gmail",
    type: "connection",
    name: "Gmail",
    version: "0.1.0",
    hash: "h",
    registry: "fixture",
    member: "pm",
    files: [],
    ...over,
  };
}

/** The gmail lock entry with a given selection (undefined = predates any explicit choice). */
function gmailEntry(selectedGroups?: string[]): InstallEntry {
  return lockEntry({
    auth: [
      {
        provider: "google",
        kind: "oauth2",
        scopeGroups: GROUPS,
        ...(selectedGroups !== undefined ? { selectedGroups } : {}),
      },
    ],
  });
}

function lockOf(...installs: InstallEntry[]): HarnesstLock {
  return { version: 1, installs };
}

describe("lock — effective scopes from scope groups (issue #165)", () => {
  it("selects exactly the chosen groups' scopes", () => {
    const lock = lockOf(gmailEntry(["read", "send"]));
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", [READ, SEND].sort()]]),
    );
  });

  it("falls back to the default-flagged groups when no selection is stored", () => {
    const lock = lockOf(gmailEntry(undefined));
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", [READ]]]),
    );
  });

  it("an explicit empty selection requires nothing beyond the baseline", () => {
    const lock = lockOf(gmailEntry([]));
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", []]]),
    );
  });

  it("includes the baseline scopes regardless of selection", () => {
    const lock = lockOf(
      lockEntry({
        auth: [
          {
            provider: "google",
            kind: "oauth2",
            scopes: [SHEETS],
            scopeGroups: GROUPS,
            selectedGroups: ["send"],
          },
        ],
      }),
    );
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", [SEND, SHEETS].sort()]]),
    );
  });

  it("drops selection ids the snapshot doesn't declare (stale/forged choices)", () => {
    const auth = gmailEntry(["read", "bogus"]).auth![0];
    expect(selectedGroupIds(auth)).toEqual(["read"]);
    expect(effectiveAuthScopes(auth)).toEqual([READ]);
  });

  it("unions across multiple installs of the same provider (grouped + plain)", () => {
    const lock = lockOf(
      gmailEntry(["read"]),
      lockEntry({
        id: "google-sheets",
        auth: [{ provider: "google", kind: "oauth2", scopes: [SHEETS] }],
      }),
    );
    expect(requiredScopesByProvider(lock, "pm")).toEqual(
      new Map([["google", [READ, SHEETS].sort()]]),
    );
  });
});

describe("lock — group-less regression (google-sheets unchanged)", () => {
  it("plans a byte-identical lock for a plain-scopes template, selections or not", () => {
    const plain = planInstall(memberCtx({ template: sheetsTpl }));
    const withSelections = planInstall(
      memberCtx({ template: sheetsTpl, authSelections: { google: ["read"] } }),
    );
    const lockOfPlan = (p: typeof plain) =>
      p.writes.find((w) => w.path === "harnesst-lock.json")!.content;
    expect(lockOfPlan(withSelections)).toBe(lockOfPlan(plain));
    const entry = findInstall(
      parseLock(JSON.parse(lockOfPlan(plain))),
      "google-sheets",
      "pm",
    )!;
    // Exactly the pre-#165 snapshot shape: no scopeGroups, no selectedGroups keys.
    expect(entry.auth).toEqual([
      { provider: "google", kind: "oauth2", scopes: [SHEETS] },
    ]);
  });

  it("setSelectedGroups is a no-op on group-less snapshots", () => {
    const lock = lockOf(
      lockEntry({
        id: "google-sheets",
        auth: [{ provider: "google", kind: "oauth2", scopes: [SHEETS] }],
      }),
    );
    const result = setSelectedGroups(lock, "pm", "google", ["read"]);
    expect(result.changed).toBe(false);
    expect(serializeLock(result.lock)).toBe(serializeLock(lock));
  });
});

describe("planInstall — scope-group selection lands in the lock (issue #165)", () => {
  const entryOf = (ctx: PlanContext) => {
    const plan = planInstall(ctx);
    const write = plan.writes.find((w) => w.path === "harnesst-lock.json")!;
    return findInstall(parseLock(JSON.parse(write.content)), "gmail", "pm")!;
  };

  it("defaults to the default-flagged groups when the wizard posts no selection", () => {
    const entry = entryOf(memberCtx());
    expect(entry.auth).toEqual([
      {
        provider: "google",
        kind: "oauth2",
        scopeGroups: GROUPS,
        selectedGroups: ["read"],
      },
    ]);
    // No baseline scopes on the template → no scopes key in the snapshot.
    expect(entry.auth![0].scopes).toBeUndefined();
  });

  it("writes the posted selection in template declaration order", () => {
    const entry = entryOf(
      memberCtx({ authSelections: { google: ["send", "read"] } }),
    );
    expect(entry.auth![0].selectedGroups).toEqual(["read", "send"]);
  });

  it("drops unknown posted ids (the form is browser-controlled)", () => {
    const entry = entryOf(
      memberCtx({ authSelections: { google: ["read", "everything"] } }),
    );
    expect(entry.auth![0].selectedGroups).toEqual(["read"]);
  });

  it("an explicit empty selection is stored (distinct from 'use defaults')", () => {
    const entry = entryOf(memberCtx({ authSelections: { google: [] } }));
    expect(entry.auth![0].selectedGroups).toEqual([]);
  });

  it("records a resolved template's scopeGroups (composition path)", () => {
    const entry = entryOf(
      memberCtx({
        template: {
          ...gmailTpl,
          auths: [
            {
              templateId: "gmail",
              provider: "google",
              kind: "oauth2",
              scopes: [],
              scopeGroups: GROUPS,
            },
          ],
        },
        authSelections: { google: ["read", "labels"] },
      }),
    );
    expect(entry.auth).toEqual([
      {
        provider: "google",
        kind: "oauth2",
        scopeGroups: GROUPS,
        selectedGroups: ["read", "labels"],
      },
    ]);
  });
});

describe("selection edit → coverage state transitions (issue #165)", () => {
  // The grant covers read-only (plus Google's identity scopes) — the state after connecting
  // with the default selection.
  const grantScopes = `${READ} openid email`;
  const stateFor = (lock: HarnesstLock) => {
    // Mirrors the deployments loader: undefined = no snapshot (fall back to covered), empty =
    // every group explicitly deselected (issue #173 — the row renders "disabled").
    const required = requiredScopesByProvider(lock, "pm").get("google");
    return connectionRowState({
      hasGrant: true,
      grantStatus: "active",
      requiredScopes:
        required && required.length > 0 ? required.join(" ") : null,
      grantScopes,
      permissionsDisabled: required !== undefined && required.length === 0,
    });
  };

  it("widening the selection flips the row to under-scoped (needs reconnect)", () => {
    const lock = lockOf(gmailEntry(["read"]));
    expect(stateFor(lock)).toBe("connected");
    const widened = setSelectedGroups(lock, "pm", "google", ["read", "send"]);
    expect(widened.changed).toBe(true);
    expect(stateFor(widened.lock)).toBe("under-scoped");
  });

  it("narrowing keeps the row connected (the broad grant still covers it)", () => {
    const lock = lockOf(gmailEntry(["read", "send"]));
    // Under-scoped while send is required but not granted…
    expect(stateFor(lock)).toBe("under-scoped");
    // …and connected again once the requirement shrinks to what was granted.
    const narrowed = setSelectedGroups(lock, "pm", "google", ["read"]);
    expect(narrowed.changed).toBe(true);
    expect(stateFor(narrowed.lock)).toBe("connected");
  });

  it("deselecting every group flips the row to disabled, not connected (issue #173)", () => {
    const lock = lockOf(gmailEntry(["read"]));
    expect(stateFor(lock)).toBe("connected");
    // The old grant still covers the (now empty) requirement, but rendering "connected" would
    // misstate what's live: deploys skip injection and reconnect refuses. The row says so.
    const emptied = setSelectedGroups(lock, "pm", "google", []);
    expect(emptied.changed).toBe(true);
    expect(stateFor(emptied.lock)).toBe("disabled");
  });

  it("disabled wins over not-connected too — the Connect button would only refuse (issue #173)", () => {
    expect(
      connectionRowState({
        hasGrant: false,
        grantStatus: null,
        requiredScopes: null,
        grantScopes: "",
        permissionsDisabled: true,
      }),
    ).toBe("disabled");
  });

  it("re-posting the stored selection changes nothing", () => {
    const lock = lockOf(gmailEntry(["read"]));
    const result = setSelectedGroups(lock, "pm", "google", ["read"]);
    expect(result.changed).toBe(false);
  });

  it("materializes the default selection when first edited to the same set", () => {
    // No stored choice (defaults apply) → an edit that matches the defaults still writes the
    // explicit list, so later template-default changes can't silently re-scope the install.
    const lock = lockOf(gmailEntry(undefined));
    const result = setSelectedGroups(lock, "pm", "google", ["read"]);
    expect(result.changed).toBe(true);
    expect(result.lock.installs[0].auth![0].selectedGroups).toEqual(["read"]);
  });

  it("leaves other members' installs untouched", () => {
    const other = { ...gmailEntry(["read"]), member: "eng" };
    const lock = lockOf(gmailEntry(["read"]), other);
    const result = setSelectedGroups(lock, "pm", "google", ["read", "send"]);
    expect(result.changed).toBe(true);
    expect(
      result.lock.installs.find((e) => e.member === "eng")!.auth![0]
        .selectedGroups,
    ).toEqual(["read"]);
  });
});

describe("scopeGroupsByProvider — the Permissions UI projection (issue #165)", () => {
  it("returns each group with its current selection state", () => {
    const lock = lockOf(gmailEntry(["read", "send"]));
    expect(scopeGroupsByProvider(lock, "pm")).toEqual(
      new Map([
        [
          "google",
          [
            {
              id: "read",
              label: "Read mail",
              description: "Search and read messages.",
              selected: true,
            },
            {
              id: "labels",
              label: "Manage labels",
              description: "Apply/remove labels; includes read access.",
              selected: false,
            },
            {
              id: "send",
              label: "Send mail",
              description: "Send messages as the connected account.",
              selected: true,
            },
          ],
        ],
      ]),
    );
  });

  it("uses defaults when no selection is stored, and omits group-less providers", () => {
    const lock = lockOf(
      gmailEntry(undefined),
      lockEntry({
        id: "google-sheets",
        auth: [{ provider: "hubspot", kind: "oauth2", scopes: ["crm.read"] }],
      }),
    );
    const groups = scopeGroupsByProvider(lock, "pm");
    expect(groups.has("hubspot")).toBe(false);
    expect(groups.get("google")!.map((g) => [g.id, g.selected])).toEqual([
      ["read", true],
      ["labels", false],
      ["send", false],
    ]);
  });
});

describe("resolveTemplate — scope groups propagate through composition (issue #165)", () => {
  it("surfaces a connection's scopeGroups (with an empty baseline) on the resolved auth", async () => {
    const source = fakeCatalog([gmailTpl]);
    const resolved = await resolveTemplate(source, "connection", "gmail");
    expect(resolved.auths).toEqual([
      {
        templateId: "gmail",
        provider: "google",
        kind: "oauth2",
        scopes: [],
        scopeGroups: GROUPS,
      },
    ]);
  });

  it("a bundle unions baseline scopes and carries the include's groups (same provider)", async () => {
    const bundle: CatalogTemplate = {
      manifest: {
        id: "google-pack",
        type: "bundle",
        name: "Google pack",
        description: "Mail + sheets.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: [],
        includes: [
          { type: "connection", id: "gmail" },
          { type: "connection", id: "google-sheets" },
        ],
      },
      files: {},
    };
    const source = fakeCatalog([gmailTpl, sheetsTpl, bundle]);
    const resolved = await resolveTemplate(source, "bundle", "google-pack");
    expect(resolved.auths).toHaveLength(1);
    expect(resolved.auths[0].scopes).toEqual([SHEETS]);
    expect(resolved.auths[0].scopeGroups).toEqual(GROUPS);
  });

  it("merges same-id groups across two composed connectors: scopes union, first label wins", async () => {
    const METADATA = "https://www.googleapis.com/auth/gmail.metadata";
    const otherMail: CatalogTemplate = {
      manifest: {
        id: "gmail-triage",
        type: "connection",
        name: "Gmail triage",
        description: "Triage-only mail.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: ["connections/gmail-triage.ts"],
        auth: {
          provider: "google",
          kind: "oauth2",
          scopeGroups: [
            {
              id: "read",
              label: "Read (triage)",
              description: "Read message metadata.",
              scopes: [METADATA],
            },
            { ...GROUPS[2], default: true }, // "send", default here but not on gmail's
            {
              id: "archive",
              label: "Archive",
              description: "Archive handled mail.",
              scopes: [MODIFY],
            },
          ],
        },
      },
      files: { "connections/gmail-triage.ts": "export default {};\n" },
    };
    const bundle: CatalogTemplate = {
      manifest: {
        id: "mail-pack",
        type: "bundle",
        name: "Mail pack",
        description: "Both mail connectors.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: [],
        includes: [
          { type: "connection", id: "gmail" },
          { type: "connection", id: "gmail-triage" },
        ],
      },
      files: {},
    };
    const source = fakeCatalog([gmailTpl, otherMail, bundle]);
    const resolved = await resolveTemplate(source, "bundle", "mail-pack");
    const groups = resolved.auths[0].scopeGroups!;
    expect(groups.map((g) => g.id)).toEqual([
      "read",
      "labels",
      "send",
      "archive",
    ]);
    const read = groups.find((g) => g.id === "read")!;
    // First occurrence (the gmail template's definition) keeps the label/description…
    expect(read.label).toBe("Read mail");
    // …but the second connector's scopes are NOT dropped: one level, scopes unioned —
    // discarding them would silently 403 the triage connector at runtime.
    expect(read.scopes).toEqual([READ, METADATA]);
    // `default` ORs across occurrences (either template pre-ticking the level pre-ticks it).
    expect(groups.find((g) => g.id === "send")!.default).toBe(true);
    // The merge never mutates the shared source template definitions.
    expect(GROUPS[0].scopes).toEqual([READ]);
    expect(GROUPS[2].default).toBeUndefined();
  });
});
