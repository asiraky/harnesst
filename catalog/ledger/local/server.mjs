import express from "express";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { sql, rpc } from "./db.mjs";
const port = Number(process.env.LEDGER_PORT || 55430),
  origin = process.env.LEDGER_ORIGIN || `http://localhost:${port}`;
const allowedOrigins = new Set([
  origin,
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);
const allowedHosts = new Set(
  [...allowedOrigins].map((value) => new URL(value).host),
);
const actors = JSON.parse(
  await readFile(new URL("../.local/actors.json", import.meta.url), "utf8"),
);
const app = express();
app.use((req, res, next) => {
  // Accept only the configured lab origin and loopback; reject DNS rebinding and cross-origin requests.
  if (!allowedHosts.has(req.headers.host)) return res.sendStatus(403);
  if (
    req.headers.origin &&
    !allowedOrigins.has(req.headers.origin)
  )
    return res.sendStatus(403);
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.get("/", (_req, res) =>
  res.sendFile(new URL("index.html", import.meta.url).pathname, {
    dotfiles: "allow",
  }),
);
app.get("/app.js", (_req, res) =>
  res.sendFile(new URL("app.js", import.meta.url).pathname, {
    dotfiles: "allow",
  }),
);
app.get("/preview", (_req, res) =>
  res
    .type("html")
    .send(
      "<h1>Prototype preview</h1><p>This is a simulated product preview. In live mode, the item links to your actual deployment.</p>",
    ),
);
const same = (a, b) =>
  !!a &&
  !!b &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rpcHandler = async (req, res) => {
  try {
    const op = req.params.fn.replace(/^ledger_/, "");
    if (req.params.fn !== `ledger_${op}`) return res.sendStatus(404);
    res.json(await rpc(op, req.body.p_key, req.body.p_args));
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};
app.post("/rest/v1/rpc/:fn", rpcHandler);
// Container-facing API has no lab/operator endpoints. Every RPC requires its own actor key.
const bridge = express();
bridge.use(express.json({ limit: "256kb" }));
bridge.post("/rest/v1/rpc/:fn", rpcHandler);
const bridgeServer = bridge.listen(
  Number(process.env.LEDGER_RPC_PORT || 55431),
  "0.0.0.0",
);
app.get("/api/state", async (_req, res) => {
  const projects = await rpc("list_projects", actors.intake.actor_key);
  const items = await rpc("list_items", actors.intake.actor_key);
  const outbox =
    await sql`select o.*,a.role from ledger.outbox o join ledger.actors a on a.id=o.actor_id order by o.created_at desc limit 60`;
  const roster =
    await sql`select role,kind,wake_url from ledger.actors order by role`;
  res.json({
    projects,
    items,
    outbox,
    roster,
    mode: "Local simulation — actions use real database rules; code, evidence and deployments are simulated.",
  });
});
app.post("/api/rpc", async (req, res) => {
  try {
    const { role, op, args = {} } = req.body;
    if (!actors[role]?.actor_key)
      throw Error("Choose an agent or GitHub actor");
    res.json(await rpc(op, actors[role].actor_key, args));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.post("/api/connect", async (req, res) => {
  try {
    const { role, url } = req.body;
    if (!["intake", "infra", "implementer"].includes(role))
      throw Error("Unknown agent");
    await rpc("set_wake_url", actors[role].actor_key, { url });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.post("/mock/:role/eve/v1/ledger/wake", async (req, res) => {
  try {
    const actor = actors[req.params.role];
    if (!same(req.headers.authorization, `Bearer ${actor?.wake_token}`))
      return res.sendStatus(401);
    const claimed = await rpc("claim", actor.wake_token, req.body);
    // The lab inbox represents a claimed agent turn. It deliberately does not fabricate progress.
    res.json(claimed);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});
for (const role of ["intake", "infra", "implementer"]) {
  const me = await rpc("whoami", actors[role].actor_key);
  if (!me.wake_url)
    await rpc("set_wake_url", actors[role].actor_key, {
      url: `${origin}/mock/${role}/eve/v1/ledger/wake`,
    });
}
let delivering = false;
const timer = setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    const [row] = await sql`select public.ledger_delivery_batch() as batch`;
    await Promise.allSettled(
      row.batch.map(async ({ url, token, body }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          console.error(
            `Wake delivery HTTP ${response.status} for ${body.outbox_id}`,
          );
      }),
    );
  } catch (error) {
    console.error("Delivery:", error.message);
  } finally {
    delivering = false;
  }
}, 1000);
const server = app.listen(port, process.env.LEDGER_HOST || "127.0.0.1", () =>
  console.log(`Ledger prototype: ${origin}`),
);
async function stop() {
  clearInterval(timer);
  server.close();
  bridgeServer.close();
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
