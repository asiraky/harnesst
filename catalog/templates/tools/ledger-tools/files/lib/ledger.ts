export type LedgerResult = Record<string, any>;
/** RPCs authenticated by the wake token (the channel's own claim/heartbeat/release). */
const WAKE_OPS = ["claim", "renew_claim", "renew_lease", "release_lease"];
/** The part of eve's tool context the ledger needs: the session that is writing. */
export type LedgerCaller = { session?: { id?: string } } | undefined;
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
/**
 * Tool calls pass their context so every write carries the session id. The ledger lets only the
 * session holding the issue's lease write; others get LEASE_HELD or LEASE_LOST.
 */
export async function ledgerRpc(
  op: string,
  args: Record<string, unknown> = {},
  caller?: LedgerCaller,
): Promise<LedgerResult> {
  const sessionId = caller?.session?.id;
  if (sessionId && args.session_id === undefined)
    args = { ...args, session_id: sessionId };
  try {
    if (!WAKE_OPS.includes(op) && process.env.EVE_PUBLIC_ORIGIN) {
      const desired =
        process.env.EVE_PUBLIC_ORIGIN.replace(/\/$/, "") +
        "/eve/v1/ledger/wake";
      const me = await request("whoami", {});
      if (me.wake_url !== desired)
        await request("set_wake_url", { url: desired });
    }
    const value = await request(op, args, WAKE_OPS.includes(op));
    return { ok: true, data: value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("LEASE_"))
      return { ok: false, error: message, stop: leaseStop(message) };
    return { ok: false, error: message };
  }
}

/** Lease refusals are final for this session; say so in a field the model cannot misread. */
function leaseStop(message: string): string {
  if (message.startsWith("LEASE_LOST"))
    return "Another session now owns this issue. Stop all work on it: no pushes, PR edits or ledger writes. End your turn.";
  if (message.startsWith("LEASE_HELD"))
    return "Another session is working on this issue. Do not change it or push to its branch. End your turn; the ledger wakes you when it is free.";
  return "This ledger write was refused. Do not retry it.";
}
