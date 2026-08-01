/**
 * Discord interactions relay (issues #32/#83). The signature check uses Discord's real signing
 * scheme, target resolution carries deployment attribution without changing routing, and only
 * application commands shape deterministic running-run records — all with zero network/DB.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureLiveDeploymentForEnvironment } = vi.hoisted(() => ({
  ensureLiveDeploymentForEnvironment: vi.fn(),
}));

vi.mock("~/deploy/wake.server", () => ({
  ensureLiveDeploymentForEnvironment,
}));

import type { DiscordConnection } from "~/discord/connections.server";
import {
  discordRunStart,
  findLiveDeployment,
  resolveRelayTarget,
  verifyDiscordSignature,
  type InteractionPayload,
  type RelayDeps,
  type RelayTarget,
} from "~/discord/relay.server";

beforeEach(() => {
  ensureLiveDeploymentForEnvironment.mockReset();
});

/** A real Ed25519 keypair; export the raw 32-byte public key as hex (last 32 bytes of SPKI DER). */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString(
    "hex",
  );
  return { privateKey, publicKeyHex };
}

describe("verifyDiscordSignature", () => {
  const { privateKey, publicKeyHex } = keypair();
  const timestamp = "1700000000";
  const body = JSON.stringify({ type: 1 });
  const signature = Buffer.from(
    edSign(null, Buffer.from(timestamp + body, "utf8"), privateKey),
  ).toString("hex");

  it("accepts a correctly signed request", () => {
    expect(
      verifyDiscordSignature(body, signature, timestamp, publicKeyHex),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyDiscordSignature(body + " ", signature, timestamp, publicKeyHex),
    ).toBe(false);
  });

  it("rejects a wrong timestamp", () => {
    expect(
      verifyDiscordSignature(body, signature, "1700000001", publicKeyHex),
    ).toBe(false);
  });

  it("rejects missing headers and garbage hex", () => {
    expect(verifyDiscordSignature(body, null, timestamp, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, signature, null, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, "zzzz", timestamp, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, signature, timestamp, "not-hex")).toBe(
      false,
    );
  });
});

describe("resolveRelayTarget", () => {
  const conn = (over: Partial<DiscordConnection>): DiscordConnection => ({
    id: "conn_1",
    projectId: "proj_1",
    agentId: "agent_1",
    environmentId: "env_1",
    guildId: "guild_1",
    guildName: "Acme",
    commandName: "triage",
    commandId: "cmd_1",
    ...over,
  });

  const deps = (over: Partial<RelayDeps>): RelayDeps => ({
    findConnection: async () => null,
    listConnections: async () => [],
    findLiveDeployment: async () => ({
      id: "dep_1",
      releaseId: "rel_1",
      url: "http://127.0.0.1:3700",
    }),
    ...over,
  });

  it("routes a command interaction by (guild, command name)", async () => {
    const c = conn({});
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_1", data: { name: "triage" } },
      deps({
        findConnection: async (g, n) =>
          g === "guild_1" && n === "triage" ? c : null,
      }),
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:3700",
      deploymentId: "dep_1",
      releaseId: "rel_1",
      connection: c,
    });
  });

  it("returns no-connection for an unknown guild/command", async () => {
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_x", data: { name: "nope" } },
      deps({}),
    );
    expect(result).toEqual({ ok: false, reason: "no-connection" });
  });

  it("returns no-live-deployment when the connection has no live url", async () => {
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_1", data: { name: "triage" } },
      deps({
        findConnection: async () => conn({}),
        findLiveDeployment: async () => null,
      }),
    );
    expect(result).toEqual({ ok: false, reason: "no-live-deployment" });
  });

  it("routes a non-command interaction via the guild's sole connection", async () => {
    const c = conn({});
    const result = await resolveRelayTarget(
      { type: 3, guild_id: "guild_1" } as InteractionPayload,
      deps({ listConnections: async () => [c] }),
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:3700",
      deploymentId: "dep_1",
      releaseId: "rel_1",
      connection: c,
    });
  });

  it("routes a non-command interaction by originating command metadata when ambiguous", async () => {
    const a = conn({ id: "a", commandName: "triage" });
    const b = conn({ id: "b", commandName: "reviewer", agentId: "agent_2" });
    const result = await resolveRelayTarget(
      {
        type: 3,
        guild_id: "guild_1",
        message: { interaction_metadata: { name: "reviewer" } },
      },
      deps({ listConnections: async () => [a, b] }),
    );
    expect(result.ok && result.connection.id).toBe("b");
  });

  it("returns no-connection for an ambiguous guild with no metadata match", async () => {
    const a = conn({ id: "a", commandName: "triage" });
    const b = conn({ id: "b", commandName: "reviewer" });
    const result = await resolveRelayTarget(
      { type: 3, guild_id: "guild_1" } as InteractionPayload,
      deps({ listConnections: async () => [a, b] }),
    );
    expect(result).toEqual({ ok: false, reason: "no-connection" });
  });
});

describe("findLiveDeployment", () => {
  it("resolves Discord traffic through the liveness-aware wake path", async () => {
    ensureLiveDeploymentForEnvironment.mockResolvedValue({
      id: "dep_1",
      releaseId: "rel_1",
      url: "http://fresh.local",
    });

    await expect(findLiveDeployment("env_1")).resolves.toEqual({
      id: "dep_1",
      releaseId: "rel_1",
      url: "http://fresh.local",
    });
    expect(ensureLiveDeploymentForEnvironment).toHaveBeenCalledWith("env_1");
  });
});

describe("discordRunStart", () => {
  const connection: DiscordConnection = {
    id: "conn_1",
    projectId: "proj_1",
    agentId: "agent_1",
    environmentId: "env_1",
    guildId: "guild_1",
    guildName: "Acme",
    commandName: "triage",
    commandId: "cmd_1",
  };

  const target: RelayTarget = {
    ok: true,
    url: "http://127.0.0.1:3700",
    deploymentId: "dep_1",
    releaseId: "rel_1",
    connection,
  };

  it("builds an attributed deterministic start for an application command", () => {
    const payload = {
      id: "interaction_123",
      application_id: "application_1",
      channel_id: "channel_1",
      guild_id: "guild_1",
      type: 2,
      data: {
        id: "command_1",
        name: "triage",
        options: [
          {
            name: "project",
            options: [
              { name: "message", value: "Investigate the failed deploy" },
            ],
          },
        ],
      },
      member: {
        nick: "Ada",
        user: {
          id: "user_1",
          username: "ada",
          global_name: "Ada Lovelace",
        },
      },
      // Discord includes this in the real payload; it must never be copied into run metadata.
      token: "interaction-token-is-secret",
    } as InteractionPayload & { token: string };

    const result = discordRunStart(payload, target);

    expect(result).toEqual({
      projectId: "proj_1",
      deploymentId: "dep_1",
      releaseId: "rel_1",
      externalRunId: "discord:interaction_123",
      externalSessionId: "discord:interaction_123",
      userMessage: "Investigate the failed deploy",
      channel: "discord",
      metadata: {
        discordInteractionId: "interaction_123",
        discordConnectionId: "conn_1",
        discordApplicationId: "application_1",
        discordGuildId: "guild_1",
        discordGuildName: "Acme",
        discordChannelId: "channel_1",
        discordCommandId: "command_1",
        discordCommandName: "triage",
        discordUserId: "user_1",
        discordUsername: "ada",
        discordGlobalName: "Ada Lovelace",
        discordMemberNickname: "Ada",
      },
    });
    expect(JSON.stringify(result)).not.toContain(payload.token);
  });

  it("uses top-level user attribution and omits blank message options", () => {
    const result = discordRunStart(
      {
        id: "interaction_456",
        type: 2,
        data: {
          name: "triage",
          options: [{ name: "message", value: "   " }],
        },
        user: { id: "user_2", username: "grace" },
      },
      target,
    );

    expect(result).not.toHaveProperty("userMessage");
    expect(result?.metadata).toMatchObject({
      discordInteractionId: "interaction_456",
      discordUserId: "user_2",
      discordUsername: "grace",
    });
  });

  it.each([1, 3, 5])(
    "does not create a run start for interaction type %i",
    (type) => {
      expect(
        discordRunStart(
          {
            id: `interaction_${type}`,
            type,
            data: {
              name: "triage",
              options: [{ name: "message", value: "do not record this" }],
            },
          },
          target,
        ),
      ).toBeNull();
    },
  );

  it("does not create a run start without a stable interaction id or live target", () => {
    expect(discordRunStart({ type: 2 }, target)).toBeNull();
    expect(
      discordRunStart(
        { id: "interaction_789", type: 2 },
        { ok: false, reason: "no-live-deployment" },
      ),
    ).toBeNull();
  });
});
