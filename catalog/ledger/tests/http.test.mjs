import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerRpc } from "../../templates/tools/ledger-tools/files/lib/ledger.ts";
test("RPC client registers changed wake URL, passes explicit versions and returns server errors", async () => {
  const previous = globalThis.fetch;
  const env = { ...process.env };
  Object.assign(process.env, {
    LEDGER_URL: "https://ledger.test",
    LEDGER_ANON_KEY: "anon",
    LEDGER_ACTOR_KEY: "actor",
    LEDGER_WAKE_TOKEN: "wake",
    EVE_PUBLIC_ORIGIN: "https://member.test",
  });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("whoami"))
      return Response.json({ wake_url: "https://old.test" });
    if (url.endsWith("transition"))
      return Response.json(
        { message: "stale (item version 3, sent 2)" },
        { status: 400 },
      );
    return Response.json({ ok: true });
  };
  try {
    const result = await ledgerRpc("transition", {
      item_id: "item",
      expected_version: 2,
      to_stage: "qa",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /stale/);
    assert.equal(calls.length, 3);
    assert.equal(
      calls[1].body.p_args.url,
      "https://member.test/eve/v1/ledger/wake",
    );
    assert.equal(calls[2].body.p_args.expected_version, 2);
    calls.length = 0;
    await ledgerRpc("claim", { outbox_id: "wake-id" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.p_key, "wake");
  } finally {
    globalThis.fetch = previous;
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});
