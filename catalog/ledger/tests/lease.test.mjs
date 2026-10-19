import { test } from "node:test";
import assert from "node:assert/strict";
import { createLeaseKeeper, startLeaseHeartbeat } from "../../templates/tools/ledger-tools/files/lib/ledger-lease.ts";
test("heartbeat renews repeatedly and stops when the turn ends", async () => {
  let count = 0;
  const heartbeat = startLeaseHeartbeat(async () => {
    count++;
    return { ok: true, data: { renewed: true } };
  });
  await heartbeat.tick();
  await heartbeat.tick();
  assert.equal(count, 2);
  heartbeat.stop();
  await heartbeat.tick();
  assert.equal(count, 2);
});
test("heartbeat stops after loss of ownership, but retries transient errors", async () => {
  let count = 0;
  const heartbeat = startLeaseHeartbeat(async () => {
    count++;
    return count === 1 ? { ok: false } : { ok: true, data: { renewed: false } };
  });
  await heartbeat.tick();
  await heartbeat.tick();
  await heartbeat.tick();
  assert.equal(count, 2);
  heartbeat.stop();
});
test("slow renewals cannot overlap", async () => {
  let finish;
  let count = 0;
  const heartbeat = startLeaseHeartbeat(() => {
    count++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = heartbeat.tick();
  await heartbeat.tick();
  assert.equal(count, 1);
  finish({ ok: true, data: { renewed: true } });
  await first;
  heartbeat.stop();
});

function fakeLedger(renewed = true) {
  const calls = [];
  const rpc = async (op, args) => {
    calls.push({ op, ...args });
    if (op === "renew_lease") return { ok: true, data: { renewed } };
    return { ok: true, data: { released: true } };
  };
  return { calls, rpc };
}
test("keeper renews at once, binds the session when it becomes known, and binds only once", async () => {
  const { calls, rpc } = fakeLedger();
  const keeper = createLeaseKeeper(rpc);
  await keeper.hold("t1");
  await keeper.hold("t1", "s1");
  await keeper.hold("t1", "s2");
  await keeper.hold("t1");
  assert.deepEqual(calls, [
    { op: "renew_lease", lease_token: "t1" },
    { op: "renew_lease", lease_token: "t1", session_id: "s1" },
  ]);
  keeper.drop("t1");
});
test("keeper forgets a lease the ledger refused", async () => {
  const { rpc } = fakeLedger(false);
  const keeper = createLeaseKeeper(rpc);
  await keeper.hold("t1", "s1");
  assert.equal(keeper.has("t1"), false);
});
test("release tells the ledger; drop only stops renewing", async () => {
  const { calls, rpc } = fakeLedger();
  const keeper = createLeaseKeeper(rpc);
  await keeper.hold("t1", "s1");
  await keeper.hold("t2", "s2");
  await keeper.release("t1");
  keeper.drop("t2");
  assert.equal(keeper.has("t1"), false);
  assert.equal(keeper.has("t2"), false);
  assert.deepEqual(calls.filter((c) => c.op === "release_lease"), [{ op: "release_lease", lease_token: "t1" }]);
});
test("a channel without a lease does nothing", async () => {
  const { calls, rpc } = fakeLedger();
  const keeper = createLeaseKeeper(rpc);
  await keeper.hold("");
  await keeper.release("");
  assert.deepEqual(calls, []);
});
test("a failing release is swallowed so the turn can end", async () => {
  const keeper = createLeaseKeeper(async (op) => {
    if (op === "release_lease") throw Error("network");
    return { ok: true, data: { renewed: true } };
  });
  await keeper.hold("t1");
  await keeper.release("t1");
  assert.equal(keeper.has("t1"), false);
});
