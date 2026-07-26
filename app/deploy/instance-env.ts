/**
 * The env-name half of the instance runtime contract (issue #235).
 *
 * Code harnesst GENERATES into a customer's repo — the sandbox module, the model router in
 * `agent.ts`, the catalog's shipped tools — reads `process.env.HARNESST_*` for things the deploy
 * controller injects into the instance container at deploy time. Both halves have to agree, and
 * nothing links them: the generated half is committed inside someone else's repository, the
 * injecting half is a `envVars.X = …` line in `controller.server.ts`. When the #213 rename moved
 * one half and not the other, the failure was silent — `process.env.EDEN_SANDBOX_ENV` is just
 * `undefined`, so the sandbox forwarded no secrets at all and the agent's shell lost every
 * credential, with nothing logged anywhere.
 *
 * This module is that missing link, written down: the names an instance container can rely on.
 * `tests/unit/instance-env.test.ts` reads it from both sides — every `HARNESST_*` name generated
 * code references must appear here, and every name the controller injects must appear here too —
 * so the next rename cannot half-land without a red test.
 *
 * Pure (no I/O, no imports) so both the generated-code scan and the controller can use it.
 */

/**
 * Exact env names harnesst injects into an agent's instance container.
 *
 * Deliberately NOT the control plane's own configuration (`HARNESST_PUBLIC_ORIGIN`,
 * `HARNESST_SECRETS_KEY`, `HARNESST_XERO_CLIENT_ID`, the deploy tunables): those are read by the
 * server process, never by an agent, and a generated file referencing one would be a bug.
 */
export const INSTANCE_ENV_NAMES = [
  /** Comma-joined NAMES of the secrets the sandbox may forward (the exposure convention). */
  "HARNESST_SANDBOX_ENV",
  /** Base URL + bearer for the translating model gateway. */
  "HARNESST_MODEL_GATEWAY_URL",
  "HARNESST_MODEL_GATEWAY_TOKEN",
  /** HMAC key the generated model-directive parser verifies playground overrides with. */
  "HARNESST_MODEL_DIRECTIVE_SECRET",
  /** Team relay: peer roster, its endpoint, and the deployment-scoped delegation token. */
  "HARNESST_TEAM_URL",
  "HARNESST_TEAM_TOKEN",
  "HARNESST_TEAMMATES",
  "HARNESST_DELEGATION_TIMEOUT_MS",
  /** Control-plane proxy endpoints the instance calls with its delegation token. */
  "HARNESST_DISCORD_SEND_URL",
  "HARNESST_API_URL",
  /** Marker naming the capability providers harnesst brokered for this deploy. */
  "HARNESST_CAPABILITY_PROVIDERS",
] as const;

export type InstanceEnvName = (typeof INSTANCE_ENV_NAMES)[number];

/**
 * Per-connection model API keys, whose names are assembled at runtime from the provider and
 * connection id (`app/models/provider-reference.ts`) — an open set, so they are matched by shape.
 */
const PROVIDER_API_KEY = /^HARNESST_PROVIDER_[A-Z0-9]+_[A-Z0-9]+_API_KEY$/;

/** Whether `name` is an env var an instance container can rely on harnesst providing. */
export function isInstanceEnvName(name: string): boolean {
  return (
    (INSTANCE_ENV_NAMES as readonly string[]).includes(name) ||
    PROVIDER_API_KEY.test(name)
  );
}

/**
 * Every `HARNESST_*` env name `source` READS, distinct and sorted — property access, bracket
 * access, and bare string literals (generated code passes names around as strings: the sandbox
 * module splits `HARNESST_SANDBOX_ENV` into names it then looks up).
 *
 * Deliberately not a bare-token scan: generated modules also DECLARE constants in the same shape
 * (`const HARNESST_MODEL_DIRECTIVE = /…/`) and name env vars in comments, neither of which is a
 * claim on the deploy contract. Trailing-underscore literals are concatenation prefixes
 * (`'HARNESST_PROVIDER_' + provider + …`) with no complete name to check yet; the legacy-token
 * assertion in the same test is what keeps those honest across a rename.
 */
export function harnesstEnvNamesIn(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /process\.env\.(HARNESST_[A-Z0-9_]+)/g,
    /process\.env\[\s*['"`](HARNESST_[A-Z0-9_]+)['"`]/g,
    /['"`](HARNESST_[A-Z0-9_]+)['"`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name.endsWith("_")) continue;
      found.add(name);
    }
  }
  return [...found].sort();
}
