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
  for (const file of ["0001_ledger.sql", "0004_mayi_approvals.sql", "0005_hosted_authorization.sql", "0006_oauth_recovery.sql", "0007_scoped_oauth_writes.sql", "0008_review_content.sql"])
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
const call = (role, op, args) => rpc(op, actors[role].actor_key, args);
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
async function built() {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "build" });
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
async function uat() {
  let i = await built();
  i = await change("implementer", "evidence", i, {
    type: "qa_passed",
    binding: sha,
    payload: { result: "pass" },
  });
  return change("implementer", "transition", i, { to_stage: "uat" });
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
    change("implementer", "transition", i, { to_stage: "build" }),
    /forbidden/,
  );
  const results = await Promise.allSettled([
    change("intake", "transition", i, { to_stage: "build" }),
    change("intake", "transition", i, { to_stage: "infra" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /stale/,
  );
});
test("QA failure can return to build; passing evidence is required only for UAT", async () => {
  let i = await built();
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "uat" }),
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
test("full feature path requires verified approvals and merge confirmation", async () => {
  let i = await uat();
  i = await get(i);
  await assert.rejects(
    change("github", "transition", i, { to_stage: "review" }),
    /gate stage/,
  );
  const t = token(i);
  assert.equal((await gate(t)).stage, "uat");
  await gate(t, { decision: "approve" });
  i = await get(i);
  assert.equal(i.stage, "review");
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
  let i = await uat();
  i = await get(i);
  const t = token(i);
  i = await change("github", "set_head", i, {
    head_sha: later,
    observed_at: "2026-09-16T02:00:00Z",
  });
  assert.equal(i.stage, "qa");
  await assert.rejects(gate(t, { decision: "approve" }), /expired|binding/);
  await assert.rejects(
    change("implementer", "transition", i, { to_stage: "uat" }),
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
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "build" });
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
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "build" });
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
  assert.ok(
    (await rpc("claim", actors.implementer.wake_token, { outbox_id: o.id }))
      .item,
  );
});
test("plan approval spawns each child once; spec edits invalidate old plan approvals", async () => {
  let i = await create("plan", {
    problem: "Plan",
    proposed_children: [
      {
        key: "one",
        kind: "feature",
        title: "Child",
        spec: { problem: "Child", acceptance_criteria: ["Works"] },
      },
    ],
  });
  i = await change("intake", "transition", i, { to_stage: "arch-review" });
  let old = token(i);
  i = await change("intake", "update_spec", i, {
    spec: i.spec,
    note: "Clarified",
  });
  assert.equal(i.stage, "triage");
  await assert.rejects(gate(old), /expired|binding/);
  i = await change("intake", "transition", i, { to_stage: "arch-review" });
  const approved = token(i);
  i = await gate(approved, { decision: "approve" });
  // Replay hits the service-side idempotency record, not an agent decision tool.
  const [request] =
    await sql`select * from ledger.approval_requests where item_id=${i.id} and epoch=${approved.epoch}`;
  const [replay] =
    await sql`select public.ledger_approval_backend('resolve',${sql.json({ review_protocol: 2, state: request.callback_state, event_id: request.id, approval_id: request.id, status: "approved", approver_id: "HumanUserAbc", expires_at: new Date(Date.now() + 86400000).toISOString(), occurred_at: new Date().toISOString() })}) as result`;
  assert.equal(replay.result.duplicate, true);
  const children =
    await sql`select * from ledger.work_items where parent_id=${i.id}`;
  assert.equal(children.length, 1);
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
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "build" });
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
  const i = await uat();
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
    change("implementer", "transition", i, { to_stage: "uat" }),
    /qa_passed missing/,
  );
});
test("a gate may be rejected then revisited on the same SHA with a fresh decision", async () => {
  let i = await uat();
  i = await get(i);
  await gate(token(i), { decision: "reject" });
  i = await get(i);
  assert.equal(i.stage, "build");
  i = await change("implementer", "transition", i, { to_stage: "qa" });
  i = await change("implementer", "evidence", i, {
    type: "qa_passed",
    binding: sha,
    payload: {},
  });
  i = await change("implementer", "transition", i, { to_stage: "uat" });
  i = await get(i);
  await gate(token(i), { decision: "approve" });
  assert.equal((await get(i)).stage, "review");
});
test("notifications can be acknowledged; ordinary work cannot be silently completed", async () => {
  let i = await create("infra");
  i = await change("intake", "transition", i, { to_stage: "infra" });
  let [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
  await rpc("claim", actors.infra.wake_token, { outbox_id: o.id });
  await assert.rejects(
    call("infra", "complete_wake", { outbox_id: o.id, note: "Skip work" }),
    /work wakes complete/,
  );
  i = await change("infra", "evidence", i, {
    type: "infra_provisioned",
    binding: String(i.spec_version),
    payload: {},
  });
  i = await change("infra", "transition", i, { to_stage: "infra-approval" });
  i = await get(i);
  await gate(token(i), { decision: "approve" });
  i = await get(i);
  assert.equal(i.stage, "done");
  [o] =
    await sql`select * from ledger.outbox where item_id=${i.id} and status='pending'`;
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
    change("intake", "transition", i, { to_stage: "build" }),
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
  assert.ok(i.allowed_actions.transitions.includes("build"));
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
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "plan-review" });
  const rows =
    await sql`select * from ledger.outbox where item_id=${i.id} and actor_id=${actors.intake.actor_id} and status in ('pending','claimed')`;
  assert.equal(rows.length, 0);
});
test("blocked specs and non-owning infra cannot reset an engineer gate", async () => {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "plan-review" });
  await assert.rejects(
    change("infra", "update_spec", i, { spec: i.spec, note: "Bypass" }),
    /owning infra/,
  );
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
  assert.equal(i.stage, "plan-review");
});
test("live heartbeats extend the lease; old claimants cannot renew a replacement", async () => {
  let i = await create();
  i = await change("intake", "transition", i, { to_stage: "build" });
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
