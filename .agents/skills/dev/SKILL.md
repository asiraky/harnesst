---
name: dev
description: Starts the harnesst dev server and tails the logs. Use whenever a running dev server is needed — starting, restarting, or recovering one whose port is blocked.
---

# Dev

Start the dev server and give me the link to it. If the ports are blocked for
some reason then kill whatever is using them and try again.

## Ports

Be precise about *which* ports to kill — only kill the ports belonging to this
checkout, never anything else.

- **Main checkout** (`/Users/aaron/code/eden`): dev server `5173`, traffic splitter `8787`.
- **Worktree**: use the worktree's own ports, listed in the worktree's
  `WORKTREE.md` (under `## URL & ports`). Worktree dev ports start at `5273+`
  and splitter ports at `8887+`, unique per worktree — read `WORKTREE.md` at
  the worktree root to get the exact pair before killing anything.

## Procedure

> **The commands below are EXAMPLES.** They use the main-checkout ports `5173`
> (dev) / `8787` (splitter). Substitute the real ports for wherever you're
> running: main checkout uses the pair above; a worktree uses the pair from its
> `WORKTREE.md`. Always resolve the actual `<PORT>` / `<SPLITTER_PORT>` first,
> then plug them into every command.

**1. Kill exactly the two ports** (only the listeners on those ports — nothing else):

```bash
lsof -nP -iTCP:5173 -iTCP:8787 -sTCP:LISTEN -t | xargs kill
```

`SIGTERM` is normally immediate. If a listener survives after a couple of
seconds, escalate just the survivors with `kill -9 <pid>`.

**2. Confirm both ports are FREE before relaunching** (relaunching while one is
still bound causes `EADDRINUSE`):

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN -t; lsof -nP -iTCP:8787 -sTCP:LISTEN -t
```

Empty output = free. Do not start anything until both are empty.

**3. Start the dev server to a deterministic per-port log.** `npm run dev` is a
single process (React Router/Vite; the traffic splitter is spawned by it), so
there is only one log.

The log filename MUST embed *this checkout's dev port*:
`/tmp/eden-dev-<PORT>.log`. Do NOT use `mktemp` or any random suffix. Ports are
unique per checkout/worktree, so port-named logs never collide with another
agent's logs running in parallel — and because the name is fully determined by
the port you already resolved in step 1, you can rebuild the exact path in any
later shell with zero guessing. Each `>` truncates a stale log from a previous
run of the same server.

```bash
# substitute this checkout's real port — e.g. worktree 5273, main 5173
dev_log=/tmp/eden-dev-5173.log
echo "dev -> $dev_log"
npm run dev > "$dev_log" 2>&1 &
```

**Shell variables do NOT persist between Bash tool calls.** In every later
step, re-derive the same path from the port (just reassign
`dev_log=/tmp/eden-dev-<PORT>.log` at the top of the call). NEVER discover the
log via `ls -t /tmp/eden-*` or any glob — that matches other agents' files and
will tail the wrong process. Always rebuild the literal port-based path.

**4. Verify the server is actually up — watch the log for the Vite "listening"
line.** Do NOT trust a generic "started" log line; the server is ready when its
log prints the local URL, e.g.:

```
➜  Local:   http://localhost:5173/
```

Grep the log for it (re-derive `dev_log` from the port first — see step 3),
polling until it appears:

```bash
dev_log=/tmp/eden-dev-5173.log
grep -m1 "Local:   http://localhost:5173/" "$dev_log"
```

Once the log shows its `Local:` line, report the app URL to the user, and
mention the port-based log path (`/tmp/eden-dev-<PORT>.log`) so they can ask
what's in it later.

That signal is the ONLY verification — once you have it, report and stop. No
extra curls, re-tails, or `lsof` re-checks; and empty Bash output means
buffering, not failure, so never panic-retry or run shell-alive checks.
