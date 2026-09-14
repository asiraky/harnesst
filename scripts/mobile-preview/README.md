# Mobile preview

Runs the real app, Better Auth, Postgres queries, draft writes, and artifact store with local GitHub/model catalogs and the protocol fake Eve server from the integration suite. No production auth bypass or fixture branch is added to the app.

Use a dedicated local Postgres database named `harnesst_mobile_<name>`. The runner refuses other database names and remote database hosts. Apply migrations before starting it.

Configure `.env.local` with `DATABASE_URL`, `BETTER_AUTH_SECRET`, `HARNESST_SECRETS_KEY`, `BETTER_AUTH_URL`, and an unused worktree `PORT`. For this sweep the app uses `http://localhost:5293`, the database is `harnesst_mobile_omniplex`, and the log is `/tmp/harnesst-dev-5293.log`.

```sh
set -a
source .env.local
set +a
npm run db:migrate
node scripts/mobile-preview/start.mjs > /tmp/harnesst-dev-5293.log 2>&1
```

Sign in as `mobile@example.test`, password `correct-horse-battery-staple`. The marketing site uses `http://127.0.0.1:5293`. The fixture provides team and single-agent repositories, a nested subagent, long names, source files, model selection, conversations, successful/failed runs, members, and downloadable/HTML artifacts. Chat responses are deterministic; GitHub mutation APIs are intentionally absent. Draft edits and installation previews use the real handlers. Workers, the splitter, and the reconciler are disabled. Generated Eve session history lasts for the life of the preview process.

Use a dedicated agent-browser session and sign into it before running the sweep:

```sh
npx agent-browser --session mobile-omniplex open http://localhost:5293/login
# Complete the email/password form in that session.
node scripts/mobile-preview/sweep.mjs
```

On Linux hosts that cannot launch Chromium's sandbox, pass `--args '--no-sandbox'` when opening the browser. Install agent-browser/Chromium if unavailable.

`AGENT_BROWSER_SESSION`, `MOBILE_PREVIEW_ORIGIN`, and `MOBILE_WIDTHS` override the browser session, app origin, and widths. Defaults are `mobile-omniplex`, `http://localhost:5293`, and `320,390,768,1280`.

The sweep visits representative routes for every application screen family, including team/member/subagent scopes. It records rendered widths, unexpected redirects, runtime error overlays, and content extending beyond the viewport. Intentional table/tab scrolling and truncated picker text are excluded. Screenshots and JSON results go to `artifacts/mobile-sweep/` and are ignored by Vite's watcher, so recording evidence does not interrupt form interactions.

The script complements manual checks of populated menus, dialogs, forms, chat, and public/auth pages. Chromium emulation does not replace Safari/Android hardware checks of the virtual keyboard and safe-area insets. External OAuth consent and real deployment execution are outside this fixture.
