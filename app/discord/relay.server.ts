/**
 * Discord interactions relay (issue #32). harnesst's shared app has ONE Interactions Endpoint URL
 * pointing at the control plane; this module verifies Discord's Ed25519 signature and resolves
 * which agent instance a given interaction routes to. The route (`api.discord.interactions.ts`)
 * then forwards the raw request to that instance's eve Discord channel untouched. Application
 * commands also produce a deterministic running-run record before that hop, so work remains
 * visible even if the instance is interrupted before it can finish.
 *
 * Signature verification, target resolution, and run-start shaping are pure/injectable so they
 * unit-test with a real Ed25519 keypair and a fake store — zero network, zero database.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import {
  findConnectionByGuildCommand,
  listConnectionsForGuild,
  type DiscordConnection,
} from "./connections.server";

/** The Ed25519 SPKI DER prefix — prepended to a 32-byte raw public key to build a KeyObject. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify Discord's request signature: Ed25519 over `timestamp + rawBody`, the signature and
 * public key both hex. Any malformed input (bad hex, wrong length) fails closed as false.
 */
export function verifyDiscordSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): boolean {
  if (!signature || !timestamp) return false;
  try {
    const keyDer = Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const key = createPublicKey({ key: keyDer, format: "der", type: "spki" });
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const sig = Buffer.from(signature, "hex");
    if (sig.length !== 64) return false;
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

/* ─────────────────────────────── target resolution ─────────────────────────────── */

/** A slash-command option. Subcommands and subcommand groups carry nested `options`. */
export interface InteractionOption {
  name?: string;
  value?: string | number | boolean;
  options?: InteractionOption[];
}

/** Public Discord user attribution included with an interaction. */
export interface InteractionUser {
  id?: string;
  username?: string;
  global_name?: string;
}

/** A Discord interaction payload — only the fields the relay routes or records on. */
export interface InteractionPayload {
  id?: string;
  application_id?: string;
  channel_id?: string;
  type?: number;
  guild_id?: string;
  data?: { id?: string; name?: string; options?: InteractionOption[] };
  member?: { nick?: string; user?: InteractionUser };
  user?: InteractionUser;
  message?: {
    interaction_metadata?: { name?: string };
    interaction?: { name?: string };
  };
}

/** The deployment fields needed both to forward the request and attribute its run. */
export interface LiveRelayDeployment {
  id: string;
  releaseId: string;
  url: string;
}

export type RelayTarget =
  | {
      ok: true;
      url: string;
      deploymentId: string;
      releaseId: string;
      connection: DiscordConnection;
    }
  | { ok: false; reason: "no-connection" | "no-live-deployment" };

export interface RelayDeps {
  findConnection: (
    guildId: string,
    commandName: string,
  ) => Promise<DiscordConnection | null>;
  listConnections: (guildId: string) => Promise<DiscordConnection[]>;
  /** The live (status='live', non-null url) deployment for an environment, or null. */
  findLiveDeployment: (
    environmentId: string,
  ) => Promise<LiveRelayDeployment | null>;
}

/** APPLICATION_COMMAND interaction type. */
const TYPE_APPLICATION_COMMAND = 2;

/**
 * Resolve the instance a Discord interaction routes to. Command interactions look up the
 * connection by (guild, command name). Non-command interactions (components/modals/autocomplete)
 * carry no command name of their own, so they fall back to: the guild's sole connection, else
 * the originating command name in the message's interaction metadata, else nothing.
 */
export async function resolveRelayTarget(
  payload: InteractionPayload,
  deps: RelayDeps,
): Promise<RelayTarget> {
  const guildId = payload.guild_id;
  if (!guildId) return { ok: false, reason: "no-connection" };

  let connection: DiscordConnection | null = null;
  if (payload.type === TYPE_APPLICATION_COMMAND && payload.data?.name) {
    connection = await deps.findConnection(guildId, payload.data.name);
  } else {
    const all = await deps.listConnections(guildId);
    if (all.length === 1) {
      connection = all[0];
    } else {
      const originName =
        payload.message?.interaction_metadata?.name ??
        payload.message?.interaction?.name ??
        null;
      if (originName) {
        connection = all.find((c) => c.commandName === originName) ?? null;
      }
    }
  }
  if (!connection) return { ok: false, reason: "no-connection" };

  const deployment = await deps.findLiveDeployment(connection.environmentId);
  if (!deployment) return { ok: false, reason: "no-live-deployment" };
  return {
    ok: true,
    url: deployment.url,
    deploymentId: deployment.id,
    releaseId: deployment.releaseId,
    connection,
  };
}

/** Default deps: the real connection store + liveness-aware deployment resolution. */
export function defaultRelayDeps(): RelayDeps {
  return {
    findConnection: findConnectionByGuildCommand,
    listConnections: listConnectionsForGuild,
    findLiveDeployment,
  };
}

/** The attributed live deployment for an environment, including its loopback url, or null. */
export async function findLiveDeployment(
  environmentId: string,
): Promise<LiveRelayDeployment | null> {
  const deployment = await ensureLiveDeploymentForEnvironment(environmentId);
  return deployment?.url
    ? {
        id: deployment.id,
        releaseId: deployment.releaseId,
        url: deployment.url,
      }
    : null;
}

/* ─────────────────────────────── run start shaping ─────────────────────────────── */

/** The exact structural input accepted by `recordTurnStart`. */
export interface DiscordRunStartInput {
  projectId: string;
  deploymentId: string;
  releaseId: string;
  externalRunId: string;
  externalSessionId: string;
  userMessage?: string;
  channel: "discord";
  metadata: Record<string, unknown>;
}

/**
 * Build the start record for a Discord command that begins agent work. PINGs, components, and
 * modal submissions may be routed to Eve, but they do not independently start agent turns and
 * therefore must not create Runs rows.
 */
export function discordRunStart(
  payload: InteractionPayload,
  target: RelayTarget,
): DiscordRunStartInput | null {
  const interactionId = nonEmptyString(payload.id);
  if (
    payload.type !== TYPE_APPLICATION_COMMAND ||
    !interactionId ||
    !target.ok
  ) {
    return null;
  }

  const externalId = `discord:${interactionId}`;
  const userMessage = commandMessageOption(payload.data?.options);
  const actor = payload.member?.user ?? payload.user;
  const metadata: Record<string, unknown> = {
    discordInteractionId: interactionId,
    discordConnectionId: target.connection.id,
  };

  addStringMetadata(metadata, "discordApplicationId", payload.application_id);
  addStringMetadata(metadata, "discordGuildId", payload.guild_id);
  addStringMetadata(metadata, "discordGuildName", target.connection.guildName);
  addStringMetadata(metadata, "discordChannelId", payload.channel_id);
  addStringMetadata(metadata, "discordCommandId", payload.data?.id);
  addStringMetadata(metadata, "discordCommandName", payload.data?.name);
  addStringMetadata(metadata, "discordUserId", actor?.id);
  addStringMetadata(metadata, "discordUsername", actor?.username);
  addStringMetadata(metadata, "discordGlobalName", actor?.global_name);
  addStringMetadata(metadata, "discordMemberNickname", payload.member?.nick);

  return {
    projectId: target.connection.projectId,
    deploymentId: target.deploymentId,
    releaseId: target.releaseId,
    externalRunId: externalId,
    externalSessionId: externalId,
    ...(userMessage ? { userMessage } : {}),
    channel: "discord",
    metadata,
  };
}

/** Match Eve's recursive lookup for the first primitive option named `message`. */
function commandMessageOption(options: unknown): string | undefined {
  const value = findOptionValue(options, "message");
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function findOptionValue(
  options: unknown,
  name: string,
): string | number | boolean | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const value of options) {
    if (!value || typeof value !== "object") continue;
    const option = value as Record<string, unknown>;
    const optionValue = option.value;
    if (
      option.name === name &&
      (typeof optionValue === "string" ||
        typeof optionValue === "number" ||
        typeof optionValue === "boolean")
    ) {
      return optionValue;
    }
    const nested = findOptionValue(option.options, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function addStringMetadata(
  metadata: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const text = nonEmptyString(value);
  if (text) metadata[key] = text;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
