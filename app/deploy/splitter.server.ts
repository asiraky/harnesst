/**
 * Weighted, session-sticky traffic splitter (D9/D10 — PRD §7.7, ARCH §3.6).
 *
 * The minimal real implementation of the multi-version primitive: one HTTP proxy that fronts
 * every environment at `/e/:environmentId/*`, picks a live deployment by trafficWeight on a
 * session's FIRST request, pins the session to it with a cookie, and proxies. A conversation
 * therefore never flips Release mid-life; weights only steer NEW sessions — exactly the
 * semantics the PRD promises ("weighted, session-sticky").
 *
 * OSS/dev ingress. The managed substrate replaces this with Caddy/Traefik + wake-proxy behind
 * the same deployments/trafficWeight data (the splitter reads the same rows the UI writes).
 */
import http from "node:http";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "~/db/client.server";
import { deployments } from "~/db/schema";
import { pickWeighted } from "./split";
import { refreshLiveDeploymentsForEnvironment } from "./wake.server";

const PORT = Number(process.env.HARNESST_SPLITTER_PORT ?? 8787);
const COOKIE = "harnesst_split";

type LiveDeployment = { id: string; url: string; trafficWeight: number };

async function liveDeployments(environmentId: string): Promise<LiveDeployment[]> {
  const rows = await db
    .select({
      id: deployments.id,
      url: deployments.url,
      trafficWeight: deployments.trafficWeight,
    })
    .from(deployments)
    .where(
      and(eq(deployments.environmentId, environmentId), eq(deployments.status, "live")),
    );
  return rows.filter((r): r is LiveDeployment => !!r.url);
}

function readCookie(req: http.IncomingMessage, env: string): string | null {
  const raw = req.headers.cookie ?? "";
  const m = raw.match(new RegExp(`${COOKIE}_${env.slice(0, 8)}=([^;]+)`));
  return m ? m[1] : null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  // Environment ids are 12-char [a-z] nanoids (`~/lib/id`); the 36-char [0-9a-f-] form
  // keeps pre-nanoid UUID rows routable.
  const match = req.url?.match(/^\/e\/([a-z0-9-]{12,36})(\/.*)?$/);
  if (!match) {
    res.writeHead(404).end("Unknown environment. Use /e/<environmentId>/…");
    return;
  }
  const [, environmentId, rest = "/"] = match;

  await refreshLiveDeploymentsForEnvironment(environmentId);
  const live = await liveDeployments(environmentId);
  if (live.length === 0) {
    res.writeHead(503).end("No live deployments in this environment.");
    return;
  }

  // Sticky: reuse the pinned deployment while it is still live; otherwise (first request
  // of a session, or its version was drained/stopped) pick by weight and pin.
  const pinned = readCookie(req, environmentId);
  let target = live.find((d) => d.id === pinned) ?? null;
  if (!target) {
    target = pickWeighted(live);
    if (!target) {
      res.writeHead(503).end("No routable deployment.");
      return;
    }
    res.setHeader(
      "set-cookie",
      `${COOKIE}_${environmentId.slice(0, 8)}=${target.id}; Path=/e/${environmentId}; HttpOnly; SameSite=Lax`,
    );
  }

  const upstream = new URL(rest, target.url);
  const proxied = http.request(
    upstream,
    {
      method: req.method,
      headers: { ...req.headers, host: upstream.host, "x-harnesst-release": target.id },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`Upstream error: ${err.message}`);
  });
  req.pipe(proxied);
}

function startSplitter(): { stop: () => void } {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(`Splitter error: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[splitter] listening on http://127.0.0.1:${PORT}/e/<environmentId>/`);
  });
  server.unref();
  return { stop: () => server.close() };
}

const globalForSplitter = globalThis as unknown as {
  __harnesstSplitter?: { stop: () => void };
};

/** Start the splitter once per process; safe to call from any server module. */
export function ensureSplitterStarted(): void {
  if (process.env.HARNESST_DISABLE_SPLITTER === "1") return;
  globalForSplitter.__harnesstSplitter ??= startSplitter();
}
