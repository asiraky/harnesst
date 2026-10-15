import postgres from "postgres";
export const sql = postgres(
  process.env.LEDGER_DATABASE_URL ||
    "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger",
  { max: 10 },
);
export async function rpc(op, key, args = {}) {
  if (!/^[a-z_]+$/.test(op)) throw Error("Invalid operation");
  return sql.begin(async (tx) => {
    await tx`set local role anon`;
    const [row] =
      await tx`select ${tx("public.ledger_" + op)}(${key}, ${tx.json(args)}::jsonb) as result`;
    return row.result;
  });
}
