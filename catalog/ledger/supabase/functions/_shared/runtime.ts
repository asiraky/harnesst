import type { Backend } from "./approvals.ts";
declare const Deno: { env: { get(name: string): string | undefined } };
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing backend configuration: ${name}`);
  return value;
}
export async function rpc(
  name: string,
  operation: string,
  args: Record<string, unknown> = {},
) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_op: operation, p_args: args }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const code =
      typeof body.code === "string" && /^[A-Z0-9]{5,10}$/.test(body.code)
        ? body.code
        : "unknown";

    throw new Error(
      `Approval database operation failed (${response.status}; ${code})`,
    );
  }
  return response.json();
}

export const backend: Backend = (operation, args) =>
  rpc("ledger_approval_backend", operation, args);
