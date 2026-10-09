import { test } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { migrationQuery, actorsQuery } from '../../../app/marketplace/supabase-provisioning.server.ts';

test('installer recovers lost responses without repeating migrations or rotating actors', async()=>{
 const url=process.env.LEDGER_DATABASE_URL||'postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger';
 const admin=postgres(url,{max:1,onnotice:()=>{}});const name='installer_'+Date.now();let db;
 try {
  await admin.unsafe(`create database ${name}`);const u=new URL(url);u.pathname='/'+name;db=postgres(u.toString(),{max:1,onnotice:()=>{}});
  const source=await readFile(new URL('../0001_ledger.sql',import.meta.url),'utf8');
  const hash=createHash('sha256').update(source).digest('hex');const query=migrationQuery('team1','0001',hash,source);
  await db.unsafe(query);await db.unsafe(query);
  assert.equal((await db`select count(*) from harnesst_install.migrations`)[0].count,'1');
  await assert.rejects(db.unsafe(migrationQuery('team2','0001',hash,source)),/another team/);await db.unsafe('rollback');
  await assert.rejects(db.unsafe(migrationQuery('team1','0001','different',source)),/checksum/);await db.unsafe('rollback');
  await assert.rejects(db.unsafe(migrationQuery('team1','bad','bad','create table ledger.rollback_test(id int); select nonexistent();')));await db.unsafe('rollback');
  assert.equal((await db`select to_regclass('ledger.rollback_test') as name`)[0].name,null);
  const actors=Object.fromEntries(['intake','infra','implementer','github'].map(role=>[role,{actorKey:'key-'+role,wakeToken:'wake-'+role}]));
  const setup=actorsQuery(actors,"o'brien@example.com");
  await db.unsafe(setup);const before=await db`select role,key_hash,wake_hash from ledger.actors order by role`;await db.unsafe(setup);
  assert.deepEqual(await db`select role,key_hash,wake_hash from ledger.actors order by role`,before);
  const [me]=await db`select public.ledger_whoami('key-intake') as actor`;assert.equal(me.actor.role,'intake');
  actors.intake.actorKey='replacement';await assert.rejects(db.unsafe(actorsQuery(actors,'x@example.com')),/refusing rotation/);await db.unsafe('rollback');
  assert.deepEqual(await db`select role,key_hash,wake_hash from ledger.actors order by role`,before);
 } finally {if(db)await db.end();await admin.unsafe(`drop database if exists ${name}`);await admin.end();}
});
