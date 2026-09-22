export type LedgerResult = Record<string, any>;
async function request(
  op: string,
  args: Record<string, unknown>,
  wake: boolean = false,
): Promise<any> {
  const url = process.env.LEDGER_URL,
    anon = process.env.LEDGER_ANON_KEY;
  const key = process.env[wake ? "LEDGER_WAKE_TOKEN" : "LEDGER_ACTOR_KEY"];
  if (!url || !anon || !key)
    throw Error(
      "Set LEDGER_URL, LEDGER_ANON_KEY and this member’s actor/wake secrets.",
    );
  const response = await fetch(
    `${url.replace(/\/$/, "")}/rest/v1/rpc/ledger_${op}`,
    {
      method: "POST",
      headers: { apikey: anon, "content-type": "application/json" },
      body: JSON.stringify({ p_key: key, p_args: args }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw Error(result.message ?? `Ledger HTTP ${response.status}`);
  return result;
}
export async function ledgerRpc(
  op: string,
  args: Record<string, unknown> = {},
): Promise<LedgerResult> {
  try {
    if (
      !["claim", "renew_claim"].includes(op) &&
      process.env.EVE_PUBLIC_ORIGIN
    ) {
      const desired =
        process.env.EVE_PUBLIC_ORIGIN.replace(/\/$/, "") +
        "/eve/v1/ledger/wake";
      const me = await request("whoami", {});
      if (me.wake_url !== desired)
        await request("set_wake_url", { url: desired });
    }
    const value = await request(
      op,
      args,
      ["claim", "renew_claim"].includes(op),
    );
    return { ok: true, data: value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
