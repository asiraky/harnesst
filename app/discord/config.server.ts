/**
 * Operator config for harnesst's ONE shared Discord app (issue #32). A self-host installation
 * registers a single Discord application in the Developer Portal and sets its three
 * credentials as control-plane env. The connect flow, the interactions relay, and the send
 * proxy all read this — the bot token NEVER leaves the control plane (it can act in every
 * connected server across all tenants), only the public credentials reach agent instances.
 *
 * Null unless all three are present: a partial config can't drive any Discord operation, and
 * treating it as "unconfigured" keeps legacy self-managed-app users untouched at deploy time.
 */
export interface DiscordAppConfig {
  applicationId: string;
  botToken: string;
  publicKey: string;
}

/** The shared app's config, or null when the operator hasn't set all three env vars. */
export function getDiscordAppConfig(): DiscordAppConfig | null {
  const applicationId = process.env.EDEN_DISCORD_APPLICATION_ID?.trim();
  const botToken = process.env.EDEN_DISCORD_BOT_TOKEN?.trim();
  const publicKey = process.env.EDEN_DISCORD_PUBLIC_KEY?.trim();
  if (!applicationId || !botToken || !publicKey) return null;
  return { applicationId, botToken, publicKey };
}
