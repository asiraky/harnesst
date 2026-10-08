---
name: dev
description: Use when the user asks to start or restart the dev server, or for a link to the app, when the dev server's port is blocked, or when you need a dev server running for end-to-end testing.
---

# Dev

Start the dev server for this checkout and give the user the link to it. If its
ports are blocked, kill whatever holds them and try again.

## Ports

Be precise about *which* ports to kill — only this checkout's, never anything
else. Other worktrees' servers share this machine.

`.env.local` is the source of truth. The main checkout (`/home/aaron/code/harnesst`)
has no `PORT` and runs on the defaults: dev server `5173`, traffic splitter
`8787`. A worktree's pair starts at `5273` / `8887`.

```bash
port=$(sed -n 's/^PORT=//p' .env.local); port=${port:-5173}
splitter=$(sed -n 's/^HARNESST_SPLITTER_PORT=//p' .env.local); splitter=${splitter:-8787}
echo "$port $splitter"
```

Every later command uses these two numbers and no others.

## Procedure

**1. Kill exactly the two ports:**

```bash
lsof -nP -iTCP:<PORT> -iTCP:<SPLITTER> -sTCP:LISTEN -t | xargs -r kill
```

Escalate a listener that survives a couple of seconds with `kill -9 <pid>`.

**2. Confirm both ports are free.** `lsof -nP -iTCP:<PORT> -iTCP:<SPLITTER> -sTCP:LISTEN -t`
prints nothing. Starting earlier fails with `EADDRINUSE`.

**3. Start it to the port-named log.** `npm run dev` is one process (React
Router/Vite; it spawns the traffic splitter), so there is one log:

```bash
npm run dev > /tmp/harnesst-dev-<PORT>.log 2>&1 &
```

The path is fixed by the port, so any later shell rebuilds it exactly. Other
agents' logs sit beside it under the same prefix: always name the file by its
port.

**4. Verify with the App line.** `npm run dev` picks the tailnet origin itself
(`scripts/dev-origin.mjs`) and prints it under Vite's URLs:

```
➜  App:     http://app--<worktree>.harnesst.test:<PORT>/
```

Poll for it:

```bash
grep -m1 "App:" /tmp/harnesst-dev-<PORT>.log
```

The server is up when the App line appears. That line is the whole
verification.

## Report the link

Report the App URL to the user **using the tailnet DNS name, not localhost**.
The user is on another tailnet device, and `localhost` is not their machine;
share links, artifact previews and sign-in all follow the tailnet host.

- **Main checkout**: `http://app.harnesst.test:5173/`.
- **Worktree**: the URL from the App line, of the form `http://app--<worktree>.harnesst.test:<PORT>/`.

Give it bare on its own line, as plain text, so the chat autolinks it. A URL
inside a code fence, backticks or `[label](url)` reaches the user as dead text.
Like this:

App: http://app.harnesst.test:5173/

(`localhost` is fine for your own checks — the DNS name is for what you report
to the user.) Also mention the log path (`/tmp/harnesst-dev-<PORT>.log`) so they
can ask what's in it later.

If the App line ends with a note that the `.test` host does not resolve, the
tailnet DNS is down. Report that, and fix it with the `infra` skill.
