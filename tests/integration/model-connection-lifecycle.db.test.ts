/** Run against a migrated disposable database with HARNESST_DB_SMOKE=1. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ orgId: "", userId: "", allowed: true }));
const oauth = vi.hoisted(() => ({
  request: vi.fn(),
  poll: vi.fn(),
  exchange: vi.fn(),
}));
vi.mock("~/auth/session.server", () => ({
  getSessionAuth: async () => ({
    user: { id: authState.userId },
    requestHeaders: new Headers(),
  }),
}));
vi.mock("~/auth/workspace.server", () => ({
  resolveActiveWorkspace: async () => ({ org: { id: authState.orgId } }),
}));
vi.mock("~/lib/auth.server", () => ({
  auth: {
    api: { hasPermission: async () => ({ success: authState.allowed }) },
  },
}));
vi.mock("~/connections/codex.server", async (original) => ({
  ...(await original<typeof import("~/connections/codex.server")>()),
  requestDeviceCode: oauth.request,
  pollDeviceToken: oauth.poll,
  exchangeDeviceCode: oauth.exchange,
}));

import { db } from "~/db/client.server";
import { organization, user } from "~/db/auth-schema";
import {
  agents,
  agentModelOverrides,
  modelProviderConnections,
  modelConnectionLogins,
  playgroundSessions,
  projects,
  workspaceSettings,
} from "~/db/schema";
import {
  createCodexConnection,
  createApiKeyConnection,
  getApiKeyConnection,
  disconnectModelConnection,
  deleteModelConnection,
  deleteModelConnectionAlias,
  listModelConnectionAliases,
  getFreshAccessToken,
  getConnectionForGateway,
  persistRefreshedTokens,
  markConnectionStatus,
  recoverDeletedCodexConnection,
  resolveModelConnectionId,
} from "~/models/provider-connections.server";
import { resolveTargetModel } from "~/models/agent-model-config.server";
import {
  ownsWorkspaceModelReference,
  findWorkspaceModel,
  listWorkspaceModels,
} from "~/models/union.server";
import { action as login } from "~/routes/api.connections.codex";
import { action as chat } from "~/routes/api.gateway.chat";
import { mintGatewayToken } from "~/gateway/token.server";

const grant = (overrides = {}) => ({
  orgId: authState.orgId,
  label: "Original name",
  accountEmail: "same@example.test",
  accountId: "account-one",
  accessToken: "access-one",
  refreshToken: "refresh-one",
  expiresAt: new Date(Date.now() + 3600_000),
  ...overrides,
});
const jwt = (account: string) =>
  `e30.${Buffer.from(JSON.stringify({ email: "same@example.test", chatgpt_account_id: account })).toString("base64url")}.signature`;
const submit = async (values: Record<string, string>) => {
  const result = await login({
    request: new Request("http://localhost/api/connections/codex", {
      method: "POST",
      body: new URLSearchParams(values),
    }),
    context: {} as never,
    params: {},
  } as never);
  return (result as { data: Record<string, any> }).data;
};

describe.runIf(process.env.HARNESST_DB_SMOKE === "1")(
  "model connection lifecycle with Postgres",
  () => {
    beforeEach(async () => {
      authState.orgId = `lifecycle-${randomUUID()}`;
      authState.userId = `lifecycle-${randomUUID()}`;
      authState.allowed = true;
      await db.insert(organization).values({
        id: authState.orgId,
        name: "Lifecycle test",
        slug: authState.orgId,
        createdAt: new Date(),
      });
      await db.insert(user).values({
        id: authState.userId,
        name: "Lifecycle test",
        email: `${authState.userId}@example.test`,
      });
      oauth.request.mockResolvedValue({
        deviceAuthId: "server-only-device",
        userCode: "1234",
        interval: 1,
        verificationUrl: "http://localhost/device",
      });
      oauth.poll.mockResolvedValue({
        authorizationCode: "code",
        codeVerifier: "verifier",
      });
      oauth.exchange.mockResolvedValue({
        accessToken: jwt("account-one"),
        refreshToken: "renewed-refresh",
        expiresIn: 3600,
        idToken: null,
      });
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      await db.delete(organization).where(eq(organization.id, authState.orgId));
      await db.delete(user).where(eq(user.id, authState.userId));
      vi.clearAllMocks();
    });

    it("preserves defaults, explicit agent/subagent pins, session selections and identity through renewal and reconnect", async () => {
      const connection = await createCodexConnection(grant());
      const model = `codex/${connection.id}/gpt-5.5`;
      await db.insert(workspaceSettings).values({
        orgId: authState.orgId,
        assistantModel: model,
        assistantEffort: "high",
      });
      const [project] = await db
        .insert(projects)
        .values({
          orgId: authState.orgId,
          name: "Lifecycle",
          slug: "lifecycle",
        })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({ projectId: project.id, name: "pinned", root: "agent" })
        .returning();
      await db.insert(agentModelOverrides).values([
        {
          orgId: authState.orgId,
          projectId: project.id,
          agentName: "pinned",
          subagentPath: "",
          model,
          effort: "low",
        },
        {
          orgId: authState.orgId,
          projectId: project.id,
          agentName: "pinned",
          subagentPath: "researcher",
          model,
          effort: "medium",
        },
      ]);
      const [session] = await db
        .insert(playgroundSessions)
        .values({
          projectId: project.id,
          agentId: agent.id,
          modelId: model,
          effort: "high",
        })
        .returning();
      const readSelections = async () => ({
        inherited: await resolveTargetModel(authState.orgId, {
          agentName: "inherited",
          subagentPath: "",
          projectId: project.id,
        }),
        pinned: await resolveTargetModel(authState.orgId, {
          agentName: "pinned",
          subagentPath: "",
          projectId: project.id,
        }),
        subagent: await resolveTargetModel(authState.orgId, {
          agentName: "pinned",
          subagentPath: "researcher",
          projectId: project.id,
        }),
        session: (
          await db
            .select()
            .from(playgroundSessions)
            .where(eq(playgroundSessions.id, session.id))
        )[0],
      });
      const before = await readSelections();
      expect(before.inherited).toMatchObject({
        model,
        effort: "high",
        source: "workspace-default",
      });
      expect(before.pinned).toMatchObject({
        model,
        effort: "low",
        source: "override",
      });
      expect(before.subagent).toMatchObject({
        model,
        effort: "medium",
        source: "override",
      });
      const renewed = await createCodexConnection(
        grant({
          connectionId: connection.id,
          authorizationVersion: 0,
          accessToken: "renewed",
        }),
      );
      expect(renewed.id).toBe(connection.id);
      expect((await getFreshAccessToken(connection.id)).accessToken).toBe(
        "renewed",
      );
      await disconnectModelConnection(authState.orgId, connection.id);
      expect(await readSelections()).toEqual(before);
      expect(await getConnectionForGateway(connection.id)).toMatchObject({
        status: "revoked",
        accessToken: null,
        refreshToken: null,
      });
      await expect(getFreshAccessToken(connection.id)).rejects.toThrow();
      const restored = await createCodexConnection(
        grant({
          label: "Changed email label",
          accountEmail: "new@example.test",
          accessToken: "restored",
        }),
      );
      expect(restored.id).toBe(connection.id);
      expect(restored.label).toBe("Original name");
      expect(await readSelections()).toEqual(before);
      expect((await getFreshAccessToken(connection.id)).accessToken).toBe(
        "restored",
      );
    });

    it("renews API keys in place only after validation and preserves a usable key on failure", async () => {
      const input = {
        orgId: authState.orgId,
        provider: "openai" as const,
        label: "Platform",
        apiKey: "old-key",
      };
      const connection = await createApiKeyConnection(input, {
        validate: async () => {},
      });
      await expect(
        createApiKeyConnection(
          { ...input, connectionId: connection.id, apiKey: "bad" },
          {
            validate: async () => {
              throw new Error("Invalid key");
            },
          },
        ),
      ).rejects.toThrow("Invalid key");
      expect(
        (await getApiKeyConnection(authState.orgId, connection.id))?.apiKey,
      ).toBe("old-key");
      await disconnectModelConnection(authState.orgId, connection.id);
      expect(
        await getApiKeyConnection(authState.orgId, connection.id),
      ).toBeNull();
      const renewed = await createApiKeyConnection(
        {
          ...input,
          label: "Renamed",
          connectionId: connection.id,
          apiKey: "new-key",
        },
        { validate: async () => {} },
      );
      expect(renewed.id).toBe(connection.id);
      expect(renewed.label).toBe("Renamed");
      expect(
        (await getApiKeyConnection(authState.orgId, connection.id))?.apiKey,
      ).toBe("new-key");
    });

    it("rejects different accounts even with the same email and rejects partial grants", async () => {
      const conn = await createCodexConnection(grant());
      await expect(
        createCodexConnection(
          grant({ connectionId: conn.id, accountId: "other" }),
        ),
      ).rejects.toThrow("same OpenAI account");
      await expect(
        createCodexConnection(
          grant({ connectionId: conn.id, refreshToken: "" }),
        ),
      ).rejects.toThrow("complete grant");
      expect((await getFreshAccessToken(conn.id)).accessToken).toBe(
        "access-one",
      );
      const different = await createCodexConnection(
        grant({ accountId: "other" }),
      );
      expect(different.id).not.toBe(conn.id);
    });

    it("requires an explicit target for duplicate accounts and serializes concurrent first connections", async () => {
      const [one, two] = await Promise.all([
        createCodexConnection(grant()),
        createCodexConnection(grant()),
      ]);
      expect(one.id).toBe(two.id);
      await db.insert(modelProviderConnections).values({
        orgId: authState.orgId,
        provider: "codex",
        label: "Legacy duplicate",
        accountId: "account-one",
      });
      await expect(createCodexConnection(grant())).rejects.toThrow(
        "Several connections",
      );
      expect(
        (await createCodexConnection(grant({ connectionId: one.id }))).id,
      ).toBe(one.id);
    });

    it("fences late refresh success, invalid_grant, disconnect, and competing authorization", async () => {
      const conn = await createCodexConnection(grant());
      await createCodexConnection(
        grant({
          connectionId: conn.id,
          authorizationVersion: 0,
          accessToken: "new",
        }),
      );
      expect(
        await persistRefreshedTokens(
          conn.id,
          { accessToken: "old", refreshToken: "old", expiresAt: new Date() },
          0,
        ),
      ).toBe(false);
      expect(await markConnectionStatus(conn.id, "expired", 0)).toBe(false);
      await expect(
        createCodexConnection(
          grant({ connectionId: conn.id, authorizationVersion: 0 }),
        ),
      ).rejects.toThrow("changed during sign-in");
      expect((await getFreshAccessToken(conn.id)).accessToken).toBe("new");
      await disconnectModelConnection(authState.orgId, conn.id);
      expect(
        await persistRefreshedTokens(
          conn.id,
          { accessToken: "old", refreshToken: "old", expiresAt: new Date() },
          1,
        ),
      ).toBe(false);
    });

    it("recovers only explicitly verified deleted references in the owning workspace, including runtime calls", async () => {
      const conn = await createCodexConnection(grant());
      const input = {
        orgId: authState.orgId,
        oldId: "zzzzzzzzzzzz",
        connectionId: conn.id,
        verifiedBy: authState.userId,
        verified: true,
      };
      await expect(
        recoverDeletedCodexConnection({ ...input, verified: false }),
      ).rejects.toThrow("confirm");
      await expect(
        recoverDeletedCodexConnection({ ...input, oldId: conn.id }),
      ).rejects.toThrow("still exists");
      await recoverDeletedCodexConnection(input);
      expect(await resolveModelConnectionId(authState.orgId, input.oldId)).toBe(
        conn.id,
      );
      expect(
        await resolveModelConnectionId("another-workspace", input.oldId),
      ).toBe(input.oldId);
      expect(
        await ownsWorkspaceModelReference(
          authState.orgId,
          `codex/${input.oldId}/gpt-5.5`,
        ),
      ).toBe(true);
      expect(
        await findWorkspaceModel(
          authState.orgId,
          `codex/${input.oldId}/gpt-5.5`,
        ),
      ).not.toBeNull();
      const pickerModels = await listWorkspaceModels(authState.orgId);
      expect(
        pickerModels.some(
          (model) => model.id === `codex/${input.oldId}/gpt-5.5`,
        ),
      ).toBe(false);
      const upstream = vi.fn(
        async (_url: string | URL | Request, _options?: RequestInit) =>
          new Response(
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      vi.stubGlobal("fetch", upstream);
      const response = await chat({
        request: new Request(
          "http://localhost/api/gateway/v1/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${mintGatewayToken(authState.orgId)}`,
            },
            body: JSON.stringify({
              model: `codex/${input.oldId}/gpt-5.5`,
              messages: [{ role: "user", content: "hello" }],
              stream: false,
            }),
          },
        ),
        context: {} as never,
        params: {},
      } as never);
      expect(response.status).toBe(200);
      expect(upstream.mock.calls[0]?.[1]).toMatchObject({
        headers: {
          authorization: "Bearer access-one",
          "ChatGPT-Account-ID": "account-one",
        },
      });
    });

    it("binds OAuth attempts to the initiating user and target and does not accept client-supplied device details", async () => {
      const conn = await createCodexConnection(grant());
      const start = await submit({ intent: "start", connectionId: conn.id });
      expect(start.attemptId).toBeTruthy();
      expect(start.deviceAuthId).toBeUndefined();
      const originalUser = authState.userId;
      authState.userId = "attacker";
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId })).error,
      ).toBeTruthy();
      authState.userId = originalUser;
      expect(
        await submit({
          intent: "poll",
          attemptId: start.attemptId,
          connectionId: "fake-target",
          deviceAuthId: "fake-device",
        }),
      ).toEqual({ done: true });
      expect(oauth.poll).toHaveBeenCalledWith(
        expect.objectContaining({ deviceAuthId: "server-only-device" }),
      );
      expect((await getConnectionForGateway(conn.id))?.credentialVersion).toBe(
        1,
      );
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId })).error,
      ).toBeTruthy();
    });

    it.each(["disconnect", "renew", "create"])(
      "fences generic Connect against a later %s",
      async (change) => {
        let connection =
          change === "create" ? null : await createCodexConnection(grant());
        const attempt = await submit({ intent: "start" });
        if (change === "create")
          connection = await createCodexConnection(grant());
        else if (change === "disconnect")
          await disconnectModelConnection(authState.orgId, connection!.id);
        else
          await createCodexConnection(
            grant({
              connectionId: connection!.id,
              accessToken: "newer-authorization",
            }),
          );
        const before = await getConnectionForGateway(connection!.id);
        const result = await submit({
          intent: "poll",
          attemptId: attempt.attemptId,
        });
        expect(result.error).toContain("changed during sign-in");
        expect(await getConnectionForGateway(connection!.id)).toEqual(before);
      },
    );

    it.each(["refresh", "expiry"])(
      "allows authorization after background %s between start and poll",
      async (change) => {
        const connection = await createCodexConnection(grant());
        const start = await submit({
          intent: "start",
          connectionId: connection.id,
        });
        if (change === "refresh")
          await persistRefreshedTokens(
            connection.id,
            {
              accessToken: "background",
              refreshToken: "rotated",
              expiresAt: new Date(),
            },
            0,
          );
        else await markConnectionStatus(connection.id, "expired", 0);
        expect(
          await submit({ intent: "poll", attemptId: start.attemptId }),
        ).toEqual({ done: true });
        expect(
          (await getConnectionForGateway(connection.id))?.refreshToken,
        ).toBe("renewed-refresh");
      },
    );

    it("retries transient poll failures without consuming the login or exposing provider text", async () => {
      const connection = await createCodexConnection(grant());
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      oauth.poll.mockRejectedValueOnce(new Error("503 secret-token"));
      const failed = await submit({
        intent: "poll",
        attemptId: start.attemptId,
      });
      expect(failed.retryable).toBe(true);
      expect(failed.error).not.toContain("secret-token");
      expect(oauth.exchange).not.toHaveBeenCalled();
      expect(
        await submit({ intent: "poll", attemptId: start.attemptId }),
      ).toEqual({ done: true });
    });

    it("reclaims a crashed poll lease without allowing a concurrent live poll", async () => {
      const start = await submit({ intent: "start" });
      await db
        .update(modelConnectionLogins)
        .set({
          processing: true,
          processingId: "abandoned",
          processingStartedAt: new Date(),
        })
        .where(eq(modelConnectionLogins.id, start.attemptId));
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId })).error,
      ).toBeTruthy();
      expect(oauth.poll).not.toHaveBeenCalled();
      await db
        .update(modelConnectionLogins)
        .set({ processingStartedAt: new Date(Date.now() - 61_000) })
        .where(eq(modelConnectionLogins.id, start.attemptId));
      expect(
        await submit({ intent: "poll", attemptId: start.attemptId }),
      ).toEqual({ done: true });
    });

    it("requires explicit verification before adopting an account for a legacy null identity", async () => {
      const connection = await createCodexConnection(grant());
      await db
        .update(modelProviderConnections)
        .set({ accountId: null })
        .where(eq(modelProviderConnections.id, connection.id));
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      const pending = await submit({
        intent: "poll",
        attemptId: start.attemptId,
      });
      expect(pending).toMatchObject({
        verificationRequired: true,
        accountIds: ["account-one"],
      });
      expect((await getConnectionForGateway(connection.id))?.accessToken).toBe(
        "access-one",
      );
      expect(
        (
          await submit({
            intent: "confirm",
            attemptId: start.attemptId,
            accountId: "account-one",
          })
        ).verificationRequired,
      ).toBe(true);
      expect(
        await submit({
          intent: "confirm",
          attemptId: start.attemptId,
          accountId: "account-one",
          verifiedAccount: "yes",
        }),
      ).toEqual({ done: true });
      expect(oauth.exchange).toHaveBeenCalledTimes(1);
      expect(await getConnectionForGateway(connection.id)).toMatchObject({
        accountId: "account-one",
        refreshToken: "renewed-refresh",
      });
    });

    it.each([null, "org-old"])(
      "requires explicit reauthentication instead of silently duplicating legacy %s identity",
      async (oldAccountId) => {
        const connection = await createCodexConnection(grant());
        await db
          .update(modelProviderConnections)
          .set({ accountId: oldAccountId })
          .where(eq(modelProviderConnections.id, connection.id));
        await disconnectModelConnection(authState.orgId, connection.id);
        const token = {
          chatgpt_account_id: "account-one",
          "https://api.openai.com/auth": { organizations: [{ id: "org-old" }] },
        };
        oauth.exchange.mockResolvedValue({
          accessToken: `e30.${Buffer.from(JSON.stringify(token)).toString("base64url")}.signature`,
          refreshToken: "recovered",
          expiresIn: 3600,
          idToken: null,
        });
        const generic = await submit({ intent: "start" });
        expect(
          (await submit({ intent: "poll", attemptId: generic.attemptId }))
            .error,
        ).toBeTruthy();
        expect(
          await db
            .select({ id: modelProviderConnections.id })
            .from(modelProviderConnections)
            .where(eq(modelProviderConnections.orgId, authState.orgId)),
        ).toEqual([{ id: connection.id }]);
        expect((await getConnectionForGateway(connection.id))?.status).toBe(
          "revoked",
        );
        const explicit = await submit({
          intent: "start",
          connectionId: connection.id,
        });
        expect(
          (await submit({ intent: "poll", attemptId: explicit.attemptId }))
            .verificationRequired,
        ).toBe(true);
        expect(
          await submit({
            intent: "confirm",
            attemptId: explicit.attemptId,
            accountId: "account-one",
            verifiedAccount: "yes",
          }),
        ).toEqual({ done: true });
        expect(await getConnectionForGateway(connection.id)).toMatchObject({
          accountId: "account-one",
          status: "active",
          refreshToken: "recovered",
        });
      },
    );

    it("consumes a failed exchange attempt instead of retrying a spent code", async () => {
      const connection = await createCodexConnection(grant());
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      oauth.exchange.mockRejectedValueOnce(
        new Error("Codex authentication request timed out."),
      );
      expect(
        await submit({ intent: "poll", attemptId: start.attemptId }),
      ).toMatchObject({ retryable: false });
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId })).error,
      ).toBeTruthy();
      expect(oauth.poll).toHaveBeenCalledTimes(1);
      expect(oauth.exchange).toHaveBeenCalledTimes(1);
      expect((await getConnectionForGateway(connection.id))?.accessToken).toBe(
        "access-one",
      );
    });

    it("cancels legacy verification without replacing the old grant", async () => {
      const connection = await createCodexConnection(grant());
      await db
        .update(modelProviderConnections)
        .set({ accountId: null })
        .where(eq(modelProviderConnections.id, connection.id));
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId }))
          .verificationRequired,
      ).toBe(true);
      await submit({ intent: "cancel", attemptId: start.attemptId });
      expect(
        (
          await submit({
            intent: "confirm",
            attemptId: start.attemptId,
            accountId: "account-one",
            verifiedAccount: "yes",
          })
        ).error,
      ).toBeTruthy();
      expect(await getConnectionForGateway(connection.id)).toMatchObject({
        accountId: null,
        accessToken: "access-one",
        refreshToken: "refresh-one",
      });
    });

    it("cannot bypass a known account mismatch with the verification checkbox", async () => {
      const connection = await createCodexConnection(
        grant({ accountId: "different-known-account" }),
      );
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      expect(
        (
          await submit({
            intent: "confirm",
            attemptId: start.attemptId,
            accountId: "account-one",
            verifiedAccount: "yes",
          })
        ).error,
      ).toBeTruthy();
      expect(await getConnectionForGateway(connection.id)).toMatchObject({
        accountId: "different-known-account",
        accessToken: "access-one",
      });
    });

    it("explicitly migrates legacy organization identity and selects ambiguous organization claims", async () => {
      const connection = await createCodexConnection(
        grant({ accountId: "org-old" }),
      );
      const claims = {
        chatgpt_account_id: "account-new",
        "https://api.openai.com/auth": {
          organizations: [{ id: "org-old" }, { id: "org-other" }],
        },
      };
      oauth.exchange.mockResolvedValueOnce({
        accessToken: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
        refreshToken: "new",
        expiresIn: 3600,
        idToken: null,
      });
      const start = await submit({
        intent: "start",
        connectionId: connection.id,
      });
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId }))
          .verificationRequired,
      ).toBe(true);
      expect(
        await submit({
          intent: "confirm",
          attemptId: start.attemptId,
          accountId: "account-new",
          verifiedAccount: "yes",
        }),
      ).toEqual({ done: true });
      expect((await getConnectionForGateway(connection.id))?.accountId).toBe(
        "account-new",
      );
      const multi = {
        "https://api.openai.com/auth": {
          organizations: [{ id: "org-a" }, { id: "org-b" }],
        },
      };
      oauth.exchange.mockResolvedValueOnce({
        accessToken: `e30.${Buffer.from(JSON.stringify(multi)).toString("base64url")}.signature`,
        refreshToken: "multi",
        expiresIn: 3600,
        idToken: null,
      });
      const other = await submit({ intent: "start" });
      expect(
        await submit({ intent: "poll", attemptId: other.attemptId }),
      ).toMatchObject({
        verificationRequired: true,
        accountIds: ["org-a", "org-b"],
      });
      expect(
        (
          await submit({
            intent: "confirm",
            attemptId: other.attemptId,
            accountId: "untrusted",
            verifiedAccount: "yes",
          })
        ).verificationRequired,
      ).toBe(true);
      expect(
        await submit({
          intent: "confirm",
          attemptId: other.attemptId,
          accountId: "org-b",
          verifiedAccount: "yes",
        }),
      ).toEqual({ done: true });
    });

    it("permanently deletes only the owning workspace connection and cascades its recovery mappings", async () => {
      const connection = await createCodexConnection(grant());
      await recoverDeletedCodexConnection({
        orgId: authState.orgId,
        oldId: "zzzzzzzzzzzz",
        connectionId: connection.id,
        verifiedBy: authState.userId,
        verified: true,
      });
      expect(
        await deleteModelConnection("other-workspace", connection.id),
      ).toBe(false);
      expect(
        await disconnectModelConnection(authState.orgId, connection.id),
      ).toBe(true);
      expect(
        await disconnectModelConnection(authState.orgId, connection.id),
      ).toBe(false);
      expect(await deleteModelConnection(authState.orgId, connection.id)).toBe(
        true,
      );
      expect(await deleteModelConnection(authState.orgId, connection.id)).toBe(
        false,
      );
      expect(await getConnectionForGateway(connection.id)).toBeNull();
      expect(
        await resolveModelConnectionId(authState.orgId, "zzzzzzzzzzzz"),
      ).toBe("zzzzzzzzzzzz");
    });

    it("removes a recovery mapping only within its owning workspace", async () => {
      const connection = await createCodexConnection(grant());
      const input = {
        orgId: authState.orgId,
        oldId: "zzzzzzzzzzzz",
        connectionId: connection.id,
        verifiedBy: authState.userId,
        verified: true,
      };
      await recoverDeletedCodexConnection(input);
      expect(await listModelConnectionAliases(authState.orgId)).toEqual([
        { oldConnectionId: input.oldId, connectionId: connection.id },
      ]);
      expect(await deleteModelConnectionAlias("other", input.oldId)).toBe(
        false,
      );
      expect(await resolveModelConnectionId(authState.orgId, input.oldId)).toBe(
        connection.id,
      );
      expect(
        await deleteModelConnectionAlias(authState.orgId, input.oldId),
      ).toBe(true);
      expect(await resolveModelConnectionId(authState.orgId, input.oldId)).toBe(
        input.oldId,
      );
      expect(await getConnectionForGateway(connection.id)).not.toBeNull();
    });

    it("does not expose whether an old ID exists in another workspace", async () => {
      const connection = await createCodexConnection(grant());
      const otherOrg = `lifecycle-${randomUUID()}`;
      await db.insert(organization).values({
        id: otherOrg,
        name: "Other",
        slug: otherOrg,
        createdAt: new Date(),
      });
      try {
        const other = await createCodexConnection(grant({ orgId: otherOrg }));
        await recoverDeletedCodexConnection({
          orgId: authState.orgId,
          oldId: other.id,
          connectionId: connection.id,
          verifiedBy: authState.userId,
          verified: true,
        });
        expect(await resolveModelConnectionId(authState.orgId, other.id)).toBe(
          connection.id,
        );
        expect(await resolveModelConnectionId(otherOrg, other.id)).toBe(
          other.id,
        );
      } finally {
        await db.delete(organization).where(eq(organization.id, otherOrg));
      }
    });

    it("cancellation during token exchange preserves the usable grant", async () => {
      const conn = await createCodexConnection(grant());
      const start = await submit({ intent: "start", connectionId: conn.id });
      oauth.exchange.mockImplementationOnce(async () => {
        await submit({ intent: "cancel", attemptId: start.attemptId });
        return {
          accessToken: jwt("account-one"),
          refreshToken: "new",
          expiresIn: 3600,
          idToken: null,
        };
      });
      expect(
        (await submit({ intent: "poll", attemptId: start.attemptId })).error,
      ).toMatch(/cancelled/);
      expect((await getFreshAccessToken(conn.id)).accessToken).toBe(
        "access-one",
      );
    });

    it("does not leak upstream errors or mutate a grant when login fails", async () => {
      const conn = await createCodexConnection(grant());
      const start = await submit({ intent: "start", connectionId: conn.id });
      oauth.exchange.mockRejectedValueOnce(
        new Error("secret-token in provider response"),
      );
      const result = await submit({
        intent: "poll",
        attemptId: start.attemptId,
      });
      expect(result.error).not.toContain("secret-token");
      expect((await getFreshAccessToken(conn.id)).accessToken).toBe(
        "access-one",
      );
    });
  },
);
