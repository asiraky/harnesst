/**
 * A scriptable fake eve instance: a real node:http server implementing the eve HTTP session
 * contract harnesst talks to (verified in app/agent/talk.server.ts's header):
 *
 *   POST /eve/v1/session                → 202 + x-eve-session-id + {sessionId, continuationToken}
 *   POST /eve/v1/session/:id            → 202 (+ x-eve-session-id); body {message,
 *                                         continuationToken, inputResponses?} is RECORDED
 *   GET  /eve/v1/session/:id/stream?startIndex=N → NDJSON replay of the session's event log
 *                                         from index N, then held open for live pushes until
 *                                         the script ends the session
 *   POST /eve/v1/session/:id/cancel     → 200
 *
 * Tests drive it via `onTurn` (invoked once per accepted POST, after the 202) plus `emit`/
 * `end` — so a spec can replay a turn's events immediately, or hold a turn "running" and push
 * the completion later (the away-mid-turn cases). Every POST body is recorded for assertions
 * (the request-correlated `inputResponses` proof reads them).
 *
 * Event shapes are the raw eve NDJSON `{type, data, meta: {at}}` lines — the same shapes
 * tests/unit/stream-turn.test.ts scripts against `streamTurn`.
 */
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface FakeEveEvent {
  type: string;
  data: Record<string, unknown>;
  meta: { at: string };
}

/** One accepted message POST (first turn or follow-up), as the fake saw it. */
export interface RecordedTurnPost {
  /** null for POST /eve/v1/session (eve mints the id); the session id on follow-ups. */
  sessionId: string | null;
  /** The session the 202 answered with (minted or echoed). */
  acceptedSessionId: string;
  body: Record<string, unknown>;
}

export interface FakeEveTurn {
  sessionId: string;
  /** 0-based per session: 0 = the seeding turn, 1+ = follow-ups. */
  turnIndex: number;
  body: Record<string, unknown>;
}

type TurnHandler = (turn: FakeEveTurn) => void | Promise<void>;

interface SessionState {
  id: string;
  continuationToken: string;
  events: FakeEveEvent[];
  streams: Set<ServerResponse>;
  ended: boolean;
  turnCount: number;
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class FakeEve {
  /** Every accepted message POST, in order — assert continuation bodies against this. */
  readonly turnPosts: RecordedTurnPost[] = [];
  /** Session ids that received POST .../cancel. */
  readonly cancels: string[] = [];
  /** Script errors (an onTurn handler throwing) — surfaced so specs can fail loudly. */
  readonly scriptErrors: unknown[] = [];

  private readonly sessions = new Map<string, SessionState>();
  private handler: TurnHandler | null = null;
  private counter = 0;

  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeEve> {
    const server = createServer();
    let eve: FakeEve;
    server.on("request", (req, res) => {
      void eve.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake eve failed to bind a port");
    }
    eve = new FakeEve(server, `http://127.0.0.1:${address.port}`);
    return eve;
  }

  /** Set (or replace) the per-turn script. Runs detached right after each 202. */
  onTurn(handler: TurnHandler): void {
    this.handler = handler;
  }

  /** Append one event to the session log and push it to every open stream. */
  emit(sessionId: string, type: string, data: Record<string, unknown> = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fake eve: unknown session ${sessionId}`);
    const event: FakeEveEvent = {
      type,
      data,
      meta: { at: new Date().toISOString() },
    };
    session.events.push(event);
    const line = `${JSON.stringify(event)}\n`;
    for (const res of session.streams) res.write(line);
  }

  /** End the session's stream: close open responses; later connects replay then end. */
  end(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fake eve: unknown session ${sessionId}`);
    session.ended = true;
    for (const res of session.streams) res.end();
    session.streams.clear();
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const res of session.streams) res.destroy();
      session.streams.clear();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private newSession(): SessionState {
    this.counter += 1;
    const session: SessionState = {
      id: `sess_e2e_${this.counter}`,
      continuationToken: `tok_e2e_${this.counter}`,
      events: [],
      streams: new Set(),
      ended: false,
      turnCount: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private runScript(session: SessionState, body: Record<string, unknown>): void {
    const turn: FakeEveTurn = {
      sessionId: session.id,
      turnIndex: session.turnCount,
      body,
    };
    session.turnCount += 1;
    const handler = this.handler;
    if (!handler) return;
    // Detached, like a real eve running the turn after accepting the message.
    void Promise.resolve()
      .then(() => handler(turn))
      .catch((error) => this.scriptErrors.push(error));
  }

  private async route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["eve","v1","session",...]
    if (parts[0] !== "eve" || parts[1] !== "v1" || parts[2] !== "session") {
      res.writeHead(404).end();
      return;
    }

    // POST /eve/v1/session — first turn: mint the session.
    if (req.method === "POST" && parts.length === 3) {
      const body = await readJsonBody(req);
      const session = this.newSession();
      this.turnPosts.push({
        sessionId: null,
        acceptedSessionId: session.id,
        body,
      });
      res.writeHead(202, {
        "content-type": "application/json",
        "x-eve-session-id": session.id,
      });
      res.end(
        JSON.stringify({
          sessionId: session.id,
          continuationToken: session.continuationToken,
        }),
      );
      this.runScript(session, body);
      return;
    }

    const session = this.sessions.get(parts[3] ?? "");
    if (!session) {
      res.writeHead(404).end();
      return;
    }

    // POST /eve/v1/session/:id/cancel
    if (req.method === "POST" && parts[4] === "cancel") {
      await readJsonBody(req);
      this.cancels.push(session.id);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }

    // POST /eve/v1/session/:id — follow-up turn (continuation token in the body).
    if (req.method === "POST" && parts.length === 4) {
      const body = await readJsonBody(req);
      this.turnPosts.push({
        sessionId: session.id,
        acceptedSessionId: session.id,
        body,
      });
      // Real eve omits the token on follow-ups (it stays valid for the session).
      res.writeHead(202, {
        "content-type": "application/json",
        "x-eve-session-id": session.id,
      });
      res.end(JSON.stringify({ sessionId: session.id }));
      this.runScript(session, body);
      return;
    }

    // GET /eve/v1/session/:id/stream?startIndex=N — NDJSON replay + live tail.
    if (req.method === "GET" && parts[4] === "stream") {
      const startIndex = Math.max(
        0,
        Number.parseInt(url.searchParams.get("startIndex") ?? "0", 10) || 0,
      );
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const event of session.events.slice(startIndex)) {
        res.write(`${JSON.stringify(event)}\n`);
      }
      if (session.ended) {
        res.end();
        return;
      }
      session.streams.add(res);
      res.on("close", () => session.streams.delete(res));
      return;
    }

    res.writeHead(404).end();
  }
}

export function startFakeEve(): Promise<FakeEve> {
  return FakeEve.start();
}
