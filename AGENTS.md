# harnesst

A web app for building, managing, and deploying [eve](https://github.com/vercel/eve) agents
without hand-writing code — a guided UI plus an embedded coding assistant over an eve repo.
Open source and self-hostable.

**Stack:** React Router 7 (framework mode, SSR) · TypeScript · Tailwind 4 · Drizzle + Postgres ·
Better Auth (email/password auth + organization tenancy) · Docker.

**Repo layout:**

- `app/` — the React Router app (routes, components, db, business logic)
- `drizzle/` — schema and migrations
- `catalog/` — agent catalog + validation/index scripts
- `docs/` — `ROADMAP.md`, `PRD.md`, `ARCHITECTURE.md`
- `deploy/` — deployment configs
- `tests/` — tests (vitest)

**Deployment:** control plane runs as a Docker container; agent instances are deployed one-per-agent
as Docker containers on a VPS. See `docs/ARCHITECTURE.md`.
