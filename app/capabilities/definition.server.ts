/**
 * Capability definitions (issue #166) — the brokered-capability framework's contract.
 *
 * A capability generalizes the Discord send proxy (issue #32): harnesst holds the vendor credential
 * (an ordinary brokered OAuth grant, issue #163) and exposes a FIXED registry of whitelisted
 * operations per provider. The credential is NEVER injected into an agent's instance
 * (`credentialDelivery: "capability"` on the provider entry); the agent's thin tools POST to
 * `POST /api/capabilities/:provider/:operation` with their `EDEN_TEAM_TOKEN`, and the control
 * plane validates the request server-side and performs the one blessed operation itself.
 * Anything not in a definition does not exist — there is no passthrough.
 *
 * Definitions are CODE (validation logic can't be data): one module per provider, registered in
 * `registry.server.ts`. `.server.ts` throughout — `execute` reaches vendor APIs and `resource`
 * lists provider-side bindings with a live access token.
 */
import type { z } from "zod";

export interface CapabilityDefinition {
  /** OAuth broker provider id (issue #163 registry) whose grant this capability consumes. */
  provider: string;
  /**
   * Provider-side resource binding required before calls can run (Xero: the tenant/organisation).
   * Drives the post-consent picker: exactly one listed resource binds silently; several render a
   * picker page before the connection is usable. `list` runs with a fresh access token.
   */
  resource?: {
    /** Human noun for the picker, e.g. "organisation". */
    label: string;
    list(
      accessToken: string,
      fetchImpl: typeof fetch,
    ): Promise<Array<{ id: string; name: string }>>;
  };
  operationGroups: OperationGroup[];
}

export interface OperationGroup {
  /** Stable slug the manifest/lock reference, e.g. "bills-draft". */
  id: string;
  /** Short human label, e.g. "Create draft bills". */
  label: string;
  /** Plain-words consequence of enabling this group. */
  description: string;
  /** Write groups render visually distinct and are never pre-ticked by convention. */
  risk: "read" | "write";
  /** Pre-ticked at install. */
  default?: boolean;
  operations: Operation[];
}

/** What an operation's `validate` returns: a pass, or a readable refusal for the agent. */
export type OperationValidation = { ok: true } | { ok: false; error: string };

/** Everything an operation needs to reach the vendor. The refresh token never appears here. */
export interface OperationContext {
  /** Freshly refreshed access token — used immediately, never stored by the operation. */
  accessToken: string;
  /** The grant's bound provider-side resource id (null when the capability declares none). */
  resourceId: string | null;
  agentId: string;
  fetch: typeof fetch;
}

export interface Operation {
  /** Unique per provider, e.g. "create_draft_bill" — the URL's `:operation` segment. */
  id: string;
  /** Typed input contract; the agent-side tool mirrors it. Unknown keys are stripped by zod. */
  input: z.ZodType;
  /**
   * The redacted audit digest for a (parsed) input — e.g. `{ contact, total, currency }` for a
   * bill. Never the raw payload, never attachment bytes.
   */
  summarize(input: unknown): Record<string, unknown>;
  /**
   * Server-side invariants beyond shape — the whitelist's teeth (e.g. "account codes exist in
   * the org's chart"). Runs with a live context so invariants can consult the vendor. Return a
   * readable refusal; throw only on transport failures.
   */
  validate?(input: unknown, ctx: OperationContext): Promise<OperationValidation>;
  /** Perform the operation. Throws a readable Error on vendor rejection/transport failure. */
  execute(input: unknown, ctx: OperationContext): Promise<unknown>;
}

/** The operation + its group for an id, or null — unlisted operations DO NOT EXIST. */
export function findOperation(
  definition: CapabilityDefinition,
  operationId: string,
): { group: OperationGroup; operation: Operation } | null {
  for (const group of definition.operationGroups) {
    const operation = group.operations.find((op) => op.id === operationId);
    if (operation) return { group, operation };
  }
  return null;
}

/** The definition's `default`-flagged group ids, filtered to the ids a template offers. */
export function defaultCapabilityGroupIds(
  definition: CapabilityDefinition,
  offered: readonly string[],
): string[] {
  return definition.operationGroups
    .filter((g) => g.default && offered.includes(g.id))
    .map((g) => g.id);
}
