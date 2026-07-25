/**
 * One-click Discord connect (issue #32) — the pure shapes plus the bot-token command
 * registration. The state token binds a Discord redirect back to (project, agent, environment)
 * and must fail closed on tamper/expiry/wrong-key. The command name must satisfy Discord's
 * slug rules. The registration is the connect proof (no OAuth token exchange), so its request
 * shape and error surfacing are what matter.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CONNECT_STATE_TTL_MS,
  DISCORD_API,
  DISCORD_BOT_PERMISSIONS,
  discordAuthorizeUrl,
  discordCommandName,
  ensureInteractionsEndpoint,
  registerGuildCommand,
  signConnectState,
  verifyConnectState,
  type ConnectState,
} from "~/discord/connect.server";

describe("connect state token", () => {
  const key = randomBytes(32);
  const state: ConnectState = {
    projectId: "projabcdefgh",
    agentId: "agntabcdefgh",
    environmentId: "envabcdefghi",
    userId: "user_1",
    sessionId: "sess_1",
    nonce: "nonce-value",
    exp: 1_800_000_000_000,
  };

  it("round-trips a signed state", () => {
    const token = signConnectState(state, key);
    expect(verifyConnectState(token, key, state.exp - 1000)).toEqual(state);
  });

  it("rejects a tampered payload and a garbage signature", () => {
    const token = signConnectState(state, key);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...state, agentId: "someoneelse1" }),
      "utf8",
    ).toString("base64url");
    expect(
      verifyConnectState(`${forged}.${sig}`, key, state.exp - 1000),
    ).toBeNull();
    expect(
      verifyConnectState(`${payload}.AAAA`, key, state.exp - 1000),
    ).toBeNull();
  });

  it("rejects the wrong key", () => {
    const token = signConnectState(state, key);
    expect(
      verifyConnectState(token, randomBytes(32), state.exp - 1000),
    ).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signConnectState(state, key);
    expect(verifyConnectState(token, key, state.exp)).toBeNull();
    expect(verifyConnectState(token, key, state.exp + 1)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyConnectState("", key)).toBeNull();
    expect(verifyConnectState("no-dot", key)).toBeNull();
    expect(CONNECT_STATE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("rejects a state without the user/session binding or nonce", () => {
    const { userId: _u, sessionId: _s, nonce: _n, ...legacy } = state;
    const token = signConnectState(legacy as ConnectState, key);
    expect(verifyConnectState(token, key, state.exp - 1000)).toBeNull();
  });
});

describe("discordCommandName", () => {
  it("lowercases and keeps valid characters", () => {
    expect(discordCommandName("Triage")).toBe("triage");
    expect(discordCommandName("code_bot-1")).toBe("code_bot-1");
  });

  it("collapses invalid runs to a single hyphen and trims", () => {
    expect(discordCommandName("My Cool Bot!!")).toBe("my-cool-bot");
    expect(discordCommandName("  spaced  out  ")).toBe("spaced-out");
  });

  it("caps at 32 characters without a trailing hyphen", () => {
    const name = discordCommandName(
      "a-really-really-really-long-agent-name-here",
    );
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name.endsWith("-")).toBe(false);
  });

  it("falls back to 'agent' when nothing survives", () => {
    expect(discordCommandName("!!!")).toBe("agent");
    expect(discordCommandName("")).toBe("agent");
  });
});

describe("discordAuthorizeUrl", () => {
  it("includes the app id, scopes, permissions, redirect and state, url-encoded", () => {
    const url = discordAuthorizeUrl({
      applicationId: "12345",
      redirectUri: "https://harnesst.example/discord/callback",
      state: "st at e",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(parsed.searchParams.get("client_id")).toBe("12345");
    expect(parsed.searchParams.get("scope")).toBe("bot applications.commands");
    expect(parsed.searchParams.get("permissions")).toBe(
      String(DISCORD_BOT_PERMISSIONS),
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://harnesst.example/discord/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("st at e");
  });

  it("carries the View Channels + Send Messages + Manage Webhooks bits", () => {
    expect(DISCORD_BOT_PERMISSIONS).toBe(1024 + 2048 + 536870912);
  });
});

describe("registerGuildCommand", () => {
  it("POSTs the command with a Bot auth header and the required 'message' option", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: "cmd_1", name: "triage" }), {
        status: 201,
      });
    }) as typeof fetch;

    const id = await registerGuildCommand(
      {
        applicationId: "app_1",
        botToken: "bot_secret",
        guildId: "guild_1",
        commandName: "triage",
        description: "Ask triage",
      },
      fetchImpl,
    );

    expect(id).toBe("cmd_1");
    expect(captured!.url).toBe(
      `${DISCORD_API}/applications/app_1/guilds/guild_1/commands`,
    );
    expect(captured!.init.method).toBe("POST");
    expect(
      (captured!.init.headers as Record<string, string>).authorization,
    ).toBe("Bot bot_secret");
    const body = JSON.parse(captured!.init.body as string);
    expect(body).toMatchObject({
      name: "triage",
      description: "Ask triage",
      type: 1,
      options: [
        {
          type: 3,
          name: "message",
          description: "What to ask the agent",
          required: true,
        },
      ],
    });
  });

  it("surfaces a 403 as a readable 'not installed' error", async () => {
    const fetchImpl = (async () =>
      new Response("Missing Access", { status: 403 })) as typeof fetch;
    await expect(
      registerGuildCommand(
        {
          applicationId: "app_1",
          botToken: "bot_secret",
          guildId: "guild_1",
          commandName: "triage",
          description: "Ask triage",
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/wasn't installed/);
  });
});

describe("ensureInteractionsEndpoint", () => {
  const config = { applicationId: "app_1", botToken: "bot_secret" };
  const endpoint = "https://harnesst.example/api/discord/interactions";

  it("leaves a matching endpoint alone (no PATCH)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ interactions_endpoint_url: endpoint }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      ensureInteractionsEndpoint(config, endpoint, fetchImpl),
    ).resolves.toBe("unchanged");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DISCORD_API}/applications/@me`);
    expect(
      (calls[0].init?.headers as Record<string, string>).authorization,
    ).toBe("Bot bot_secret");
  });

  it("PATCHes a drifted endpoint with the Bot auth header", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ interactions_endpoint_url: "https://old.example" }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      ensureInteractionsEndpoint(config, endpoint, fetchImpl),
    ).resolves.toBe("updated");
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${DISCORD_API}/applications/@me`);
    expect(calls[1].init?.method).toBe("PATCH");
    expect(
      (calls[1].init?.headers as Record<string, string>).authorization,
    ).toBe("Bot bot_secret");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      interactions_endpoint_url: endpoint,
    });
  });

  it("surfaces a rejected PATCH as a readable reachability error", async () => {
    let first = true;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({ interactions_endpoint_url: null }),
          { status: 200 },
        );
      }
      return new Response("endpoint validation failed", { status: 400 });
    }) as typeof fetch;

    await expect(
      ensureInteractionsEndpoint(config, endpoint, fetchImpl),
    ).rejects.toThrow(/publicly reachable/);
  });
});
