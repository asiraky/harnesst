/**
 * Catalog ↔ capability-registry cross-check (issue #166). catalog/scripts/validate.mjs enforces
 * the capability block's SHAPE with zero harnesst-app dependency; this test is the other half it
 * defers to: every `capability.groups` id a shipped template references must exist in the
 * provider's capability definition, and the provider itself must be a registered
 * `credentialDelivery: "capability"` entry. It also pins the Xero template's contract: one thin
 * tool file per whitelisted operation, each POSTing to its own capability endpoint with the
 * deployment's EDEN_TEAM_TOKEN — and no `XERO_*` env expectations anywhere (the instance never
 * holds credential material).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getCapability } from "~/capabilities/registry.server";
import { xeroCapability } from "~/capabilities/xero.server";
import { getProvider } from "~/connections/providers.server";

const TEMPLATES_ROOT = join(__dirname, "../../catalog/templates");

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

describe("catalog capability blocks reference real registry definitions", () => {
  const withCapability = loadTemplates().filter((t) => t.manifest.capability);

  it("ships at least the xero template with a capability block", () => {
    expect(withCapability.map((t) => t.manifest.id)).toContain("xero");
  });

  it("every capability template names a capability-delivery provider with a registered definition", () => {
    for (const t of withCapability) {
      const provider = t.manifest.auth?.provider ?? "";
      expect(getProvider(provider)?.credentialDelivery, `${t.manifest.id}: provider`).toBe(
        "capability",
      );
      expect(getCapability(provider), `${t.manifest.id}: definition`).not.toBeNull();
    }
  });

  it("every referenced group id exists in the provider's capability definition", () => {
    for (const t of withCapability) {
      const definition = getCapability(t.manifest.auth?.provider ?? "")!;
      const known = new Set(definition.operationGroups.map((g) => g.id));
      for (const id of t.manifest.capability!.groups) {
        expect(known.has(id), `${t.manifest.id}: group "${id}"`).toBe(true);
      }
    }
  });
});

describe("the xero template's tool files", () => {
  const template = loadTemplates().find((t) => t.manifest.id === "xero")!;
  const operations = xeroCapability.operationGroups.flatMap((g) =>
    g.operations.map((op) => op.id),
  );

  it("offers every registry group (reads default-on server-side, writes opt-in)", () => {
    expect([...template.manifest.capability!.groups].sort()).toEqual(
      xeroCapability.operationGroups.map((g) => g.id).sort(),
    );
  });

  it("ships one tool file per whitelisted operation, POSTing to that operation's endpoint", () => {
    for (const op of operations) {
      const toolPath = `tools/xero-${op.replace(/_/g, "-")}.ts`;
      expect(template.manifest.files, `manifest lists ${toolPath}`).toContain(toolPath);
      const source = readFileSync(join(template.dir, "files", toolPath), "utf8");
      expect(source).toContain(`/api/capabilities/xero/${op}`);
      expect(source).toContain("EDEN_TEAM_TOKEN");
      expect(source).toContain("EDEN_API_URL");
      // The tool never expects credential material — that's the whole point.
      expect(source).not.toMatch(/XERO_OAUTH|XERO_CLIENT|refresh[_ ]?token/i);
    }
  });

  it("requests the fixed consent superset — the whitelist, not the token scope, is the enforcement plane", () => {
    expect(template.manifest.auth?.scopes).toEqual([
      "offline_access",
      "accounting.invoices",
      "accounting.contacts",
      "accounting.settings.read",
      "accounting.attachments",
    ]);
  });
});
