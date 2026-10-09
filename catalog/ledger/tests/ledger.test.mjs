import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
const url =
  process.env.LEDGER_DATABASE_URL ||
  "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
const admin = postgres(url, { max: 1, onnotice: () => {} }),
  databaseName = "ledger_behaviour_" + Date.now();
await admin.unsafe(`create database ${databaseName}`);
const target = new URL(url);
target.pathname = "/" + databaseName;
const sql = postgres(target.toString(), { max: 10, onnotice: () => {} });
const connection = await sql.reserve();
try {
  await connection.unsafe(
    await readFile(new URL("../local/roles.sql", import.meta.url), "utf8"),
  );
  for (const file of ["0001_ledger.sql", "0004_mayi_approvals.sql", "0005_hosted_authorization.sql", "0006_oauth_recovery.sql", "0007_scoped_oauth_writes.sql", "0008_review_content.sql", "0009_tickets.sql", "0010_leases.sql"])
    await connection.unsafe(
      await readFile(new URL("../" + file, import.meta.url), "utf8"),
    );
} finally {
  connection.release();
}
const actors = {};
for (const [role, kind] of [
  ["intake", "agent"],
  ["infra", "agent"],
  ["implementer", "agent"],
  ["architect", "agent"],
  ["github", "system"],
  ["engineer", "human"],
  ["requester", "human"],
]) {
  const [r] =
    await sql`select public.ledger_mint_actor(${role},${kind},${role},${role + "@example.test"}) as result`;
  actors[role] = r.result;
}
const rpc = async (op, key, args = {}) =>
  sql.begin(async (tx) => {
    await tx`set local role anon`;
    const [r] =
      await tx`select ${tx("public.ledger_" + op)}(${key},${tx.json(args)}) as result`;
    return r.result;
  });
const workflow = JSON.parse(
  await readFile(new URL("../workflow.json", import.meta.url)),
);
const testTemplate = `test-${Date.now()}`;
await sql`insert into ledger.workflow_templates(name,definition) values(${testTemplate},${sql.json(workflow)})`;
const project = await rpc("create_project", actors.intake.actor_key, {
  slug: `tests-${Date.now()}`,
  name: "Behavior tests",
  repo: "local/tests",
  workflow_template: testTemplate,
});
// Each role writes from one long-lived session unless a test says otherwise.
const call = (role, op, args) =>
  rpc(op, actors[role].actor_key, { session_id: "test-" + role, ...args });
const create = (
  kind = "feature",
  spec = { problem: "Test", acceptance_criteria: ["Works"] },
) =>
  call("intake", "create_item", {
    project_id: project.id,
    kind,
    title: "Behavior test",
    spec,
  });
const change = (role, op, i, args = {}) =>
  call(role, op, {
    item_id: i.id,
    expected_version: i.version,
    ...(role === "github" ? { binding: i.head_sha } : {}),
    ...args,
  });
const get = (i, role = "intake") => call(role, "get_item", { item_id: i.id });
const sha = "a".repeat(40),
  later = "b".repeat(40);
const addTicket = (parent, args = {}) =>
  call("intake", "create_item", {
    project_id: project.id,
    kind: "ticket",
    title: "Ticket",
    spec: { body: "Slice" },
    parent_id: parent.id,
    ...args,
  });
// GitHub closes a ticket when its PR merges into the issue branch.
async function mergeTicket(t, head = "c".repeat(40)) {
  t = await change("github", "set_head", t, {
    head_sha: head,
    observed_at: new Date().toISOString(),
  });
  return change("github", "transition", t, { to_stage: "merged" });
}
async function toBuild(i) {
  i ??= await create();
  i = await change("intake", "transition", i, { to_stage: "breakdown" });
  await addTicket(i);
  return change("intake", "transition", await get(i), { to_stage: "build" });
}
async function built() {
  let i = await toBuild();
  for (const t of await call("intake", "list_items", { parent_id: i.id }))
    await mergeTicket(t);
  i = await get(i);
  i = await change("implementer", "set_head", i, {
    head_sha: sha,
    observed_at: "2026-09-16T01:00:00Z",
  });
  i = await change("implementer", "attach", i, {
    type: "pr",
    value: "https://example.test/pr/" + i.id,
  });
  i = await change("implementer", "attach", i, {
    type: "preview_url",
    value: "https://example.test/preview",
    binding: sha,
  });
  return change("implementer", "transition", i, { to_stage: "qa" });
}
async function reviewing() {
  let i = await built();
  i = await change("implementer", "evidence", i, {
    type: "qa_passed",
    binding: sha,
    payload: { result: "pass" },
  });
  return change("implementer", "transition", i, { to_stage: "review" });
}
async function gated() {
  let i = await reviewing();
  i = await change("implementer", "evidence", i, {
    type: "review_approved",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "transition", i, {
    to_stage: "merge-approval",
  });
  return get(i);
}
// Test harness simulates the already verified Edge Function. Agents cannot use this role.
async function gate(descriptor, args = {}) {
  const [r] =
    await sql`select * from ledger.approval_requests where item_id=${descriptor.id} and epoch=${descriptor.epoch}`;
  const current = await get(descriptor);
  if (r.status === "superseded" || current.gate_epoch !== r.epoch)
    throw new Error("stale_binding");
  if (!args.decision) return current;
  await sql.begin(async (tx) => {
    await tx`set local role service_role`;
    await tx`select public.ledger_approval_backend('resolve',${tx.json({ review_protocol: 2, state: r.callback_state, event_id: r.id, approval_id: r.id, status: args.decision === "approve" ? "approved" : "denied", approver_id: "HumanUserAbc", expires_at: new Date(Date.now() + 86400000).toISOString(), occurred_at: new Date().toISOString() })})`;
  });
  return get(descriptor);
}
const token = (i) => ({ id: i.id, epoch: i.gate_epoch });
after(async () => {
  await sql.end();
  await admin.unsafe(`drop database ${databaseName}`);
  await admin.end();
});
test("actor keys cannot read tables, mint credentials or dispatch wakes", async () => {
  await assert.rejects(rpc("whoami", "bad"), /unauthorized/);
  for (const query of [
    "select * from ledger.actors",
    "select public.ledger_mint_actor('intruder','system','Bad')",
    "select public.ledger_delivery_batch()",
  ])
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`set local role anon`;
        await tx.unsafe(query);
      }),
      /permission denied/,
    );
  await assert.rejects(
    call("github", "create_item", {
      project_id: project.id,
      kind: "feature",
      title: "Bad",
      spec: {},
    }),
    /forbidden/,
  );
});
test("only owner transitions; concurrent writes have one winner", async () => {
  const i = await create();
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "breakdown" }),
    /forbidden/,
  );
  const results = await Promise.allSettled([
    change("intake", "transition", i, { to_stage: "breakdown" }),
    change("intake", "transition", i, { to_stage: "infra" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /stale/,
  );
});
test("QA failure can return to build; passing evidence is required for review", async () => {
  let i = await built();
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "review" }),
    /qa_passed missing/,
  );
  await assert.rejects(
    change("intake", "evidence", i, {
      type: "qa_passed",
      binding: sha,
      payload: {},
    }),
    /forbidden/,
  );
  i = await change("implementer", "evidence", i, {
    type: "qa_failed",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "transition", i, { to_stage: "build" });
  assert.equal(i.stage, "build");
});
test("full feature path requires the merge approval and merge confirmation", async () => {
  let i = await gated();
  await assert.rejects(
    change("github", "transition", i, { to_stage: "ready-to-merge" }),
    /gate stage/,
  );
  const t = token(i);
  assert.equal((await gate(t)).stage, "merge-approval");
  await gate(t, { decision: "approve" });
  i = await get(i);
  assert.equal(i.stage, "ready-to-merge");
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "merged" }),
    /forbidden/,
  );
  i = await change("github", "transition", i, { to_stage: "merged" });
  await assert.rejects(
    change("github", "transition", i, { to_stage: "deployed" }),
    /deployment artifact missing/,
  );
  i = await change("github", "attach", i, {
    type: "deployment",
    value: "https://example.test",
    binding: sha,
  });
  i = await change("github", "transition", i, { to_stage: "deployed" });
  assert.ok(i.closed_at);
});
test("new heads reset review and invalidate approvals, evidence and preview artifacts; old events do not regress", async () => {
  let i = await gated();
  const t = token(i);
  i = await change("github", "set_head", i, {
    head_sha: later,
    observed_at: "2026-09-16T02:00:00Z",
  });
  assert.equal(i.stage, "qa");
  await assert.rejects(gate(t, { decision: "approve" }), /expired|binding/);
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "review" }),
    /qa_passed missing/,
  );
  const stale = await change("github", "set_head", i, {
    head_sha: sha,
    observed_at: "2026-09-16T01:00:00Z",
  });
  assert.equal(stale.head_sha, later);
  await assert.rejects(
    change("github", "attach", i, {
      type: "preview_url",
      value: "https://example.test",
      binding: sha,
    }),
    /stale_binding/,
  );
});
test("block survives without stage change and only proxy resolves", async () => {
  let i = await toBuild();
  i = await change("implementer", "block", i, {
    role: "engineer",
    question: "Which color?",
  });
  assert.equal(i.stage, "build");
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "qa" }),
    /blocked/,
  );
  await assert.rejects(
    change("implementer", "resolve_block", i, { answer: "Blue" }),
    /forbidden/,
  );
  i = await change("intake", "resolve_block", i, { answer: "Blue" });
  assert.equal(i.blocked_on, null);
  const wakes =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].actor_id, actors.implementer.actor_id);
});
test("claims authenticate separate bearer and reject duplicate concurrent delivery", async () => {
  const i = await toBuild();
  const [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  await assert.rejects(
    rpc("claim", actors.implementer.actor_key, { outbox_id: o.id }),
    /unauthorized/,
  );
  assert.deepEqual(
    await rpc("claim", actors.infra.wake_token, { outbox_id: o.id }),
    { gone: true },
  );
  const results = await Promise.all([
    rpc("claim", actors.implementer.wake_token, { outbox_id: o.id }),
    rpc("claim", actors.implementer.wake_token, { outbox_id: o.id }),
  ]);
  assert.equal(results.filter((x) => x.item).length, 1);
  assert.equal(results.filter((x) => x.already_claimed).length, 1);
  await sql`update ledger.outbox set lease_until=now()-interval '1 second' where id=${o.id}`;
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where outbox_id=${o.id}`;
  assert.ok(
    (await rpc("claim", actors.implementer.wake_token, { outbox_id: o.id }))
      .item,
  );
});
test("duplicate PR refused and stale evidence binding rejected", async () => {
  const i = await built();
  await assert.rejects(
    change("implementer", "attach", i, {
      type: "pr",
      value: "https://example.test/second",
    }),
    /duplicate/,
  );
  await assert.rejects(
    change("implementer", "evidence", i, {
      type: "qa_passed",
      binding: later,
      payload: {},
    }),
    /stale_binding/,
  );
});
test("delivery attempts terminate with one nonrecursive escalation", async () => {
  const i = await toBuild();
  await sql`update ledger.outbox set attempts=10,status='pending',next_attempt_at=now()-interval '1 second' where item_id=${i.id}`;
  await sql`select public.ledger_delivery_batch()`;
  const es =
    await sql`select * from ledger.outbox where item_id=${i.id} and kind='escalation'`;
  assert.equal(es.length, 1);
  await sql`update ledger.outbox set attempts=10,next_attempt_at=now()-interval '1 second' where id=${es[0].id}`;
  await sql`select public.ledger_delivery_batch()`;
  const rows = await sql`select * from ledger.outbox where item_id=${i.id}`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.status === "failed"));
});
test("non-proxy actors cannot block a human gate", async () => {
  const i = await gated();
  for (const role of ["implementer", "github", "infra"])
    await assert.rejects(
      change(role, "block", i, {
        role: "engineer",
        question: "Bypass approval",
      }),
      /forbidden block/,
    );
});
test("failed evidence supersedes an earlier pass for the same code", async () => {
  let i = await built();
  i = await change("implementer", "evidence", i, {
    type: "qa_passed",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "evidence", i, {
    type: "qa_failed",
    binding: sha,
    payload: {},
  });
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "review" }),
    /qa_passed missing/,
  );
});
test("a gate may be rejected then revisited on the same SHA with a fresh decision", async () => {
  let i = await gated();
  await gate(token(i), { decision: "reject" });
  i = await get(i);
  assert.equal(i.stage, "build");
  i = await change("implementer", "transition", i, { to_stage: "qa" });
  i = await change("implementer", "evidence", i, {
    type: "qa_passed",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "transition", i, { to_stage: "review" });
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "merge-approval" }),
    /review_approved missing/,
  );
  i = await change("implementer", "evidence", i, {
    type: "review_approved",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "transition", i, {
    to_stage: "merge-approval",
  });
  i = await get(i);
  await gate(token(i), { decision: "approve" });
  assert.equal((await get(i)).stage, "ready-to-merge");
});
test("notifications can be acknowledged; ordinary work cannot be silently completed", async () => {
  let i = await create("infra");
  i = await change("intake", "transition", i, { to_stage: "infra" });
  let [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  const infraClaim = await rpc("claim", actors.infra.wake_token, { outbox_id: o.id });
  await rpc("renew_lease", actors.infra.wake_token, {
    lease_token: infraClaim.lease_token,
    session_id: "test-infra",
  });
  await assert.rejects(
    call("infra", "complete_wake", { outbox_id: o.id, note: "Skip work" }),
    /work wakes complete/,
  );
  i = await change("infra", "evidence", i, {
    type: "infra_provisioned",
    binding: String(i.spec_version),
    payload: {},
  });
  i = await change("infra", "transition", i, { to_stage: "done" });
  assert.equal(i.stage, "done");
  [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where scope_id=${i.id} and actor_id=${actors.intake.actor_id}`;
  await rpc("claim", actors.intake.wake_token, { outbox_id: o.id });
  await call("intake", "complete_wake", {
    outbox_id: o.id,
    note: "Told requester",
  });
  const [done] = await sql`select status from ledger.outbox where id=${o.id}`;
  assert.equal(done.status, "done");
});
test("unresolved questions keep a spec in triage until intake resolves them", async () => {
  let i = await create("feature", {
    problem: "Ambiguous",
    acceptance_criteria: [],
    open_questions: ["Which user?"],
  });
  assert.deepEqual(i.allowed_actions.transitions, []);
  await assert.rejects(
    change("intake", "transition", i, { to_stage: "breakdown" }),
    /unresolved spec questions/,
  );
  i = await change("intake", "update_spec", i, {
    spec: {
      problem: "Known user",
      acceptance_criteria: ["Works for requester"],
      open_questions: [],
    },
    note: "Requester clarified",
  });
  assert.ok(i.allowed_actions.transitions.includes("breakdown"));
});
test("intake cannot install merge policy or duplicate a repository", async () => {
  const malicious = {
    ...workflow,
    artifacts: { by: ["intake"] },
    kinds: {
      feature: {
        stages: [{ id: "ready-to-merge", owner: "intake", next: {} }],
      },
    },
  };
  await assert.rejects(
    call("intake", "create_project", {
      slug: "malicious",
      name: "Malicious",
      repo: project.repo,
      workflow: malicious,
    }),
    /operator approval/,
  );
  await assert.rejects(
    call("intake", "create_project", {
      slug: "duplicate",
      name: "Duplicate",
      repo: project.repo,
      workflow_template: testTemplate,
    }),
    /duplicate key/,
  );
  await assert.rejects(
    call("intake", "create_project", {
      slug: "unknown",
      name: "Unknown",
      repo: "local/unknown",
      workflow_template: "unapproved",
    }),
    /operator-approved/,
  );
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`set local role anon`;
      await tx`insert into ledger.workflow_templates(name,definition) values('malicious',${tx.json(malicious)})`;
    }),
    /permission denied/,
  );
});
test("gate entry defers the proxy wake until a review URL exists", async () => {
  const i = await gated();
  const rows =
    await sql`select * from ledger.outbox where item_id=${i.id} and actor_id=${actors.intake.actor_id} and status in ('pending','claimed')`;
  assert.equal(rows.length, 0);
});
test("blocking a gate keeps its pending approval", async () => {
  let i = await gated();
  i = await change("intake", "block", i, {
    role: "engineer",
    question: "Clarify requirement",
  });
  await assert.rejects(
    change("intake", "update_spec", i, { spec: i.spec, note: "Bypass block" }),
    /blocked/,
  );
  i = await change("intake", "resolve_block", i, { answer: "Keep the scope" });
  assert.equal(i.approval.status, "pending");
  assert.equal(i.stage, "merge-approval");
});
test("live heartbeats extend the lease; old claimants cannot renew a replacement", async () => {
  const i = await toBuild();
  const [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  const claim = await rpc("claim", actors.implementer.wake_token, {
    outbox_id: o.id,
  });
  await sql`update ledger.outbox set lease_until=now()+interval '1 second' where id=${o.id}`;
  assert.deepEqual(
    await rpc("renew_claim", actors.implementer.wake_token, {
      outbox_id: o.id,
      claim_token: claim.claim_token,
    }),
    { renewed: true },
  );
  const [active] =
    await sql`select lease_until>now()+interval '29 minutes' as renewed from ledger.outbox where id=${o.id}`;
  assert.ok(active.renewed);
  await assert.rejects(
    rpc("renew_claim", actors.implementer.actor_key, {
      outbox_id: o.id,
      claim_token: claim.claim_token,
    }),
    /unauthorized/,
  );
  assert.deepEqual(
    await rpc("renew_claim", actors.infra.wake_token, {
      outbox_id: o.id,
      claim_token: claim.claim_token,
    }),
    { renewed: false },
  );
  await sql`update ledger.outbox set lease_until=now()-interval '1 second' where id=${o.id}`;
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where token=${claim.lease_token}`;
  assert.deepEqual(
    await rpc("renew_claim", actors.implementer.wake_token, {
      outbox_id: o.id,
      claim_token: claim.claim_token,
    }),
    { renewed: false },
  );
  const next = await rpc("claim", actors.implementer.wake_token, {
    outbox_id: o.id,
  });
  assert.notEqual(next.claim_token, claim.claim_token);
  assert.deepEqual(
    await rpc("renew_claim", actors.implementer.wake_token, {
      outbox_id: o.id,
      claim_token: claim.claim_token,
    }),
    { renewed: false },
  );
});
test("future head timestamps cannot freeze GitHub updates", async () => {
  let i = await built();
  await assert.rejects(
    change("implementer", "set_head", i, {
      head_sha: later,
      observed_at: new Date(Date.now() + 86400000).toISOString(),
    }),
    /in the future/,
  );
  i = await change("github", "set_head", i, {
    head_sha: later,
    observed_at: new Date().toISOString(),
  });
  assert.equal(i.head_sha, later);
});
test("missing projects return a specific error", async () => {
  await assert.rejects(
    call("intake", "get_project", {
      project_id: "00000000-0000-0000-0000-000000000000",
    }),
    /project not found/,
  );
});
test("breakdown needs a ticket and build cannot hand to QA while tickets are open", async () => {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "breakdown" });
  assert.deepEqual(i.allowed_actions.transitions, []);
  await assert.rejects(
    change("intake", "transition", i, { to_stage: "build" }),
    /no tickets created/,
  );
  const first = await addTicket(i);
  const second = await addTicket(i, { blocked_by: [first.id] });
  assert.deepEqual(second.blocked_by, [first.id]);
  assert.deepEqual(
    (await call("implementer", "list_items", { parent_id: i.id }))
      .map((t) => t.id)
      .sort(),
    [first.id, second.id].sort(),
  );
  i = await change("intake", "transition", await get(i), { to_stage: "build" });
  i = await change("implementer", "set_head", i, {
    head_sha: sha,
    observed_at: new Date().toISOString(),
  });
  i = await change("implementer", "attach", i, {
    type: "pr",
    value: "https://example.test/pr/" + i.id,
  });
  i = await change("implementer", "attach", i, {
    type: "preview_url",
    value: "https://example.test/preview",
    binding: sha,
  });
  await mergeTicket(first);
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "qa" }),
    /open tickets remain/,
  );
  await mergeTicket(second);
  i = await change("implementer", "transition", i, { to_stage: "qa" });
  assert.equal(i.stage, "qa");
});
test("tickets hang off an open feature or bug in breakdown and are blocked only by siblings", async () => {
  const early = await create();
  await assert.rejects(addTicket(early), /while the parent is in breakdown/);
  const infra = await create("infra");
  await assert.rejects(addTicket(infra), /must be a feature or bug/);
  let a = await create();
  a = await change("intake", "transition", a, { to_stage: "breakdown" });
  let b = await create("bug");
  b = await change("intake", "transition", b, { to_stage: "breakdown" });
  const ta = await addTicket(a);
  await assert.rejects(addTicket(ta), /must be a feature or bug/);
  await assert.rejects(
    addTicket(b, { blocked_by: [ta.id] }),
    /sibling tickets/,
  );
  await assert.rejects(
    addTicket(b, { blocked_by: ["not-a-uuid"] }),
    /sibling tickets/,
  );
  await assert.rejects(
    call("intake", "create_item", {
      project_id: project.id,
      kind: "feature",
      title: "Orphan parent",
      spec: {},
      parent_id: a.id,
    }),
    /only tickets/,
  );
  await assert.rejects(
    call("implementer", "create_item", {
      project_id: project.id,
      kind: "ticket",
      title: "Self-assigned",
      spec: {},
      parent_id: a.id,
    }),
    /forbidden/,
  );
});
test("only GitHub closes a ticket, and only on its observed head", async () => {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "breakdown" });
  let t = await addTicket(i);
  const [wake] =
    await sql`select count(*)::int as n from ledger.outbox where item_id=${t.id}`;
  assert.equal(wake.n, 0);
  await assert.rejects(
    change("implementer", "transition", t, { to_stage: "merged" }),
    /forbidden/,
  );
  await assert.rejects(
    change("github", "transition", t, { to_stage: "merged" }),
    /stale_binding/,
  );
  t = await mergeTicket(t);
  assert.ok(t.closed_at);
});
test("the architect refines the spec in design without restarting; other edits restart triage", async () => {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "design" });
  await assert.rejects(
    change("infra", "update_spec", i, { spec: i.spec, note: "Bypass" }),
    /owning infra or architect/,
  );
  const designed = await change("architect", "update_spec", i, {
    spec: { body: "## Design\n\nUse the existing queue." },
    note: "Technical grilling",
  });
  assert.equal(designed.stage, "design");
  assert.equal(designed.spec_version, i.spec_version + 1);
  assert.deepEqual(designed.allowed_actions.transitions.sort(), [
    "breakdown",
    "infra",
    "triage",
  ]);
  const restarted = await change("intake", "update_spec", designed, {
    spec: { body: "Requester changed scope" },
    note: "Requirement change",
  });
  assert.equal(restarted.stage, "triage");
  await assert.rejects(
    change("architect", "update_spec", restarted, {
      spec: restarted.spec,
      note: "Out of stage",
    }),
    /owning infra or architect/,
  );
});

// ---- Single writer per (issue, role) ----
const wake = (role, op, args) => rpc(op, actors[role].wake_token, args);
const as = (session, role, op, i, args = {}) =>
  change(role, op, i, { session_id: session, ...args });
const lease = async (i, role = "implementer") =>
  (await sql`select * from ledger.leases where scope_id=${i.parent_id ?? i.id} and actor_id=${actors[role].actor_id}`)[0];
async function extraWake(i, role = "implementer") {
  const [e] = await sql`select id from ledger.events where item_id=${i.id} order by seq desc limit 1`;
  const [o] = await sql`insert into ledger.outbox(item_id,event_id,actor_id,kind) values(${i.id},${e.id},${actors[role].actor_id},'escalation') returning *`;
  return o;
}
async function claimedBuild(session) {
  const i = await toBuild();
  const [o] = await sql`select * from ledger.outbox where item_id=${i.id} and status='pending' and actor_id=${actors.implementer.actor_id}`;
  const claim = await wake("implementer", "claim", { outbox_id: o.id });
  if (session)
    assert.deepEqual(
      (await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: session })).renewed,
      true,
    );
  return { i: await get(i), o, claim };
}
const head = (n) => ({ head_sha: n.repeat(40), observed_at: new Date().toISOString() });

test("only the session holding an issue writes it; its tickets share the lease; other issues and system actors are unaffected", async () => {
  const i = await toBuild();
  const [ticket] = await call("intake", "list_items", { parent_id: i.id });
  let item = await as("A", "implementer", "set_head", await get(i), head("1"));
  await assert.rejects(as("B", "implementer", "set_head", item, head("2")), /LEASE_HELD/);
  await assert.rejects(as("B", "implementer", "attach", ticket, { type: "branch", value: "b" }), /LEASE_HELD/);
  const other = await toBuild();
  await as("B", "implementer", "set_head", await get(other), head("3"));
  // System actors are never leased.
  await change("github", "set_head", await get(ticket), head("4"));
  item = await as("A", "implementer", "set_head", await get(i), head("5"));
  assert.equal(item.head_sha, "5".repeat(40));
});

test("agent writes without a session are refused", async () => {
  const i = await toBuild();
  await assert.rejects(
    rpc("set_head", actors.implementer.actor_key, { item_id: i.id, expected_version: (await get(i)).version, ...head("6") }),
    /LEASE_REQUIRED/,
  );
});

test("a wake for leased work waits for the holder and is redelivered when it releases", async () => {
  const { i, o, claim } = await claimedBuild("wake-1");
  const second = await extraWake(i);
  const waited = await wake("implementer", "claim", { outbox_id: second.id });
  assert.equal(waited.deferred, true);
  assert.equal(waited.holder_session, "wake-1");
  const [parked] = await sql`select status,attempts,next_attempt_at>now() as later from ledger.outbox where id=${second.id}`;
  assert.deepEqual(parked, { status: "pending", attempts: 0, later: true });
  await as("wake-1", "implementer", "set_head", i, head("7"));
  await assert.rejects(as("chat", "implementer", "set_head", await get(i), head("8")), /LEASE_HELD/);
  assert.deepEqual(await wake("implementer", "release_lease", { lease_token: claim.lease_token }), { released: true });
  const [due] = await sql`select next_attempt_at<=now() as due from ledger.outbox where id=${second.id}`;
  assert.ok(due.due);
  // The stage did not move, so the first wake comes back later rather than immediately.
  const [nudge] = await sql`select status,lease_until>now()+interval '29 minutes' as later from ledger.outbox where id=${o.id}`;
  assert.deepEqual(nudge, { status: "claimed", later: true });
  const next = await wake("implementer", "claim", { outbox_id: second.id });
  assert.ok(next.item);
  assert.equal(next.fence, claim.fence + 1);
});

test("an expired wake session continues until taken over, then is fenced out of that issue for good", async () => {
  const { i, claim } = await claimedBuild("wake-1");
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where token=${claim.lease_token}`;
  // Nobody else wanted it: the same session reclaims by writing.
  let item = await as("wake-1", "implementer", "set_head", i, head("9"));
  assert.ok((await lease(i)).expires_at > new Date());
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where token=${claim.lease_token}`;
  const second = await extraWake(i);
  const takeover = await wake("implementer", "claim", { outbox_id: second.id });
  assert.ok(takeover.item);
  await wake("implementer", "renew_lease", { lease_token: takeover.lease_token, session_id: "wake-2" });
  await assert.rejects(as("wake-1", "implementer", "set_head", item, head("a")), /LEASE_LOST/);
  assert.deepEqual(await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-1" }), { renewed: false });
  await wake("implementer", "release_lease", { lease_token: takeover.lease_token });
  await assert.rejects(as("wake-1", "implementer", "set_head", await get(i), head("b")), /LEASE_LOST/);
  item = await as("chat", "implementer", "set_head", await get(i), head("c"));
  assert.equal(item.head_sha, "c".repeat(40));
});

test("a chat session that lost its lapsed lease to a wake waits, then writes again once free", async () => {
  const i = await toBuild();
  await as("chat", "implementer", "set_head", await get(i), head("d"));
  await sql`update ledger.leases set expires_at=now()-interval '1 second' where scope_id=${i.id} and actor_id=${actors.implementer.actor_id}`;
  const [o] = await sql`select * from ledger.outbox where item_id=${i.id} and status='pending' and actor_id=${actors.implementer.actor_id}`;
  const claim = await wake("implementer", "claim", { outbox_id: o.id });
  await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-1" });
  await assert.rejects(as("chat", "implementer", "set_head", await get(i), head("e")), /LEASE_HELD/);
  await wake("implementer", "release_lease", { lease_token: claim.lease_token });
  const item = await as("chat", "implementer", "set_head", await get(i), head("e"));
  assert.equal(item.head_sha, "e".repeat(40));
});

test("the heartbeat binds a claimed lease to one session and keeps every lease of that session alive", async () => {
  const { i, o, claim } = await claimedBuild();
  await sql`update ledger.leases set expires_at=now()+interval '1 second' where token=${claim.lease_token}`;
  assert.equal((await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-1" })).renewed, true);
  assert.equal((await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-2" })).renewed, false);
  assert.equal((await wake("infra", "renew_lease", { lease_token: claim.lease_token })).renewed, false);
  const other = await toBuild();
  await as("wake-1", "implementer", "set_head", await get(other), head("f"));
  await sql`update ledger.leases set expires_at=now()+interval '1 second' where session_id='wake-1'`;
  await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-1" });
  assert.ok((await lease(i)).expires_at > new Date(Date.now() + 9 * 60_000));
  assert.ok((await lease(other)).expires_at > new Date(Date.now() + 9 * 60_000));
  const [wakeRow] = await sql`select lease_until>now()+interval '9 minutes' as renewed from ledger.outbox where id=${o.id}`;
  assert.ok(wakeRow.renewed);
  // Release ends all of them, and a released token never renews.
  await wake("implementer", "release_lease", { lease_token: claim.lease_token });
  assert.equal((await lease(other)).token, null);
  assert.equal((await wake("implementer", "renew_lease", { lease_token: claim.lease_token, session_id: "wake-1" })).renewed, false);
});
