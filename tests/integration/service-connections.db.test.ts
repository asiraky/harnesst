/** Workspace service connections and provisioner linking against Postgres. Provider calls are faked. */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { SupabaseRequestError } from "~/marketplace/supabase-provisioning.server";
import { ServiceCredentialError } from "~/service-connections/providers.server";

const LIVE = process.env.HARNESST_DB_SMOKE === "1";
const TOKEN = "sbp_super_secret_token_value";
const verify = async () => ({ metadata: { organizations: ["Acme"] } });

describe.runIf(LIVE)("service connections against Postgres", () => {
  async function setup() {
    const { db } = await import("~/db/client.server");
    const { organization } = await import("~/db/auth-schema");
    const { projects } = await import("~/db/schema");
    const orgId = `org_svc_${crypto.randomUUID()}`;
    await db
      .insert(organization)
      .values({ id: orgId, name: "Svc", slug: orgId, createdAt: new Date() });
    const [project] = await db
      .insert(projects)
      .values({ orgId, name: "team", slug: orgId })
      .returning();
    return {
      orgId,
      projectId: project.id,
      cleanup: () => db.delete(organization).where(eq(organization.id, orgId)),
    };
  }

  it("seals the token and never puts it in a display shape", async () => {
    const conn = await import("~/service-connections/connections.server");
    const { db } = await import("~/db/client.server");
    const { serviceConnections } = await import("~/db/schema");
    const { orgId, cleanup } = await setup();
    try {
      const created = await conn.createServiceConnection(
        {
          orgId,
          provider: "supabase",
          label: " Prod ",
          credential: ` ${TOKEN} `,
        },
        { verify },
      );
      expect(created).toMatchObject({ label: "Prod", status: "active" });
      const [row] = await db
        .select()
        .from(serviceConnections)
        .where(eq(serviceConnections.id, created.id));
      expect(row.credentialCiphertext).not.toContain(TOKEN);
      for (const shape of [
        created,
        await conn.getServiceConnection(orgId, created.id),
        ...(await conn.listServiceConnections(orgId)),
      ])
        expect(JSON.stringify(shape)).not.toMatch(/sbp_|credential/i);
      await expect(
        conn.openServiceCredential({
          orgId,
          id: created.id,
          provider: "supabase",
        }),
      ).resolves.toMatchObject({ secret: TOKEN });
      // Another workspace can't open it.
      await expect(
        conn.openServiceCredential({
          orgId: "other",
          id: created.id,
          provider: "supabase",
        }),
      ).rejects.toBeInstanceOf(conn.ServiceConnectionUnusableError);
    } finally {
      await cleanup();
    }
  });

  it("refuses to save a token the provider rejects", async () => {
    const conn = await import("~/service-connections/connections.server");
    const { orgId, cleanup } = await setup();
    try {
      await expect(
        conn.createServiceConnection(
          { orgId, provider: "supabase", label: "Bad", credential: TOKEN },
          {
            verify: async () => {
              throw new ServiceCredentialError("rejected");
            },
          },
        ),
      ).rejects.toThrow("rejected");
      expect(await conn.listServiceConnections(orgId)).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("marks a rejected token invalid on re-verify and reactivates it on replace", async () => {
    const conn = await import("~/service-connections/connections.server");
    const { orgId, cleanup } = await setup();
    try {
      const { id } = await conn.createServiceConnection(
        { orgId, provider: "supabase", label: "Prod", credential: TOKEN },
        { verify },
      );
      const before = await conn.openServiceCredential({
        orgId,
        id,
        provider: "supabase",
      });
      // An outage says nothing about the token.
      await expect(
        conn.reverifyServiceConnection(
          { orgId, id },
          {
            verify: async () => {
              throw new Error("down");
            },
          },
        ),
      ).rejects.toThrow("down");
      expect((await conn.getServiceConnection(orgId, id))?.status).toBe(
        "active",
      );

      await expect(
        conn.reverifyServiceConnection(
          { orgId, id },
          {
            verify: async () => {
              throw new ServiceCredentialError("rejected");
            },
          },
        ),
      ).rejects.toThrow("rejected");
      expect((await conn.getServiceConnection(orgId, id))?.status).toBe(
        "invalid",
      );
      await expect(
        conn.openServiceCredential({ orgId, id, provider: "supabase" }),
      ).rejects.toBeInstanceOf(conn.ServiceConnectionUnusableError);

      await conn.replaceServiceConnectionCredential(
        { orgId, id, credential: "sbp_new" },
        { verify },
      );
      await expect(
        conn.openServiceCredential({ orgId, id, provider: "supabase" }),
      ).resolves.toMatchObject({
        secret: "sbp_new",
        credentialVersion: before.credentialVersion + 1,
      });
    } finally {
      await cleanup();
    }
  });

  it("marks the connection invalid when the provider rejects it mid-run, unless replaced meanwhile", async () => {
    const conn = await import("~/service-connections/connections.server");
    const { orgId, cleanup } = await setup();
    try {
      const { id } = await conn.createServiceConnection(
        { orgId, provider: "supabase", label: "Prod", credential: TOKEN },
        { verify },
      );
      const ref = { orgId, id, provider: "supabase" as const };
      // Replaced while the failing call ran: the new token stays active.
      await expect(
        conn.withServiceCredential(ref, async () => {
          await conn.replaceServiceConnectionCredential(
            { orgId, id, credential: "sbp_new" },
            { verify },
          );
          throw new SupabaseRequestError(401);
        }),
      ).rejects.toBeInstanceOf(conn.ServiceConnectionUnusableError);
      expect((await conn.getServiceConnection(orgId, id))?.status).toBe(
        "active",
      );

      await expect(
        conn.withServiceCredential(ref, async () => {
          throw new SupabaseRequestError(401);
        }),
      ).rejects.toBeInstanceOf(conn.ServiceConnectionUnusableError);
      expect((await conn.getServiceConnection(orgId, id))?.status).toBe(
        "invalid",
      );
    } finally {
      await cleanup();
    }
  });

  it("links a team: auto-selects one connection, saves it on use, falls back when removed", async () => {
    const conn = await import("~/service-connections/connections.server");
    const state = await import("~/provisioners/state.server");
    const { orgId, projectId, cleanup } = await setup();
    try {
      await state.ensureProvisioning(projectId, "supabase-ledger");
      await expect(
        state.withLinkedCredential(
          projectId,
          "supabase-ledger",
          async () => "ran",
        ),
      ).rejects.toThrow("Add a Supabase connection");

      const first = await conn.createServiceConnection(
        { orgId, provider: "supabase", label: "First", credential: TOKEN },
        { verify },
      );
      // Page loads resolve without saving.
      await state.withLinkedCredential(
        projectId,
        "supabase-ledger",
        async () => "",
        {
          saveAutoLink: false,
        },
      );
      expect(
        (await state.getProvisioning(projectId, "supabase-ledger"))
          ?.serviceConnectionId,
      ).toBeNull();
      await expect(
        state.withLinkedCredential(
          projectId,
          "supabase-ledger",
          async (secret) => secret,
        ),
      ).resolves.toBe(TOKEN);
      expect(
        (await state.getProvisioning(projectId, "supabase-ledger"))
          ?.serviceConnectionId,
      ).toBe(first.id);

      // A second connection doesn't change which one this team uses.
      const second = await conn.createServiceConnection(
        { orgId, provider: "supabase", label: "Second", credential: "sbp_two" },
        { verify },
      );
      expect(
        (await state.resolveProvisionerLink(projectId, "supabase-ledger")).link,
      ).toMatchObject({
        state: "ready",
        linked: true,
        connection: { id: first.id },
      });

      await state.linkProvisionerConnection({
        projectId,
        orgId,
        provisioner: "supabase-ledger",
        connectionId: second.id,
      });
      await expect(
        state.withLinkedCredential(
          projectId,
          "supabase-ledger",
          async (secret) => secret,
        ),
      ).resolves.toBe("sbp_two");

      // Another workspace's connection can't be linked.
      await expect(
        state.linkProvisionerConnection({
          projectId,
          orgId: "other",
          provisioner: "supabase-ledger",
          connectionId: second.id,
        }),
      ).rejects.toThrow("isn't available");

      await conn.removeServiceConnection({ orgId, id: second.id });
      expect(
        (await state.getProvisioning(projectId, "supabase-ledger"))
          ?.serviceConnectionId,
      ).toBeNull();
      expect(
        (await state.resolveProvisionerLink(projectId, "supabase-ledger")).link,
      ).toMatchObject({
        state: "ready",
        linked: false,
        connection: { id: first.id },
      });

      const { credentialVersion } = await conn.openServiceCredential({
        orgId,
        id: first.id,
        provider: "supabase",
      });
      await conn.markServiceConnectionUnusable({
        id: first.id,
        credentialVersion,
        status: "expired",
      });
      await expect(
        state.withLinkedCredential(
          projectId,
          "supabase-ledger",
          async () => "",
        ),
      ).rejects.toThrow("Reconnect Supabase");
    } finally {
      await cleanup();
    }
  });

  it("serialises runs per team", async () => {
    const state = await import("~/provisioners/state.server");
    const { projectId, cleanup } = await setup();
    try {
      let inner: unknown;
      const outer = await state.withExclusiveRun(
        projectId,
        "supabase-ledger",
        async () => {
          inner = await state.withExclusiveRun(
            projectId,
            "supabase-ledger",
            async () => "ran",
          );
          return "outer";
        },
      );
      expect([outer, inner]).toEqual(["outer", "busy"]);
      await expect(
        state.withExclusiveRun(
          projectId,
          "supabase-ledger",
          async () => "again",
        ),
      ).resolves.toBe("again");
    } finally {
      await cleanup();
    }
  });
});
