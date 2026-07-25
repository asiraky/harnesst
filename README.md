# harnesst

A web app for building, managing, and deploying [eve](https://github.com/vercel/eve) agents
without hand-writing code. harnesst puts a guided web UI + an embedded coding assistant over an eve
repo so **product managers** can author agents, then ships and operates the result. Open source +
self-hostable, and also a commercial managed service.

New here? Start with [`docs/ROADMAP.md`](./docs/ROADMAP.md) (what's shipped and what's next),
then [`docs/PRD.md`](./docs/PRD.md) (full product spec) and
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (managed-service infra).

**Stack:** React Router 7 (framework mode, SSR) · TypeScript · Tailwind 4 · Drizzle + Postgres ·
Better Auth (email/password auth + organization tenancy).

## Local setup

### Prerequisites

- **Node 20.19+** (22 recommended)
- **Docker** (for local Postgres via Docker Compose)
- A Postmark account for deployed transactional email, or a local SMTP capture service for development

### 1. Install dependencies

```bash
npm install
```

### 2. Start local dependencies (Postgres)

Copy the example compose file to your own (gitignored, so you can tweak it) and bring it up:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

This runs Postgres on host port **5442** (not the default 5432, to avoid clashing with other
local databases). Data persists in a named Docker volume.

### 3. Configure environment

```bash
cp .env.example .env.local
```

`.env.local` is gitignored. Fill in:

- `DATABASE_URL` — already points at the local Postgres above.
- `BETTER_AUTH_SECRET` — generate at least 32 bytes of high-entropy secret material with
  `openssl rand -base64 32`.
- `BETTER_AUTH_URL` — keep the example value, `http://localhost:5173`, unless you deliberately
  run harnesst on another origin.
- `POSTMARK_SERVER_TOKEN` and `FROM_EMAIL` — a Postmark server token and verified sender used for
  password resets and Better Auth organization invitations. For local email capture, set
  `SMTP_URL` instead; development SMTP takes precedence over Postmark.

Authentication is self-hosted in the same Postgres database as harnesst. Better Auth exposes its
same-origin handler under `/api/auth/*`; there is no external auth dashboard or callback to
configure. Sign-in is email-first and password-second; sign-up asks only for name, email, and
password. Email verification does not gate ordinary signup or sign-in. Password resets use Better
Auth's single-use, one-hour tokens. Accepting an organization invitation is the one exception:
Better Auth requires the invitee to
verify the invited mailbox before its invitation-ID APIs will reveal or accept the invitation.

The checked-in auth setup was created with Better Auth's official `auth@1.6.23 init` flow. Do not
hand-edit `app/db/auth-schema.ts`; run `npm run auth:generate` to regenerate it from the final
Better Auth configuration, then use Drizzle to generate the application migration.

### 4. Run migrations

Apply the schema to your database:

```bash
npm run db:migrate
```

### 5. Start the dev server

```bash
npm run dev
```

The app is at `http://localhost:5173`. If you use another port or public origin, update
`BETTER_AUTH_URL` to that exact origin.

Visit `/signup` to create the first account. harnesst creates a personal workspace through Better
Auth's organization plugin and lands you on the workspace-scoped dashboard.

### 6. (Optional) Connect a GitHub repo

To use the Connect pillar (link an eve repo and view its config), register a **GitHub App**:

- Permissions: **Contents** (read/write), **Pull requests** (read/write).
- **Setup URL**: `http://localhost:5173/connect` (so installs redirect back into the app).
- **Callback URL**: `http://localhost:5173/github/installations/callback` (GitHub App OAuth).
- Generate a private key and note the App ID, slug, client id/secret.

Put the `GITHUB_APP_*` values into `.env.local` (see `.env.example`). Then from `/connect` you can
install the App, pick an eve repo, and view its parsed agent surface at `/projects/:id`. Until the App
is configured, `/connect` shows an "unconfigured" notice.

After upgrading an existing deployment, every GitHub installation must be reauthorized from
**Connect**. Legacy projects are mapped to harnesst's new opaque grant ids when possible, but all
repository operations fail closed until the signed-in GitHub user completes the OAuth proof.

## Common scripts

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `npm run dev`           | Dev server with HMR (port 5173)                     |
| `npm run build`         | Production build                                    |
| `npm run start`         | Serve the build with the token-safe RR/Express host |
| `npm run typecheck`     | Route typegen + `tsc`                               |
| `npm run auth:generate` | Regenerate Better Auth schema with its pinned CLI   |
| `npm run db:generate`   | Generate a SQL migration from `app/db/schema.ts`    |
| `npm run db:migrate`    | Apply pending migrations                            |
| `npm run db:push`       | Push schema directly (dev only, no migration file)  |
| `npm run db:studio`     | Open Drizzle Studio                                 |
| `npm run email:dev`     | Preview React Email templates on port 8092          |

## Project layout

```
eden/
├── app/
│   ├── routes/           # RR7 routes (home, dashboard, connect, projects.$id, auth)
│   ├── auth/             # Better Auth session + active-workspace resolution
│   ├── email/            # React Email templates + transactional senders
│   ├── db/               # Drizzle schema, server-only client, org-scoped queries
│   ├── github/           # GitHub App client + repo reads (Connect pillar)
│   ├── eve/              # pure eve-repo parser → normalized AgentConfig
│   ├── root.tsx          # root session loader + document shell
│   └── routes.ts         # route config
├── drizzle/              # generated SQL migrations
├── docker-compose.example.yml   # local deps (copy to docker-compose.yml)
├── docs/                 # ROADMAP.md · PRD.md · ARCHITECTURE.md
└── Dockerfile
```

## Deployment

**Self-hosting on a VPS is the supported production path.** Everything needed to reproduce a
working production install lives in [`deploy/vps/`](./deploy/vps/): a single runbook
([`deploy/vps/README.md`](./deploy/vps/README.md)) plus the compose, nginx, and env templates it
references. It's a complete, ordered sequence — firewall → Docker → the compose stack (harnesst +
Postgres) → containerized nginx + Let's Encrypt → GitHub App / Postmark wiring → smoke test. One
Linux box runs everything: harnesst, Postgres, and the agent instances it deploys.

**Two ways to run it:**

- **Hand it to your coding agent.** Give an agent (Claude Code or similar) SSH access to a fresh
  VPS and point it at `deploy/vps/README.md`. The runbook is written to be followed to the letter,
  so the agent can stand the whole thing up for you end-to-end. If you'd rather not give a coding
  agent SSH access to your server, don't — that's entirely your call.
- **Follow it yourself.** The exact same runbook is an ordinary step-by-step guide; nothing in it
  requires an agent.

**Before you start you'll need** a VPS (Ubuntu 24.04 LTS; 2 vCPU / 4 GB RAM / 40 GB disk minimum)
and a **domain you control**, with an A record pointing at the VPS — harnesst is served from that
domain, and external GitHub/Discord callbacks require it. (Ours is `harnesst.dev`; yours is
whatever domain you register and point at your box.) The runbook's first section lists the full
prerequisites, including Postmark, a GitHub App, and an Anthropic API key.

`npm run build` emits a standard Node server build under `build/` (client + server); the included
`Dockerfile` containerizes it with the Docker CLI the deploy target needs. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the managed-service infrastructure.

## License & ownership

Copyright © 2026 Aaron HS. harnesst is created and owned by Aaron HS.

Licensed under the [GNU Affero General Public License v3.0](./LICENSE) (AGPL-3.0).
