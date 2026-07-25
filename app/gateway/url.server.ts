/**
 * The base URL a deployed agent / the assistant uses to reach harnesst's model gateway (issue #28).
 *
 * A container talks back to the control plane over `host.docker.internal`; the port mirrors the
 * HARNESST_TEAM_URL / HARNESST_API_URL derivation (PORT, else 3000 in production and 5173 in dev). An
 * operator can override the whole thing with `HARNESST_MODEL_GATEWAY_URL` (e.g. a public control-plane
 * origin). The returned URL is the OpenAI-compatible base — the agent's provider appends
 * `/chat/completions`.
 */
export function gatewayBaseUrl(): string {
  const override = process.env.HARNESST_MODEL_GATEWAY_URL?.trim();
  if (override) return override;
  const port =
    process.env.PORT ?? (process.env.NODE_ENV === "production" ? "3000" : "5173");
  return `http://host.docker.internal:${port}/api/gateway/v1`;
}
