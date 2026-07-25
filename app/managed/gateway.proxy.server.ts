/**
 * Managed ModelGateway (ARCH §3.2). Instances route model calls through our proxy, which owns
 * provider keys, meters tokens, and enforces per-tenant spend caps + kill-switch. The proxy
 * process itself is infra; this adapter provides the control-plane half: the endpoint
 * instances should use, and the budget check the control plane runs before allowing a turn.
 */
import { getSpendLimit, tokensUsedSince } from "./billing.server";
import type { ModelGateway } from "~/seams/types";

export const managedModelGateway: ModelGateway = {
  name: "managed-proxy",

  async endpointFor(instanceId: string) {
    const base = process.env.HARNESST_MODEL_GATEWAY_URL ?? "";
    // The instance authenticates to the proxy with a per-instance token; the proxy holds the
    // real provider keys. (Token issuance wired with the gateway deployment.)
    const headers: Record<string, string> = base ? { "x-harnesst-instance": instanceId } : {};
    return { baseUrl: base, headers };
  },

  async checkBudget(orgId: string) {
    const limit = await getSpendLimit(orgId);
    if (!limit) return { allowed: true };
    if (limit.killSwitch) {
      return { allowed: false, reason: "Tenant kill-switch is engaged." };
    }
    if (limit.monthlyTokenCap != null) {
      const used = await tokensUsedSince(orgId);
      if (used >= limit.monthlyTokenCap) {
        return {
          allowed: false,
          reason: `Monthly token cap reached (${used}/${limit.monthlyTokenCap}).`,
        };
      }
    }
    return { allowed: true };
  },
};
