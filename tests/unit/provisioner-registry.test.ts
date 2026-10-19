import { describe, expect, it, vi } from "vitest";

import type { BundleProvisioningRow } from "~/db/schema";
import {
  provisioningIncomplete,
  resolveJobProvisioner,
  runProvisioningJob,
  scheduleProvisionerUpgrades,
} from "~/provisioners/registry.server";
import type { Provisioner } from "~/provisioners/types";

function row(
  status: string,
  provisioner = "supabase-ledger",
): BundleProvisioningRow {
  return { projectId: "p", provisioner, status } as BundleProvisioningRow;
}

function fake(overrides: Partial<Provisioner> = {}): Provisioner {
  return {
    descriptor: { id: "supabase-ledger" },
    install: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(undefined),
    upgrade: vi.fn().mockResolvedValue({ outcome: "upgraded", applied: [] }),
    needsUpgrade: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as Provisioner;
}

describe("resolveJobProvisioner", () => {
  it("uses the provisioner named in the payload", async () => {
    const p = fake();
    const list = vi.fn();
    await expect(
      resolveJobProvisioner(
        { projectId: "p", provisioner: "supabase-ledger" },
        { provisioner: () => p, list },
      ),
    ).resolves.toEqual({ projectId: "p", provisioner: p });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects an unknown provisioner", async () => {
    await expect(
      resolveJobProvisioner({ projectId: "p", provisioner: "nope" }),
    ).rejects.toThrow("Unknown provisioner");
  });

  it("maps a legacy payload to the project's single row", async () => {
    const p = fake();
    const get = vi.fn(() => p);
    await resolveJobProvisioner(
      { projectId: "p" },
      {
        list: async () => [row("running"), row("x", "retired")],
        provisioner: get,
      },
    );
    expect(get).toHaveBeenCalledWith("supabase-ledger");
  });

  it("refuses a legacy payload when the project has no single provisioner", async () => {
    await expect(
      resolveJobProvisioner({ projectId: "p" }, { list: async () => [] }),
    ).rejects.toThrow("no single one");
  });
});

describe("runProvisioningJob", () => {
  const payload = {
    projectId: "p",
    provisioner: "supabase-ledger",
    attempt: 3,
  };

  it("dispatches each job kind", async () => {
    const p = fake();
    const deps = { provisioner: () => p };
    await runProvisioningJob("provision_bundle", payload, deps);
    await runProvisioningJob("verify_bundle", payload, deps);
    await runProvisioningJob("upgrade_bundle", payload, deps);
    expect(p.install).toHaveBeenCalledWith("p");
    expect(p.verify).toHaveBeenCalledWith("p", 3);
    expect(p.upgrade).toHaveBeenCalledWith("p");
  });

  it("does not fail the job when an upgrade fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = fake({
      upgrade: vi
        .fn()
        .mockResolvedValue({ outcome: "failed", error: "Reconnect Supabase" }),
    });
    await expect(
      runProvisioningJob("upgrade_bundle", payload, { provisioner: () => p }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("scheduleProvisionerUpgrades", () => {
  it("enqueues an upgrade only for installed rows that are behind", async () => {
    const behind = fake();
    const enqueue = vi.fn().mockResolvedValue("job");
    const scheduled = await scheduleProvisionerUpgrades("p", {
      list: async () => [row("ready"), row("pending"), row("ready", "retired")],
      provisioner: () => behind,
      enqueue,
    });
    expect(scheduled).toEqual(["supabase-ledger"]);
    expect(behind.needsUpgrade).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      "upgrade_bundle",
      { projectId: "p", provisioner: "supabase-ledger" },
      { maxAttempts: 1 },
    );
  });

  it("enqueues nothing when everything is current", async () => {
    const enqueue = vi.fn();
    await expect(
      scheduleProvisionerUpgrades("p", {
        list: async () => [row("provisioned")],
        provisioner: () =>
          fake({ needsUpgrade: vi.fn().mockResolvedValue(false) }),
        enqueue,
      }),
    ).resolves.toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("provisioningIncomplete", () => {
  const list = (rows: BundleProvisioningRow[]) => ({ list: async () => rows });

  it("is complete when nothing known is declared", async () => {
    await expect(
      provisioningIncomplete("p", ["retired"], list([])),
    ).resolves.toBe(false);
  });

  it("is incomplete without a row, or until verified", async () => {
    const declared = ["supabase-ledger"];
    await expect(provisioningIncomplete("p", declared, list([]))).resolves.toBe(
      true,
    );
    await expect(
      provisioningIncomplete("p", declared, list([row("provisioned")])),
    ).resolves.toBe(true);
    await expect(
      provisioningIncomplete("p", declared, list([row("ready")])),
    ).resolves.toBe(false);
  });
});
