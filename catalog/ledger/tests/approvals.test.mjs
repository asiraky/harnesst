import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFile } from "node:fs/promises";

const MIGRATIONS = [
  "0001_ledger.sql",
  "0003_workflow.sql",
  "0004_mayi_approvals.sql",
  "0005_hosted_authorization.sql",
  "0006_oauth_recovery.sql",
  "0007_scoped_oauth_writes.sql",
  "0008_review_content.sql",
  "0009_tickets.sql",
  "0010_leases.sql",
  "0011_harnesst_approvals.sql",
];
const url =
  process.env.LEDGER_DATABASE_URL ||
  "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
const approvalsKey = "harnesst-approvals-key";
let admin, db, project;
const actors = {};
const names = [];

async function freshDatabase(prefix) {
  const name = prefix + Date.now() + Math.floor(Math.random() * 1000);
  names.push(name);
  await admin.unsafe(`create database ${name}`);
  const target = new URL(url);
  target.pathname = "/" + name;
  const conn = postgres(target.toString(), { max: 10, onnotice: () => {} });
  await conn.unsafe(
    await readFile(new URL("../local/roles.sql", import.meta.url), "utf8"),
  );
  await conn`alter default privileges in schema public grant execute on functions to anon,authenticated`;
  return conn;
}
async function migrate(conn, files) {
  const reserved = await conn.reserve();
  try {
    for (const file of files)
      await reserved.unsafe(
        await readFile(new URL("../" + file, import.meta.url), "utf8"),
      );
  } finally {
    reserved.release();
  }
}
async function mintTeam(conn) {
  const team = {};
  for (const [role, kind] of [
    ["intake", "agent"],
    ["implementer", "agent"],
    ["github", "system"],
    ["engineer", "human"],
    ["requester", "human"],
  ]) {
    const [r] =
      await conn`select public.ledger_mint_actor(${role},${kind},${role}) as result`;
    team[role] = r.result;
  }
  const workflow = JSON.parse(
    await readFile(new URL("../workflow.json", import.meta.url), "utf8"),
  );
  await conn`insert into ledger.workflow_templates values('default',${conn.json(workflow)}) on conflict(name) do update set definition=excluded.definition`;
  return team;
}
const asAnon = (conn, fn) =>
  conn.begin(async (tx) => {
    await tx`set local role anon`;
    return fn(tx);
  });
const agentOn = (conn, team) => async (role, op, args = {}) => {
  const [row] = await asAnon(
    conn,
    (tx) =>
      tx`select ${tx("public.ledger_" + op)}(${team[role].actor_key},${tx.json({ session_id: "test-" + role, ...args })}) as result`,
  );
  return row.result;
};
const approvalsOn = (conn) => async (op, args = {}, key = approvalsKey) => {
  const [row] = await asAnon(
    conn,
    (tx) =>
      tx`select public.ledger_approvals(${key},${op},${tx.json(args)}) as result`,
  );
  return row.result;
};
let agent, approvals;
const step = (role, op, item, args = {}) =>
  agent(role, op, { item_id: item.id, expected_version: item.version, ...args });

// Carries a new feature through its single ticket, QA and review to the merge-approval gate.
async function gatedOn(run, proj, head = "a".repeat(40)) {
  const go = (role, op, item, args = {}) =>
    run(role, op, { item_id: item.id, expected_version: item.version, ...args });
  let item = await run("intake", "create_item", {
    project_id: proj.id,
    kind: "feature",
    title: "Approval test",
    spec: { problem: "Test" },
  });
  item = await go("intake", "transition", item, { to_stage: "breakdown" });
  let ticket = await run("intake", "create_item", {
    project_id: proj.id,
    kind: "ticket",
    title: "Only slice",
    spec: { body: "Slice" },
    parent_id: item.id,
  });
  item = await go(
    "intake",
    "transition",
    await run("intake", "get_item", { item_id: item.id }),
    { to_stage: "build" },
  );
  ticket = await go("github", "set_head", ticket, {
    head_sha: "c".repeat(40),
    observed_at: new Date().toISOString(),
  });
  await go("github", "transition", ticket, {
    to_stage: "merged",
    binding: ticket.head_sha,
  });
  item = await run("intake", "get_item", { item_id: item.id });
  item = await go("implementer", "set_head", item, {
    head_sha: head,
    observed_at: new Date().toISOString(),
  });
  item = await go("implementer", "attach", item, {
    type: "pr",
    value: "https://example.test/pr/" + item.id,
  });
  item = await go("implementer", "attach", item, {
    type: "preview_url",
    value: "https://example.test/preview/" + head,
    binding: head,
  });
  item = await go("implementer", "transition", item, { to_stage: "qa" });
  item = await go("implementer", "evidence", item, {
    type: "qa_passed",
    binding: head,
    payload: {},
  });
  item = await go("implementer", "transition", item, { to_stage: "review" });
  item = await go("implementer", "evidence", item, {
    type: "review_approved",
    binding: head,
    payload: {},
  });
  return go("implementer", "transition", item, { to_stage: "merge-approval" });
}
async function gate() {
  const item = await gatedOn(agent, project);
  const open = await approvals("list");
  const request = open.find((r) => r.item_id === item.id);
  return { item, request };
}
const intakeWakes = async (item) =>
  (
    await db`select count(*)::int as n from ledger.outbox where item_id=${item.id} and actor_id=${actors.intake.actor_id} and status='pending'`
  )[0].n;

before(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  db = await freshDatabase("ledger_approvals_");
  await migrate(db, MIGRATIONS);
  Object.assign(actors, await mintTeam(db));
  await db`insert into ledger.approval_access(key_hash) values(ledger.hash(${approvalsKey}))`;
  agent = agentOn(db, actors);
  approvals = approvalsOn(db);
  project = await agent("intake", "create_project", {
    slug: "test",
    name: "Test",
    repo: "test/test",
  });
});
after(async () => {
  if (db) await db.end();
  if (admin) {
    for (const name of names)
      await admin.unsafe(`drop database if exists ${name}`);
    await admin.end();
  }
});

test("only the approvals key reaches the approvals API; agents cannot decide gates", async () => {
  const { item, request } = await gate();
  for (const key of [actors.intake.actor_key, actors.engineer.actor_key, "guess", null])
    await assert.rejects(approvals("list", {}, key), /forbidden/);
  await assert.rejects(
    approvals("resolve", { id: request.id, decision: "approve", approver_id: "u" }, actors.engineer.actor_key),
    /forbidden/,
  );
  for (const role of ["anon", "authenticated"])
    for (const q of [
      "select * from ledger.approval_access",
      "select * from ledger.approval_requests",
      "select public.ledger_approval_backend('resolve','{}')",
    ])
      await assert.rejects(
        db.begin(async (tx) => {
          await tx.unsafe("set local role " + role);
          await tx.unsafe(q);
        }),
        /permission denied|does not exist/,
      );
  await assert.rejects(
    step("intake", "transition", item, { to_stage: "ready-to-merge" }),
    /gate stage/,
  );
});

test("a new gate is listed with its snapshot; publishing it wakes the proxy once with the link", async () => {
  const { item, request } = await gate();
  assert.equal(request.status, "pending");
  assert.equal(request.binding, "a".repeat(40));
  assert.equal(request.project.repo, "test/test");
  assert.equal(request.action.input.approve_to, "ready-to-merge");
  assert.equal(request.action.input.approver_role, "engineer");
  assert.equal(await intakeWakes(item), 0);
  const url = "https://harnesst.example.test/approvals/abc123";
  const published = await approvals("publish", { id: request.id, review_url: url });
  assert.equal(published.status, "submitted");
  assert.equal(await intakeWakes(item), 1);
  await approvals("publish", { id: request.id, review_url: url });
  assert.equal(await intakeWakes(item), 1);
  const seen = await agent("intake", "get_item", { item_id: item.id });
  assert.equal(seen.approval.review_url, url);
  assert.equal(seen.approval.approval_id, request.id);
  await assert.rejects(
    approvals("publish", { id: request.id, review_url: "javascript:alert(1)" }),
    /review URL required/,
  );
});

test("approval advances the gate once and records who decided", async () => {
  const { item, request } = await gate();
  const decided = await approvals("resolve", {
    id: request.id,
    decision: "approve",
    approver_id: "user-1",
    approver_name: "Dev One",
  });
  assert.equal(decided.outcome, "decided");
  assert.equal(decided.item_stage, "ready-to-merge");
  assert.equal(decided.decision.approver_name, "Dev One");
  const again = await approvals("resolve", {
    id: request.id,
    decision: "reject",
    approver_id: "user-2",
  });
  assert.equal(again.outcome, "already_decided");
  assert.equal(again.status, "approved");
  const gates = await db`select via,decision from ledger.gates where item_id=${item.id}`;
  assert.deepEqual(gates.map((g) => ({ ...g })), [{ via: "harnesst", decision: "approve" }]);
  assert.equal((await agent("intake", "get_item", { item_id: item.id })).stage, "ready-to-merge");
});

test("rejection returns the work to build with the reviewer's feedback", async () => {
  const { item, request } = await gate();
  const decided = await approvals("resolve", {
    id: request.id,
    decision: "reject",
    approver_id: "user-1",
    feedback: "Use the shared button styles",
  });
  assert.equal(decided.status, "denied");
  assert.equal(decided.item_stage, "build");
  const [g] = await db`select decision,feedback from ledger.gates where item_id=${item.id}`;
  assert.equal(g.decision, "reject");
  assert.equal(g.feedback, "Use the shared button styles");
});

test("a decision needs an approver and a valid verdict", async () => {
  const { request } = await gate();
  await assert.rejects(approvals("resolve", { id: request.id, decision: "approve" }), /approver required/);
  await assert.rejects(
    approvals("resolve", { id: request.id, decision: "maybe", approver_id: "u" }),
    /invalid decision/,
  );
  await assert.rejects(
    approvals("resolve", { id: "00000000-0000-0000-0000-000000000000", decision: "approve", approver_id: "u" }),
    /approval not found/,
  );
});

test("a new head at the gate retires the old request; deciding it changes nothing", async () => {
  const { item, request } = await gate();
  await step("implementer", "set_head", item, {
    head_sha: "b".repeat(40),
    observed_at: new Date().toISOString(),
  });
  const result = await approvals("resolve", { id: request.id, decision: "approve", approver_id: "u" });
  assert.equal(result.outcome, "closed");
  assert.equal(result.status, "superseded");
  assert.notEqual((await agent("intake", "get_item", { item_id: item.id })).stage, "ready-to-merge");
  const [g] = await db`select count(*)::int as n from ledger.gates where item_id=${item.id}`;
  assert.equal(g.n, 0);
});

test("a blocked gate cannot be decided until the block is resolved", async () => {
  const { item, request } = await gate();
  await step("intake", "block", item, { role: "engineer", question: "Which colour?" });
  const blocked = await approvals("resolve", { id: request.id, decision: "approve", approver_id: "u" });
  assert.equal(blocked.outcome, "closed");
  assert.equal(blocked.status, "superseded");
  const reopened = await agent("intake", "get_item", { item_id: item.id });
  await step("intake", "resolve_block", reopened, { answer: "Blue" });
  const fresh = (await approvals("list")).find((r) => r.item_id === item.id);
  assert.notEqual(fresh.id, request.id);
  const decided = await approvals("resolve", { id: fresh.id, decision: "approve", approver_id: "u" });
  assert.equal(decided.item_stage, "ready-to-merge");
});

test("an unanswered request expires, wakes the proxy and can no longer be decided", async () => {
  const { item, request } = await gate();
  await approvals("publish", { id: request.id, review_url: "https://h.example.test/approvals/x" });
  await db`update ledger.outbox set status='done' where item_id=${item.id}`;
  await db`update ledger.approval_requests set expires_at=now()-interval '1 minute' where id=${request.id}`;
  const listed = await approvals("list", { ids: [request.id] });
  assert.equal(listed.find((r) => r.id === request.id).status, "expired");
  assert.equal(await intakeWakes(item), 1);
  const result = await approvals("resolve", { id: request.id, decision: "approve", approver_id: "u" });
  assert.equal(result.outcome, "closed");
  assert.equal((await agent("intake", "get_item", { item_id: item.id })).stage, "merge-approval");
});

test("list returns open requests plus any requested by id, so closed ones can be reconciled", async () => {
  const { request } = await gate();
  await approvals("resolve", { id: request.id, decision: "approve", approver_id: "u" });
  assert.equal((await approvals("list")).some((r) => r.id === request.id), false);
  const [again] = await approvals("list", { ids: [request.id] }).then((rows) =>
    rows.filter((r) => r.id === request.id),
  );
  assert.equal(again.status, "approved");
  assert.equal(again.decision.approver_id, "u");
});

test("concurrent decisions on one request apply exactly one", async () => {
  const { item, request } = await gate();
  const results = await Promise.all([
    approvals("resolve", { id: request.id, decision: "approve", approver_id: "a" }),
    approvals("resolve", { id: request.id, decision: "reject", approver_id: "b" }),
  ]);
  assert.equal(results.filter((r) => r.outcome === "decided").length, 1);
  const [g] = await db`select count(*)::int as n from ledger.gates where item_id=${item.id}`;
  assert.equal(g.n, 1);
});

test("upgrading retires May I and reissues a waiting gate for harnesst", async () => {
  const old = await freshDatabase("ledger_approvals_upgrade_");
  await migrate(old, MIGRATIONS.slice(0, -1));
  const team = await mintTeam(old);
  const run = agentOn(old, team);
  const proj = await run("intake", "create_project", { slug: "up", name: "Up", repo: "t/up" });
  const item = await gatedOn(run, proj);
  const [before] = await old`select id,epoch,status from ledger.approval_requests where item_id=${item.id}`;
  await old`update ledger.approval_requests set status='submitted',remote_id='MayI123',review_url='https://app.mayi.sh/?approval=MayI123' where id=${before.id}`;
  await migrate(old, MIGRATIONS.slice(-1));
  const requests = await old`select id,epoch,status,review_url from ledger.approval_requests where item_id=${item.id} order by epoch`;
  assert.deepEqual(
    requests.map((r) => [r.epoch, r.status]),
    [[before.epoch, "superseded"], [before.epoch + 1, "pending"]],
  );
  for (const relation of ["ledger.approval_config", "ledger.oauth_attempts"])
    assert.equal((await old`select to_regclass(${relation}) as r`)[0].r, null);
  assert.equal(
    (await old`select to_regprocedure('public.ledger_approval_backend(text,jsonb)') as p`)[0].p,
    null,
  );
  await old.end();
});
