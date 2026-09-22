import { test } from "node:test";
import assert from "node:assert/strict";
import { startLeaseHeartbeat } from "../../templates/tools/ledger-tools/files/lib/ledger-lease.ts";
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
