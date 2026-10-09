import { test } from "node:test";
import assert from "node:assert/strict";
import { handleGitHubEvent } from "../examples/github-ledger.mjs";
const id = "a0000000-0000-0000-0000-000000000001",
  sha = "a".repeat(40),
  repo = "owner/product",
  base = { ref: "main", repo: { default_branch: "main" } };
function fixture(stage = "build") {
  let item = {
    id,
    project_id: "p",
    version: 1,
    head_sha: sha,
    stage,
    artifacts: [
      { type: "pr", value: "https://github.com/owner/product/pull/1" },
    ],
  };
  const calls = [];
  return {
    calls,
    get item() {
      return item;
    },
    deps: {
      repo,
      gh: async (path, method, body) => {
        calls.push({ path, method, body });
        if (method === "PUT") return { merged: true, sha: "c".repeat(40) };
        return { number: 1, head: { sha }, base, merged: false };
      },
      rpc: async (op, args) => {
        calls.push({ op, args });
        if (op === "get_project") return { repo };
        if (op === "list_items") return [item];
        if (op === "get_item") return item;
        if (op === "set_head")
          item = {
            ...item,
            head_sha: args.head_sha,
            version: item.version + 1,
          };
        if (op === "attach") item = { ...item, version: item.version + 1 };
        if (op === "transition") {
          assert.equal(args.binding, sha);
          item = { ...item, stage: args.to_stage, version: item.version + 1 };
        }
        return item;
      },
    },
  };
}
test("PR event attaches artifacts and head; fork events cannot mutate ledger", async () => {
  const f = fixture();
  const event = {
    pull_request: {
      head: { ref: `ledger/${id}-welcome`, sha, repo: { full_name: repo } },
      updated_at: "2026-09-16T00:00:00Z",
      html_url: "https://github.com/owner/product/pull/1",
    },
  };
  await handleGitHubEvent(event, "pull_request_target", f.deps);
  assert.ok(f.calls.some((x) => x.op === "set_head"));
  assert.equal(f.calls.filter((x) => x.op === "attach").length, 2);
  const fork = fixture();
  event.pull_request.head.repo.full_name = "stranger/fork";
  await handleGitHubEvent(event, "pull_request_target", fork.deps);
  assert.equal(fork.calls.length, 0);
});
test("scheduled merge uses exact approved SHA and records confirmed merge", async () => {
  const f = fixture("ready-to-merge");
  await handleGitHubEvent({}, "schedule", f.deps);
  assert.equal(f.calls.find((x) => x.method === "PUT").body.sha, sha);
  assert.equal(f.item.stage, "merged");
});
test("an approved PR retargeted off the default branch is neither merged nor marked merged", async () => {
  const f = fixture("ready-to-merge");
  const retargeted = { ref: `ledger/${id}-other`, repo: { default_branch: "main" } };
  f.deps.gh = async (path, method) => {
    f.calls.push({ path, method });
    return { number: 1, head: { sha }, base: retargeted, merged: false };
  };
  await assert.rejects(handleGitHubEvent({}, "schedule", f.deps), /default branch/);
  assert.equal(f.calls.some((x) => x.method === "PUT"), false);
  assert.equal(f.item.stage, "ready-to-merge");
  await assert.rejects(
    handleGitHubEvent(
      { pull_request: { number: 1, merged: true, head: { ref: `ledger/${id}-x`, sha, repo: { full_name: repo } }, base: retargeted } },
      "pull_request_target",
      f.deps,
    ),
    /default branch/,
  );
  assert.equal(f.item.stage, "ready-to-merge");
});
test("changed PR head refuses merge; blocked approvals are skipped", async () => {
  const f = fixture("ready-to-merge");
  f.deps.gh = async () => ({ head: { sha: "b".repeat(40) }, number: 1 });
  await assert.rejects(
    handleGitHubEvent({}, "schedule", f.deps),
    /no longer PR head/,
  );
  assert.equal(f.item.stage, "ready-to-merge");
  const blocked = fixture("ready-to-merge");
  blocked.item.blocked_on = { question: "Wait" };
  await handleGitHubEvent({}, "schedule", blocked.deps);
  assert.equal(blocked.calls.filter((x) => x.path).length, 0);
});
test("deployment binds original PR head and advances only confirmed production deploy", async () => {
  const f = fixture("merged");
  const event = {
    deployment: {
      environment: "production",
      payload: { ledger_item_id: id, head_sha: sha },
    },
    deployment_status: {
      state: "success",
      environment_url: "https://product.example",
    },
  };
  await handleGitHubEvent(event, "deployment_status", f.deps);
  assert.equal(f.item.stage, "deployed");
  event.deployment.payload.head_sha = "b".repeat(40);
  await assert.rejects(
    handleGitHubEvent(event, "deployment_status", fixture("merged").deps),
    /stale head/,
  );
});
test("one invalid merge item does not block later approved work", async () => {
  const f = fixture("ready-to-merge"),
    original = f.deps.rpc;
  f.deps.rpc = async (op, args) => {
    if (op === "list_items") return [{ ...f.item, id: "bad" }, f.item];
    if (op === "get_item" && args.item_id === "bad")
      return { ...f.item, id: "bad", artifacts: [] };
    return original(op, args);
  };
  await assert.rejects(
    handleGitHubEvent({}, "schedule", f.deps),
    /bad: Invalid PR artifact/,
  );
  assert.equal(f.item.stage, "merged");
});
test("concurrent webhook merge completion is an idempotent success", async () => {
  const f = fixture("ready-to-merge"),
    original = f.deps.rpc;
  let transitions = 0;
  f.deps.rpc = async (op, args) => {
    if (op === "transition") {
      transitions++;
      f.item.stage = "merged";
      f.item.version++;
      throw Error("stale (item version 2, sent 1)");
    }
    return original(op, args);
  };
  await handleGitHubEvent({}, "schedule", f.deps);
  assert.equal(transitions, 1);
  assert.equal(f.item.stage, "merged");
});


test("approved merge dispatches deployment for the confirmed merge commit", async () => {
  const f = fixture("ready-to-merge");
  await handleGitHubEvent({}, "schedule", f.deps);
  const sent = f.calls.find(x => x.path === "dispatches");
  assert.deepEqual(sent.body.client_payload, {
    ledger_item_id: id, head_sha: sha, merge_sha: "c".repeat(40), pull_request: 1,
  });
  assert.ok(f.calls.indexOf(sent) < f.calls.findIndex(x => x.op === "transition"));
});

test("failed dispatch retains pending merge reconciliation and retries without merging twice", async () => {
  const f = fixture("ready-to-merge");
  let merged = false, merges = 0, sends = 0;
  f.deps.gh = async (path, method) => {
    if (path === "dispatches") {
      if (++sends === 1) throw Error("dispatch unavailable");
      return null;
    }
    if (method === "PUT") {
      merges++; merged = true; return { merged: true, sha: "c".repeat(40) };
    }
    return { number: 1, head: { sha }, base, merged, merge_commit_sha: merged ? "c".repeat(40) : null };
  };
  await assert.rejects(handleGitHubEvent({}, "schedule", f.deps), /dispatch unavailable/);
  assert.equal(f.item.stage, "ready-to-merge");
  await handleGitHubEvent({}, "schedule", f.deps);
  assert.equal(merges, 1);
  assert.equal(sends, 2);
  assert.equal(f.item.stage, "merged");
});


test("deployment dispatch reads authoritative GitHub status rather than trusting the payload", async () => {
  const f = fixture("merged");
  f.deps.gh = async path => path.endsWith("/statuses")
    ? [{state: "success", environment_url: "https://product.example"}]
    : {sha: "c".repeat(40), environment: "production", payload: {
        ledger_item_id: id, head_sha: sha, merge_sha: "c".repeat(40),
      }};
  await handleGitHubEvent({action: "ledger-deployed", client_payload: {deployment_id: 123}},
    "repository_dispatch", f.deps);
  assert.equal(f.item.stage, "deployed");
  const bad = fixture("merged");
  bad.deps.gh = async path => path.endsWith("/statuses") ? [{state:"failure"}] : {};
  await assert.rejects(handleGitHubEvent({action:"ledger-deployed",client_payload:{deployment_id:123}},
    "repository_dispatch",bad.deps), /not successful/);
  assert.equal(bad.item.stage, "merged");
});

test("deployment dispatch rejects a successful deployment of a different merge commit", async () => {
  const f = fixture("merged");
  f.deps.gh = async path => path.endsWith('/statuses')
    ? [{state:'success',environment_url:'https://product.example'}]
    : {sha:'d'.repeat(40),payload:{ledger_item_id:id,head_sha:sha,merge_sha:'c'.repeat(40)}};
  await assert.rejects(handleGitHubEvent({action:'ledger-deployed',client_payload:{deployment_id:123}},
    'repository_dispatch',f.deps), /does not match/);
  assert.equal(f.item.stage,'merged');
});

test("a merged ticket PR closes the ticket only when it lands on the parent issue branch", async () => {
  const parent = "b0000000-0000-0000-0000-000000000002";
  const merged = (base) => ({
    pull_request: {
      number: 7,
      merged: true,
      head: { ref: `ledger/${id}-slice`, sha, repo: { full_name: repo } },
      base: { ref: base },
    },
  });
  const f = fixture("open");
  Object.assign(f.item, { kind: "ticket", parent_id: parent });
  await assert.rejects(
    handleGitHubEvent(merged("main"), "pull_request_target", f.deps),
    /parent issue branch/,
  );
  assert.equal(f.item.stage, "open");
  await handleGitHubEvent(
    merged(`ledger/${parent}-issue`),
    "pull_request_target",
    f.deps,
  );
  assert.equal(f.item.stage, "merged");
});
