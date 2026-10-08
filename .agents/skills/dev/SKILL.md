---
name: dev
description: Starts or restarts this checkout's harnesst dev server and hands the user its tailnet link. Use when asked to run the app, give a dev link, or recover a server whose port is blocked.
---

# Dev

The user opens the link from another tailnet device: a laptop or a phone. The
job is done when they have the **App line** URL, which opens there.

## 1. Resolve this checkout's ports

`.env.local` is the source of truth. The main checkout has no `PORT` and runs
on the defaults.

```bash
port=$(sed -n 's/^PORT=//p' .env.local); port=${port:-5173}
splitter=$(sed -n 's/^HARNESST_SPLITTER_PORT=//p' .env.local); splitter=${splitter:-8787}
echo "$port $splitter"
```

Every later command uses these two numbers and no others: other worktrees'
servers share this machine.

## 2. Free exactly those two ports

```bash
lsof -nP -iTCP:<PORT> -iTCP:<SPLITTER> -sTCP:LISTEN -t | xargs -r kill
```

Escalate a listener that survives a couple of seconds with `kill -9 <pid>`.
Done when `lsof -nP -iTCP:<PORT> -iTCP:<SPLITTER> -sTCP:LISTEN -t` prints
nothing; starting earlier fails with `EADDRINUSE`.

## 3. Start it to the port-named log

```bash
npm run dev > /tmp/harnesst-dev-<PORT>.log 2>&1 &
```

The log path is fixed by the port, so any later shell rebuilds it exactly;
other agents' logs sit beside it under the same prefix, so always name the
file by its port.

## 4. Read the App line

`npm run dev` picks the tailnet origin itself (`scripts/dev-origin.mjs`) and
prints it under Vite's URLs:

```
➜  App:     http://app--<worktree>.harnesst.test:<PORT>/
```

Poll for it:

```bash
grep -m1 "App:" /tmp/harnesst-dev-<PORT>.log
```

The server is up when the App line appears. That line is the whole
verification.

## 5. Hand over the link

Reply with the App URL bare on its own line, so the chat autolinks it, plus
the log path:

http://app--feature-x.harnesst.test:5273/

The main checkout's is `http://app.harnesst.test:5173/`. The tailnet host is
the one that works for the user: share links, artifact previews and sign-in
all follow it.

If the App line ends with a note that the `.test` host does not resolve, the
tailnet DNS is down. Report that, and fix it with the `infra` skill.
