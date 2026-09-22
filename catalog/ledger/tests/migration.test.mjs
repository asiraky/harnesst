import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
test("fresh migration survives Supabase-style direct default grants", async () => {
  const url =
    process.env.LEDGER_DATABASE_URL ||
    "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
  const admin = postgres(url, { max: 1, onnotice: () => {} }),
    name = "ledger_migration_" + Date.now();
  let db;
  try {
    await admin.unsafe(`create database ${name}`);
    const dbUrl = new URL(url);
    dbUrl.pathname = "/" + name;
    db = postgres(dbUrl.toString(), { max: 1, onnotice: () => {} });
    await db.unsafe(await readFile(new URL('../local/roles.sql',import.meta.url),'utf8'));
    await db`alter default privileges in schema public grant execute on functions to anon,authenticated`;
    await db.unsafe(
      await readFile(new URL("../0001_ledger.sql", import.meta.url), "utf8"),
    );
    for (const role of ["anon", "authenticated"])
      for (const query of [
        "select public.ledger_mint_actor('intruder','system','Intruder')",
        "select public.ledger_delivery_batch()",
      ])
        await assert.rejects(
          db.begin(async (tx) => {
            await tx.unsafe("set local role " + role);
            await tx.unsafe(query);
          }),
          /permission denied/,
        );
    const [mint] =
      await db`select public.ledger_mint_actor('intake','agent','Intake') as result`;
    const [me] = await db.begin(async (tx) => {
      await tx`set local role anon`;
      return tx`select public.ledger_whoami(${mint.result.actor_key}) as result`;
    });
    assert.equal(me.result.role, "intake");
    assert.equal(me.result.wake_secret, undefined);
  } finally {
    if (db) await db.end();
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.end();
  }
});

test("hosted initial actor setup refuses a rerun without rotating credentials", async () => {
  const url = process.env.LEDGER_DATABASE_URL || "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = "ledger_actor_setup_" + Date.now();
  let db;
  try {
    await admin.unsafe(`create database ${name}`);
    const target = new URL(url); target.pathname = "/" + name;
    db = postgres(target.toString(), { max: 1, onnotice: () => {} });
    await db.unsafe(await readFile(new URL('../hosted/supabase/migrations/20260917000001_ledger.sql', import.meta.url), 'utf8'));
    const setup = await readFile(new URL('../hosted/supabase/mint-actors.sql', import.meta.url), 'utf8');
    await db.unsafe(setup);
    const before = await db`select role,key_hash,wake_hash from ledger.actors order by role`;
    assert.equal(before.length, 6);
    await assert.rejects(db.unsafe(setup), /Actors already exist/);
    await db.unsafe('rollback');
    const after = await db`select role,key_hash,wake_hash from ledger.actors order by role`;
    assert.deepEqual(after, before);
  } finally {
    if (db) await db.end();
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.end();
  }
});
