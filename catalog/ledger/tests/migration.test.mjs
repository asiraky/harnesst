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
    assert.equal(before.length, 7);
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

test("ticket migration moves default-workflow projects forward without disturbing in-flight items", async () => {
  const url = process.env.LEDGER_DATABASE_URL || "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = "ledger_ticket_upgrade_" + Date.now();
  let db;
  try {
    await admin.unsafe(`create database ${name}`);
    const target = new URL(url); target.pathname = "/" + name;
    db = postgres(target.toString(), { max: 1, onnotice: () => {} });
    const apply = async (file) => db.unsafe(await readFile(new URL("../" + file, import.meta.url), "utf8"));
    await apply("local/roles.sql");
    for (const file of ["0001_ledger.sql", "0003_workflow.sql", "0004_mayi_approvals.sql", "0005_hosted_authorization.sql", "0006_oauth_recovery.sql", "0007_scoped_oauth_writes.sql", "0008_review_content.sql"])
      await apply(file);
    const [{ result: intake }] = await db`select public.ledger_mint_actor('intake','agent','Intake') as result`;
    const call = (op, args) => db`select ledger.call(${op},${intake.actor_key},${db.json(args)}) as result`.then(([r]) => r.result);
    const onDefault = await call("create_project", { slug: "old", name: "Old", repo: "o/old" });
    const inFlight = await call("create_item", { project_id: onDefault.id, kind: "feature", title: "Old", spec: {} });
    const [{ definition: legacy }] = await db`select definition from ledger.workflow_templates where name='default'`;
    await db`insert into ledger.workflow_templates values('custom',${db.json({ ...legacy, human_proxy: "intake", version: 99 })})`;
    const custom = await call("create_project", { slug: "custom", name: "Custom", repo: "o/custom", workflow_template: "custom" });
    await apply("0009_tickets.sql");
    await apply("0009_tickets.sql");
    // Local setup replays every migration; the lease wrapper must survive a replay of 0009.
    await apply("0010_leases.sql");
    await apply("0009_tickets.sql");
    await apply("0010_leases.sql");
    const versions = await db`select project_id,version,active,definition->'kinds' ? 'ticket' as tickets from ledger.workflows order by project_id,version`;
    assert.deepEqual(
      versions.filter((v) => v.project_id === onDefault.id).map(({ version, active, tickets }) => ({ version, active, tickets })),
      [{ version: 1, active: false, tickets: false }, { version: 2, active: true, tickets: true }],
    );
    assert.deepEqual(versions.filter((v) => v.project_id === custom.id).map((v) => v.version), [1]);
    const moved = await call("get_item", { item_id: inFlight.id });
    assert.equal(moved.workflow_version, 1);
    assert.equal(moved.stage, "triage");
    const fresh = await call("create_item", { project_id: onDefault.id, kind: "feature", title: "New", spec: {} });
    assert.equal(fresh.workflow_version, 2);
  } finally {
    if (db) await db.end();
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.end();
  }
});
