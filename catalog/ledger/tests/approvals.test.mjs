import { reviewBody, reviewDigest } from "../supabase/functions/_shared/review.ts";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { generateKeyPair, exportJWK, CompactSign } from "jose";
import {
  callbackHandler,
  canonical,
  dispatch,
  accessToken,
} from "../supabase/functions/_shared/approvals.ts";
const origin = "https://mayi.example.test";
const config = {
  origin,
  callback_url: "https://ledger.example.test/functions/v1/approval-callback",
  workspace_id: "workspace123",
  client_id: "client123",
};
let db, admin, key, jwk;
const mayiId = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (n) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[n % 52],
  ).join("");
const name = "ledger_approvals_" + Date.now();
const url =
  process.env.LEDGER_DATABASE_URL ||
  "postgres://postgres:ledger-local-only@127.0.0.1:55432/ledger";
let actors = {},
  project;
const backend = async (op, args = {}) => {
  const [row] = await db.begin(async (tx) => {
    await tx`set local role service_role`;
    return tx`select public.ledger_approval_backend(${op},${tx.json({...args,review_protocol:2})}) as result`;
  });
  return row.result;
};
const agent = async (role, op, args = {}) => {
  const [row] = await db.begin(async (tx) => {
    await tx`set local role anon`;
    return tx`select ${tx("public.ledger_" + op)}(${actors[role].actor_key},${tx.json({ session_id: "test-" + role, ...args })}) as result`;
  });
  return row.result;
};
const step = async (role, op, item, args = {}) =>
  agent(role, op, { item_id: item.id, expected_version: item.version, ...args });
// Carries an item in build through QA and review to the merge-approval gate on `head`.
async function toMergeApproval(item, head) {
  item = await step("implementer", "set_head", item, {
    head_sha: head,
    observed_at: new Date().toISOString(),
  });
  item = await step("implementer", "attach", item, {
    type: "pr",
    value: "https://example.test/pr/" + item.id,
  });
  item = await step("implementer", "attach", item, {
    type: "preview_url",
    value: "https://example.test/preview/" + head,
    binding: head,
  });
  item = await step("implementer", "transition", item, { to_stage: "qa" });
  item = await step("implementer", "evidence", item, {
    type: "qa_passed",
    binding: head,
    payload: {},
  });
  item = await step("implementer", "transition", item, { to_stage: "review" });
  item = await step("implementer", "evidence", item, {
    type: "review_approved",
    binding: head,
    payload: {},
  });
  return step("implementer", "transition", item, {
    to_stage: "merge-approval",
  });
}
async function gate() {
  let item = await agent("intake", "create_item", {
    project_id: project.id,
    kind: "feature",
    title: "Approval test",
    spec: { problem: "Test" },
  });
  item = await step("intake", "transition", item, { to_stage: "breakdown" });
  let ticket = await agent("intake", "create_item", {
    project_id: project.id,
    kind: "ticket",
    title: "Only slice",
    spec: { body: "Slice" },
    parent_id: item.id,
  });
  item = await step("intake", "transition", await agent("intake", "get_item", { item_id: item.id }), { to_stage: "build" });
  ticket = await step("github", "set_head", ticket, {
    head_sha: "c".repeat(40),
    observed_at: new Date().toISOString(),
  });
  await step("github", "transition", ticket, {
    to_stage: "merged",
    binding: ticket.head_sha,
  });
  item = await toMergeApproval(item, "a".repeat(40));
  const [request] =
    await db`select * from ledger.approval_requests where item_id=${item.id}`;
  request.review_body = reviewBody(request.action, request.supersedes_remote_id);
  request.review_digest = await reviewDigest(request.review_body);
  await db`update ledger.approval_requests set review_body=${db.json(request.review_body)},review_digest=${request.review_digest} where id=${request.id}`;
  return { item, request };
}
function event(request, status = "approved") {
  return {
    id: mayiId(),
    type: "approval.resolved",
    version: 1,
    approvalId: mayiId(),
    state: request.callback_state,
    occurredAt: new Date().toISOString(),
    status,
    ...(["approved", "denied"].includes(status)
      ? { approver: { id: "HumanUserAbc" } }
      : {}),
    ...(status === "approved" ? { receipt: "test." + Buffer.from(JSON.stringify({review_digest:request.review_digest})).toString("base64url") + ".test" } : {}),
  };
}
async function signed(e) {
  const signature = await new CompactSign(
    new TextEncoder().encode(canonical(e)),
  )
    .setProtectedHeader({
      alg: "EdDSA",
      typ: "mayi-webhook+jws",
      kid: "test-key",
    })
    .sign(key);
  return new Request(config.callback_url, {
    method: "POST",
    headers: { "x-mayi-signature": signature },
    body: JSON.stringify(e),
  });
}
function remote(r, e) {
  return {
    id: e.approvalId,
    workspaceId: config.workspace_id,
    action: r.action,
    ...r.review_body,
    reviewDigest:r.review_digest,
    reviewUrl:origin + "/?approval=" + e.approvalId,
    decisionOutcome:e.status.toUpperCase(),
    decisionComment:null,
    state: e.status.toUpperCase(),
    approverId: e.approver?.id,
    receipt: e.receipt,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    decidedAt: e.occurredAt,
  };
}
function mockFetch(r, e, mutate = (x) => x) {
  return async (target) =>
    String(target).includes("/.well-known/")
      ? Response.json({ keys: [jwk] })
      : Response.json(mutate(remote(r, e)));
}
before(async () => {
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const target = new URL(url);
  target.pathname = "/" + name;
  db = postgres(target.toString(), { max: 10, onnotice: () => {} });
  await db.unsafe(
    await readFile(new URL("../local/roles.sql", import.meta.url), "utf8"),
  );
  await db`alter default privileges in schema public grant execute on functions to anon,authenticated`;
  const connection = await db.reserve();
  try {
    for (const file of [
      "0001_ledger.sql",
      "0003_workflow.sql",
      "0004_mayi_approvals.sql",
      "0005_hosted_authorization.sql",
      "0006_oauth_recovery.sql",
      "0007_scoped_oauth_writes.sql", "0008_review_content.sql", "0009_tickets.sql", "0010_leases.sql",
    ])
      await connection.unsafe(
        await readFile(new URL("../" + file, import.meta.url), "utf8"),
      );
  } finally {
    connection.release();
  }
  for (const [role, kind] of [
    ["intake", "agent"],
    ["implementer", "agent"],
    ["github", "system"],
    ["engineer", "human"],
    ["requester", "human"],
  ]) {
    const [r] =
      await db`select public.ledger_mint_actor(${role},${kind},${role}) as result`;
    actors[role] = r.result;
  }
  await db`insert into ledger.approval_config(origin,callback_url,client_id,access_secret,refresh_secret,expires_at,connection_status) values(${origin},${config.callback_url},'client123',ledger.secret('access'),ledger.secret('refresh'),now()+interval '1 hour','connected')`;
  const workflow = JSON.parse(
    await readFile(new URL("../workflow.json", import.meta.url), "utf8"),
  );
  await db`insert into ledger.workflow_templates values('default',${db.json(workflow)}) on conflict(name) do update set definition=excluded.definition`;
  project = await agent("intake", "create_project", {
    slug: "test",
    name: "Test",
    repo: "test/test",
  });
  const pair = await generateKeyPair("EdDSA");
  key = pair.privateKey;
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test-key",
    alg: "EdDSA",
    use: "sig",
  };
});
after(async () => {
  if (db) await db.end();
  if (admin) {
    await admin.unsafe(`drop database if exists ${name}`);
    await admin.end();
  }
});
test("agent cannot invoke old approval API, private decision function or trusted callback RPC", async () => {
  const { item } = await gate();
  for (const role of ["anon", "authenticated"])
    for (const q of [
      "select public.ledger_gate('forged','{}')",
      "select public.ledger_decide_gate('forged','{}')",
      "select public.ledger_approval_backend('resolve','{}')",
      "select * from ledger.approval_config",
      "select * from ledger.approval_requests",
    ]) {
      await assert.rejects(
        db.begin(async (tx) => {
          await tx.unsafe("set local role " + role);
          await tx.unsafe(q);
        }),
        /permission denied|does not exist/,
      );
    }
  await assert.rejects(
    agent("intake", "transition", {
      item_id: item.id,
      expected_version: item.version,
      to_stage: "ready-to-merge",
    }),
    /gate stage/,
  );
  await assert.rejects(
    db.begin(async (tx) => {
      await tx`set local role anon`;
      await tx`select ledger.call('decide_gate',${actors.intake.actor_key},'{}')`;
    }),
    /permission denied/,
  );
});
test("verified callback advances once and repeated delivery applies one decision", async () => {
  const { request, item } = await gate();
  const e = event(request);
  const handler = callbackHandler(backend, config, mockFetch(request, e));
  assert.equal((await handler(await signed(e))).status, 200);
  assert.equal((await handler(await signed(e))).status, 200);
  assert.equal(
    (await agent("intake", "get_item", { item_id: item.id })).stage,
    "ready-to-merge",
  );
  const [count] =
    await db`select count(*)::int as n from ledger.gates where item_id=${item.id}`;
  assert.equal(count.n, 1);
});
test("callback may arrive before submission acknowledgement", async () => {
  const { request, item } = await gate();
  const e = event(request);
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, e),
      )(await signed(e))
    ).status,
    200,
  );
  await backend("submitted", {
    id: request.id,
    lease_token: crypto.randomUUID(),
    remote_id: e.approvalId,
  });
  const [r] =
    await db`select status from ledger.approval_requests where id=${request.id}`;
  assert.equal(r.status, "approved");
});
test("forged signature, altered body, inconsistent approver and action are rejected", async () => {
  const { request, item } = await gate();
  const e = event(request);
  const handler = callbackHandler(backend, config, mockFetch(request, e));
  assert.equal(
    (
      await handler(
        new Request(config.callback_url, {
          method: "POST",
          body: JSON.stringify(e),
        }),
      )
    ).status,
    401,
  );
  const good = await signed(e);
  assert.equal(
    (
      await handler(
        new Request(config.callback_url, {
          method: "POST",
          headers: good.headers,
          body: JSON.stringify({ ...e, status: "denied" }),
        }),
      )
    ).status,
    401,
  );
  for (const mutate of [
    (r) => ({ ...r, action: { ...r.action, resourceVersion: "999" } }),
    (r) => ({ ...r, approverId: "other" }),
    (r) => ({ ...r, receipt: "other" }),
  ])
    assert.equal(
      (
        await callbackHandler(
          backend,
          config,
          mockFetch(request, e, mutate),
        )(await signed(e))
      ).status,
      409,
    );
  const otherHuman = { ...e, approver: { id: "OtherUserAbc" } };
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, otherHuman),
      )(await signed(otherHuman))
    ).status,
    200,
  );
  const [audit] =
    await db`select approver_id from ledger.approval_events where event_id=${otherHuman.id}`;
  assert.equal(audit.approver_id, "OtherUserAbc");
});
test("old approval cannot advance a changed head; denial returns to build", async () => {
  const { request, item } = await gate();
  const e = event(request);
  await step("github", "set_head", item, {
    head_sha: "b".repeat(40),
    observed_at: new Date().toISOString(),
  });
  const response = await callbackHandler(
    backend,
    config,
    mockFetch(request, e),
  )(await signed(e));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stale, true);
  assert.equal(
    (await agent("intake", "get_item", { item_id: item.id })).stage,
    "qa",
  );
  const other = await gate();
  const denied = event(other.request, "denied");
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(other.request, denied),
      )(await signed(denied))
    ).status,
    200,
  );
  assert.equal(
    (await agent("intake", "get_item", { item_id: other.item.id })).stage,
    "build",
  );
});
test("concurrent duplicate callbacks create one gate event", async () => {
  const { request, item } = await gate();
  const e = event(request);
  const handler = callbackHandler(backend, config, mockFetch(request, e));
  const results = await Promise.all([
    handler(await signed(e)),
    handler(await signed(e)),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const [r] =
    await db`select count(*)::int as n from ledger.approval_events where request_id=${request.id}`;
  assert.equal(r.n, 1);
});
test("lost submission response retries identical payload and stops before idempotency retention expires", async () => {
  await db`update ledger.approval_requests set status='superseded' where status='pending'`;
  const { request } = await gate();
  let calls = [];
  const fetcher = async (u, init) => {
    calls.push({ headers: init.headers, body: init.body });
    throw new Error("network reset");
  };
  await dispatch(backend, fetcher);
  await db`update ledger.approval_requests set next_attempt_at=now() where id=${request.id}`;
  await dispatch(backend, fetcher);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  await db`update ledger.approval_requests set first_attempt_at=now()-interval '24 hours',next_attempt_at=now() where id=${request.id}`;
  await dispatch(backend, fetcher);
  assert.equal(calls.length, 2);
  const [r] =
    await db`select status from ledger.approval_requests where id=${request.id}`;
  assert.equal(r.status, "failed");
});
test("signing-key outage is retryable, old signed events and oversized bodies are rejected", async () => {
  const { request } = await gate();
  const e = event(request);
  assert.equal(
    (
      await callbackHandler(backend, config, async () => {
        throw new Error("offline");
      })(await signed(e))
    ).status,
    503,
  );
  const old = {
    ...e,
    occurredAt: new Date(Date.now() - 8 * 86400000).toISOString(),
  };
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, old),
      )(await signed(old))
    ).status,
    401,
  );
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, e),
      )(
        new Request(config.callback_url, {
          method: "POST",
          body: "x".repeat(128 * 1024 + 1),
        }),
      )
    ).status,
    401,
  );
});
test("decision made before expiry can arrive late; decisions made after expiry cannot advance", async () => {
  const first = await gate();
  await db`update ledger.approval_requests set created_at=now()-interval '2 hours',expires_at=now()-interval '30 minutes' where id=${first.request.id}`;
  const delayed = {
    ...event(first.request),
    occurredAt: new Date(Date.now() - 3600000).toISOString(),
  };
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(first.request, delayed),
      )(await signed(delayed))
    ).status,
    200,
  );
  assert.equal(
    (await agent("intake", "get_item", { item_id: first.item.id })).stage,
    "ready-to-merge",
  );
  const second = await gate();
  await db`update ledger.approval_requests set expires_at=now()-interval '1 minute' where id=${second.request.id}`;
  const late = event(second.request);
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(second.request, late, (r) => ({
          ...r,
          expiresAt: new Date(Date.now() - 60000).toISOString(),
        })),
      )(await signed(late))
    ).status,
    409,
  );
  assert.equal(
    (await agent("intake", "get_item", { item_id: second.item.id })).stage,
    "merge-approval",
  );
});
test("artifact edits and new head at the gate invalidate the exact approval snapshot", async () => {
  const { request, item } = await gate();
  const e = event(request);
  await agent("implementer", "attach", {
    item_id: item.id,
    expected_version: item.version,
    type: "preview_url",
    value: "https://example.test/preview/rebuilt",
    binding: item.head_sha,
  });
  const changed = await agent("intake", "get_item", { item_id: item.id });
  assert.ok(changed.gate_epoch > item.gate_epoch);
  assert.equal(
    (
      await (
        await callbackHandler(
          backend,
          config,
          mockFetch(request, e),
        )(await signed(e))
      ).json()
    ).stale,
    true,
  );
  const same = await agent("implementer", "attach", {
    item_id: item.id,
    expected_version: changed.version,
    type: "preview_url",
    value: "https://example.test/preview/rebuilt",
    binding: item.head_sha,
  });
  assert.equal(same.gate_epoch, changed.gate_epoch);
  await agent("implementer", "set_head", {
    item_id: item.id,
    expected_version: same.version,
    head_sha: "b".repeat(40),
    observed_at: new Date().toISOString(),
  });
  assert.ok(
    (await agent("intake", "get_item", { item_id: item.id })).gate_epoch >
      same.gate_epoch,
  );
});
test("approval and next agent wake roll back together if wake insertion fails", async () => {
  const { request, item } = await gate();
  const e = event(request, "denied");
  await db.unsafe(
    `create function ledger.fail_test_wake() returns trigger language plpgsql as $$ begin raise exception 'test wake outage'; end $$;create trigger test_fail before insert on ledger.outbox for each row execute function ledger.fail_test_wake()`,
  );
  try {
    assert.equal(
      (
        await callbackHandler(
          backend,
          config,
          mockFetch(request, e),
        )(await signed(e))
      ).status,
      503,
    );
    assert.equal(
      (await agent("intake", "get_item", { item_id: item.id })).stage,
      "merge-approval",
    );
    const [count] =
      await db`select count(*)::int as n from ledger.gates where item_id=${item.id}`;
    assert.equal(count.n, 0);
  } finally {
    await db.unsafe(
      "drop trigger test_fail on ledger.outbox;drop function ledger.fail_test_wake()",
    );
  }
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, e),
      )(await signed(e))
    ).status,
    200,
  );
  const [wake] =
    await db`select count(*)::int as n from ledger.outbox where item_id=${item.id} and status='pending'`;
  assert.equal(wake.n, 1);
});
test("successful dispatch persists the remote ID and does not submit again", async () => {
  await db`update ledger.approval_requests set status='superseded' where status='pending'`;
  const { request } = await gate();
  let calls = 0;
  const id = mayiId();
  const fetcher = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.callback.state, request.callback_state);
    return Response.json({
      id,
      workspaceId: config.workspace_id,
      action: body.action,
      title:body.title,reviewMarkdown:body.reviewMarkdown,explanation:body.explanation,
      reviewDigest:await reviewDigest(body),reviewUrl:origin+"/?approval="+id,
      expiresAt: new Date(Date.now() + 604800000).toISOString(),
    });
  };
  assert.equal(await dispatch(backend, fetcher), 1);
  assert.equal(await dispatch(backend, fetcher), 0);
  assert.equal(calls, 1);
  const [r] =
    await db`select remote_id,status from ledger.approval_requests where id=${request.id}`;
  assert.equal(r.status, "submitted");
  assert.equal(r.remote_id, id);
});
test("dispatcher reconciles a human decision after callback retries are exhausted", async () => {
  await db`update ledger.approval_requests set status='superseded' where status in ('pending','submitted')`;
  const { request, item } = await gate();
  const e = event(request);
  await db`update ledger.approval_requests set status='submitted',remote_id=${e.approvalId},next_attempt_at=now(),expires_at=now()-interval '1 hour' where id=${request.id}`;
  assert.equal(await dispatch(backend, mockFetch(request, e)), 0);
  assert.equal(
    (await agent("intake", "get_item", { item_id: item.id })).stage,
    "ready-to-merge",
  );
  // A subsequently replayed signed callback cannot apply a second transition.
  assert.equal(
    (
      await callbackHandler(
        backend,
        config,
        mockFetch(request, e),
      )(await signed(e))
    ).status,
    200,
  );
  const [r] =
    await db`select count(*)::int as n from ledger.gates where item_id=${item.id}`;
  assert.equal(r.n, 1);
});
test("permanent submission errors stop with the actual error and explanations respect provider limits", async () => {
  await db`update ledger.approval_requests set status='superseded' where status='pending'`;
  const { request } = await gate();
  await db`update ledger.approval_requests set action=jsonb_set(action,'{input,title}',to_jsonb(repeat('x',12000))) where id=${request.id}`;
  let length = 0;
  await dispatch(backend, async (_url, init) => {
    length = JSON.parse(init.body).explanation.length;
    return new Response("", { status: 422 });
  });
  assert.ok(length > 0 && length < 10000);
  const [r] =
    await db`select status,last_error from ledger.approval_requests where id=${request.id}`;
  assert.equal(r.status, "failed");
  assert.match(r.last_error, /HTTP 422/);
});
test("refresh is serialized; uncertain refresh is never retried using old rotating token", async () => {
  await db`update ledger.approval_config set expires_at=now()-interval '1 minute'`;
  let calls = 0;
  await assert.rejects(
    accessToken(backend, config, async () => {
      calls++;
      throw new Error("lost response");
    }),
    /lost response/,
  );
  await assert.rejects(
    accessToken(backend, config, async () => {
      calls++;
      return Response.json({});
    }),
    /refresh in progress or uncertain/,
  );
  assert.equal(calls, 1);
});

test("hosted OAuth registers once, consumes state once and reconnects the same agent with pending approvals", async () => {
  const { oauthHandler } =
    await import("../supabase/functions/_shared/oauth.ts");
  await db`delete from ledger.approval_config`;
  await db`update ledger.approval_requests set status='superseded' where status in ('pending','submitted')`;
  const oauth = async (op, args = {}) => {
    const [r] = await db.begin(async (tx) => {
      await tx`set local role service_role`;
      return tx`select public.ledger_oauth(${op},${tx.json(args)}) as result`;
    });
    return r.result;
  };
  let registrations = 0,
    exchanges = 0;
  const handler = oauthHandler(
    oauth,
    "https://project.supabase.co",
    "setup-secret",
    async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/register")) {
        registrations++;
        return Response.json({ client_id: "StableClient" });
      }
      exchanges++;
      assert.equal(body.client_id, "StableClient");
      assert.equal(
        body.redirect_uri,
        "https://project.supabase.co/functions/v1/approval-oauth",
      );
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        agent_id: "StableAgent",
      });
    },
  );
  const start = () =>
    handler(
      new Request("https://project.supabase.co/functions/v1/approval-oauth", {
        method: "POST",
        headers: { Authorization: "Bearer setup-secret" },
        body: JSON.stringify({ operation: "start", label: "HARNESST — test" }),
      }),
    );
  assert.equal(
    (
      await handler(
        new Request("https://project.supabase.co", {
          method: "POST",
          body: '{"operation":"start"}',
        }),
      )
    ).status,
    401,
  );
  let url = new URL((await (await start()).json()).url);
  assert.equal(url.searchParams.has("connection"), false);
  assert.equal(url.searchParams.get("label"), "HARNESST — test");
  const callback = new Request(
    `https://project.supabase.co/functions/v1/approval-oauth?state=${url.searchParams.get("state")}&code=code`,
  );
  assert.equal((await handler(callback)).status, 200);
  assert.equal((await handler(callback)).status, 400);
  assert.equal(exchanges, 1);
  const { request } = await gate();
  await db`update ledger.approval_requests set status='submitted',first_attempt_at=now(),remote_id='ExistingApproval' where id=${request.id}`;
  url = new URL((await (await start()).json()).url);
  assert.equal(url.searchParams.get("connection"), "StableAgent");
  assert.equal(registrations, 1);
  assert.equal(
    (
      await handler(
        new Request(
          `https://project.supabase.co/functions/v1/approval-oauth?state=${url.searchParams.get("state")}&code=reconnect`,
        ),
      )
    ).status,
    200,
  );
  assert.equal((await oauth("status")).status, "connected");
  const [pending] =
    await db`select remote_id,status from ledger.approval_requests where id=${request.id}`;
  assert.equal(pending.remote_id, "ExistingApproval");
  assert.equal(pending.status, "submitted");
  // A grant from another identity is rejected without replacing the stored credentials.
  url = new URL((await (await start()).json()).url);
  const mismatch = oauthHandler(
    oauth,
    "https://project.supabase.co",
    "setup-secret",
    async () =>
      Response.json({
        access_token: "wrong",
        refresh_token: "wrong",
        expires_in: 3600,
        agent_id: "DifferentAgent",
      }),
  );
  assert.equal(
    (
      await mismatch(
        new Request(
          `https://project.supabase.co/functions/v1/approval-oauth?state=${url.searchParams.get("state")}&code=bad`,
        ),
      )
    ).status,
    400,
  );
  const [stored] =
    await db`select agent_id,ledger.reveal(refresh_secret) as refresh from ledger.approval_config`;
  assert.equal(stored.agent_id, "StableAgent");
  assert.equal(stored.refresh, "new-refresh");
  assert.equal((await oauth("status")).status, "connected");
  // A superseded tab cannot exchange its authorization code.
  const old = new URL((await (await start()).json()).url);
  await start();
  assert.equal(
    (
      await handler(
        new Request(
          `https://project.supabase.co/functions/v1/approval-oauth?state=${old.searchParams.get("state")}&code=old`,
        ),
      )
    ).status,
    400,
  );
  assert.equal(exchanges, 2);
});

test("refresh 400 marks reconnect required and never retries the spent credential", async () => {
  await db`update ledger.approval_config set connection_status='connected',expires_at=now()-interval '1 minute',refresh_claim=null`;
  const c = await backend("config");
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response("", { status: 400 });
  };
  await assert.rejects(accessToken(backend, c, fetcher), /reauthorization/);
  await assert.rejects(accessToken(backend, c, fetcher), /reconnection/);
  assert.equal(calls, 1);
});

test("concurrent refreshes issue one request and persist rotated credentials before returning", async () => {
  await db`update ledger.approval_config set connection_status='connected',expires_at=now()-interval '1 minute',refresh_claim=null`;
  const c = await backend("config");
  let calls = 0,
    release,
    started;
  const began = new Promise((r) => (started = r)),
    blocked = new Promise((r) => (release = r));
  const fetcher = async () => {
    calls++;
    started();
    await blocked;
    return Response.json({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  };
  const first = accessToken(backend, c, fetcher);
  await began;
  await assert.rejects(accessToken(backend, c, fetcher), /refresh in progress/);
  release();
  assert.equal(await first, "rotated-access");
  const [r] =
    await db`select ledger.reveal(refresh_secret) as refresh,refresh_claim from ledger.approval_config`;
  assert.equal(r.refresh, "rotated-refresh");
  assert.equal(r.refresh_claim, null);
  assert.equal(calls, 1);
  assert.equal(await accessToken(backend, c, fetcher), "rotated-access");
  assert.equal(calls, 1);
});

test("authorization cancellation, expiry and public RPC denial do not exchange tokens", async () => {
  const { oauthHandler } =
    await import("../supabase/functions/_shared/oauth.ts");
  const oauth = async (op, args = {}) => {
    const [r] =
      await db`select public.ledger_oauth(${op},${db.json(args)}) as result`;
    return r.result;
  };
  let calls = 0;
  const handler = oauthHandler(
    oauth,
    "https://project.supabase.co",
    "secret",
    async () => {
      calls++;
      throw new Error("Unexpected network call");
    },
  );
  const start = async () =>
    new URL(
      (
        await (
          await handler(
            new Request("https://project.supabase.co", {
              method: "POST",
              headers: { Authorization: "Bearer secret" },
              body: JSON.stringify({ operation: "start", label: "test" }),
            }),
          )
        ).json()
      ).url,
    );
  let url = await start();
  const denied = await handler(
    new Request(
      `https://project.supabase.co?state=${url.searchParams.get("state")}&error=access_denied`,
    ),
  );
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /declined/);
  url = await start();
  await db`update ledger.oauth_attempts set expires_at=now()-interval '1 second'`;
  assert.equal(
    (
      await handler(
        new Request(
          `https://project.supabase.co?state=${url.searchParams.get("state")}&code=expired`,
        ),
      )
    ).status,
    400,
  );
  assert.equal((await oauth("status")).status, "connected");
  assert.equal(calls, 0);
  await assert.rejects(
    db.begin(async (tx) => {
      await tx`set local role anon`;
      await tx`select public.ledger_oauth('status','{}')`;
    }),
    /permission denied/,
  );
});

test("expired access on submission leaves gates pending and renews only that credential", async () => {
  await db`update ledger.approval_requests set status='superseded' where status in ('pending','submitted')`;
  await db`update ledger.approval_config set connection_status='connected',expires_at=now()+interval '1 hour',refresh_claim=null`;
  const { request } = await gate();
  let calls = 0;
  await dispatch(backend, async () => {
    calls++;
    return new Response("", { status: 401 });
  });
  assert.equal(calls, 1);
  const [r] =
    await db`select status from ledger.approval_requests where id=${request.id}`;
  assert.equal(r.status, "pending");
  const [c] =
    await db`select expires_at<now() as expired from ledger.approval_config`;
  assert.equal(c.expired, true);
  // A late failure from an old access token must not invalidate a newly saved grant.
  await db`update ledger.approval_config set access_secret=ledger.secret('replacement'),expires_at=now()+interval '1 hour'`;
  await backend("access_rejected", {
    token_hash: "0".repeat(64),
    status: "403",
  });
  assert.equal((await backend("config")).connection_status, "connected");
});

test("definite registration rejection permits retry; uncertain registration does not duplicate clients", async () => {
  const { oauthHandler } =
    await import("../supabase/functions/_shared/oauth.ts");
  await db`delete from ledger.approval_config`;
  await db`delete from ledger.oauth_registration`;
  await db`update ledger.approval_requests set status='superseded' where status in ('pending','submitted')`;
  const oauth = async (op, args = {}) => {
    const [r] =
      await db`select public.ledger_oauth(${op},${db.json(args)}) as result`;
    return r.result;
  };
  let calls = 0;
  const handler = oauthHandler(
    oauth,
    "https://project.supabase.co",
    "secret",
    async () => {
      calls++;
      return new Response("", { status: 429 });
    },
  );
  const request = () =>
    new Request("https://project.supabase.co", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: JSON.stringify({ operation: "start", label: "test" }),
    });
  assert.equal((await handler(request())).status, 400);
  assert.equal((await handler(request())).status, 400);
  assert.equal(calls, 2);
  const uncertain = oauthHandler(
    oauth,
    "https://project.supabase.co",
    "secret",
    async () => {
      calls++;
      throw new Error("network unavailable");
    },
  );
  assert.equal((await uncertain(request())).status, 400);
  assert.equal((await uncertain(request())).status, 400);
  assert.equal(calls, 3);
});

test('requested changes preserve feedback and link the revised approval to the denied request', async () => {
  await db`insert into ledger.approval_config(origin,callback_url,client_id,access_secret,refresh_secret,expires_at,connection_status) values(${origin},${config.callback_url},'client123',ledger.secret('access'),ledger.secret('refresh'),now()+interval '1 hour','connected')`;
  const {request,item}=await gate();
  const e=event(request,'denied');
  const handler=callbackHandler(backend,config,mockFetch(request,e,r=>({...r,
    decisionOutcome:'CHANGES_REQUESTED',decisionComment:'Use a separate preview Worker.'})));
  assert.equal((await handler(await signed(e))).status,200);
  let changed=await agent('intake','get_item',{item_id:item.id});
  assert.equal(changed.stage,'build');
  assert.equal(changed.events.find(x=>x.kind==='rework').payload.feedback,'Use a separate preview Worker.');
  const [record]=await db`select feedback,decision_outcome from ledger.approval_events where request_id=${request.id}`;
  assert.equal(record.decision_outcome,'CHANGES_REQUESTED');
  assert.equal(record.feedback,'Use a separate preview Worker.');
  changed=await toMergeApproval(changed,'d'.repeat(40));
  const [revision]=await db`select * from ledger.approval_requests where item_id=${item.id} and epoch=${changed.gate_epoch}`;
  assert.equal(revision.supersedes_remote_id,e.approvalId);
  assert.equal(revision.status,'pending');
  assert.equal(changed.stage,'merge-approval');
});

test('changed document, missing digest and wrong receipt digest cannot approve work', async () => {
  for(const mutate of [r=>({...r,reviewMarkdown:'Different proposal'}),r=>({...r,reviewDigest:null}),
    r=>({...r,receipt:'test.'+Buffer.from(JSON.stringify({review_digest:'0'.repeat(64)})).toString('base64url')+'.test'})]) {
    const {request,item}=await gate(),e=event(request);
    assert.notEqual((await callbackHandler(backend,config,mockFetch(request,e,mutate))(await signed(e))).status,200);
    assert.equal((await agent('intake','get_item',{item_id:item.id})).stage,'merge-approval');
  }
});

test('notification waits for the persisted review URL and submission acknowledgement is idempotent', async () => {
  const {request,item}=await gate();
  let [count]=await db`select count(*)::int n from ledger.outbox where item_id=${item.id} and status='pending'`;
  assert.equal(count.n,0);
  const lease=crypto.randomUUID(),remoteId=mayiId(),url=origin+'/?approval='+remoteId;
  await db`update ledger.approval_requests set lease_token=${lease} where id=${request.id}`;
  const ack={id:request.id,lease_token:lease,remote_id:remoteId,expires_at:new Date(Date.now()+86400000).toISOString(),review_url:url};
  await backend('submitted',ack);await backend('submitted',ack);
  [count]=await db`select count(*)::int n from ledger.outbox where item_id=${item.id} and status='pending'`;
  assert.equal(count.n,1);
  assert.equal((await agent('intake','get_item',{item_id:item.id})).approval.review_url,url);
});
