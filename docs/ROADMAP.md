# harnesst — Product Roadmap

The concise phasing view: what's shipped, what's in progress, and what's planned. This is
recorded retrospectively from the commit and PR history, so it stays honest about what actually
landed versus what was designed.

For the full product spec — personas, pillars, per-feature rationale, and the detailed phasing
with every "deliberately not built" note — see [`PRD.md`](./PRD.md) §11. For managed-service
infrastructure, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

**Legend:** ✅ shipped · 🚧 in progress · ⬜ planned

_Last updated: 2026-07-07._

---

## harnesst in one line

A web UI plus an embedded coding assistant over an [eve](https://github.com/vercel/eve) agent
repo, so **product managers** can author, ship, and operate agents without hand-writing code.
Open source and self-hostable, with an optional managed service. The eve repo stays the single
source of truth; harnesst is a projection and a control plane over it.

---

## Shipped

### Foundations & authoring — M0–M1

- ✅ **M0** — App skeleton (React Router 7 + Vite); Better Auth email/password authentication and
  tenancy on the organization plugin; GitHub App connect; eve-repo parser; read-only visualization
  of an agent's full config surface.
- ✅ **M1** — Structured editors for the whole agent surface; git-native write path
  (branch → commit → PR → merge); embedded coding assistant (agentic tool authoring on
  OpenRouter); secrets UI on the `SecretsProvider` seam; `eve init` new-repo scaffold;
  architectural seams + OSS reference implementations.

### Deploy, observe, manage — M2–M4

- ✅ **M2** — Deploy controller + `DeployTarget` seam; container + Postgres-World adapter;
  immutable **Releases** (commit SHA + image digest); fast rollback; weighted, session-sticky
  traffic splitter; environments; merge-triggers-deploy.
- ✅ **M3** — Run observability: authenticated telemetry ingest (BYO instances report runs back),
  per-agent run list, per-run transcript, compare-by-version, retention/redaction.
- ✅ **M4** — Managed commercial mode: credential pool + multi-tenant isolation,
  metering/plans/usage billing, governance (roles, audit log, spend limits).

### Breadth & product hardening — M5–M5.9

- ✅ **M5** — Additional deploy adapters, evals-as-gate, progressive-rollout primitive.
- ✅ **M5.5** — Agents schema split: `agents` under `projects`; releases/deployments/runs/
  schedules/drafts re-key per agent; per-agent environments + secret scope.
- ✅ **M5.6** — Deploy UX: single-live cutover invariant + one-click **Ship**
  (staged drafts → publish → merge → Release → cutover).
- ✅ **M5.7** — User-defined environments (create/rename/delete; equal peers; ≥1 invariant;
  total-but-explicit delete).
- ✅ **M5.8** — Two-level IA: repo vs. team-member URL levels; Deployment tab (Changes + Versions
  merged); Settings tab; full repo teardown.
- ✅ **M5.9** — Performance: stale-while-revalidate GitHub read cache (loaders read cached, actions
  read raw) + navigation feedback.

### Marketplace & runtime — M6–M6.2

- ✅ **M6** — Recruit / marketplace: traversal-safe template format (Zod `template.json` manifest)
  - first-party catalog + type-filtered browse; install/update/uninstall as change-sets with
    `harnesst-lock.json` provenance and semver dependency merge.
- ✅ **M6.1** — Real Docker sandboxes (ship the docker CLI client + mount the host socket, ending
  silent `just-bash` degradation); durable worlds keyed per **environment** — sessions and their
  `/workspace` filesystems survive redeploys.
- ✅ **M6.2** — Persistent environment setup plus structurally isolated per-conversation
  `/workspace/home` roots via an `EVE_DOCKER_PATH` shim and Docker volume subpaths; survives
  redeploys and restarts without exposing one conversation's artifacts to another.

### Teams, self-host, platform polish — M7–M8.5

- ✅ **M7** — Peer teams: `agents/*` monorepo convention, hierarchy-first UX, roster CRUD,
  team-fan-out Ship; runtime **teammate delegation** (`ask-teammate` via a harnesst relay,
  default-allow directed permissions, linked traces).
- ✅ **M8** — Self-host: single-VPS runbook — the supported OSS production topology (one Linux box
  runs harnesst, Postgres, and every agent instance). See [`../deploy/vps/README.md`](../deploy/vps/README.md).
- ✅ **M8.1** — Sandbox platform: prewarm fix (boot via `eve start`), `sandbox.ts` as a
  first-class editable surface, `HARNESST_SANDBOX_ENV` secret-exposure convention.
- ✅ **M8.2** — Catalog agents get capabilities from the terminal + sandbox-exposed secrets, not
  bespoke tools (Cloudflare App Builder + Deployment Engineer).
- ✅ **M8.3** — Models: OpenRouter end-to-end (provider-wired `agent.ts`, live catalog, workspace
  default model).
- ✅ **M8.4** — Secrets management rework (fetcher CRUD, fingerprints, install-time values,
  required-by-template surfacing, project-level shared secrets).
- ✅ **M8.5** — Playground: ChatGPT-style chat surface + human-in-the-loop (ask-question and tool
  approvals); sessions stored as eve cursors, streamed live, recorded as runs.

### Launch readiness — M9 (current)

The post-M8.5 work leading to the public open-source release:

- ✅ Team is the unit of deployment — repo-level ship + rollup (#5).
- ✅ Rename agents in place, preserving every artifact (environments, releases, secrets, drafts,
  containers, world DBs, home and world-data volumes) (#2).
- ✅ Deployment freshness — "Latest" vs. behind badges across deploy views (#3).
- ✅ Superseded-container cleanup after cutover — closes part of the M6.1 sandbox-GC punt (#8).
- ✅ Playground long-run recovery + clean stop control (#4).
- ✅ Marketing site — productivity-angle landing page, case studies, OSS/self-host positioning
  (#7); dashboard-aware CTA (#10); mobile responsive.
- ✅ Cornflower-blue brand identity + light/dark theme (#9).
- 🚧 **OSS release hygiene** — brand mark + favicon/apple-touch/OG image; SEO (robots.txt,
  sitemap, per-page meta + Open Graph/Twitter cards, `noindex` on authed app routes); docs reorg
  (this file); secrets audit; skills consolidated under `.agents/` with `.claude/` symlinks.
- 🚧 **LICENSE + open-core boundary** — pending decision (see Open source, below).

---

## Planned / future phases

Drawn from deliberately-punted items and the open questions in [`PRD.md`](./PRD.md) §12.

### Marketplace

- ⬜ Remaining install targets: **new standalone repo** and **subagent of an agent** (member +
  new-team-member are the shipped two).
- 🟡 **Connections** — install-time auth-brokered connectors (issue #30). Phase 1 ships the
  Google Sheets connector: the manifest's `auth` descriptor drives a harnesst-brokered OAuth flow in
  the install wizard, the grant is sealed in Postgres, and deploy injects it so eve's OpenAPI
  connection self-refreshes tokens. Follow-ups: user-scoped grants and more providers.
- 🟡 **Vercel deployment engineer** (issue #364) — gated `vercel-cli` tool, `vercel-issuer`
  agent minting project-scoped tokens behind human approval, and the `/api/secrets/deposit`
  route; see [`SPEC-VERCEL-DEPLOYMENT.md`](./SPEC-VERCEL-DEPLOYMENT.md). Phase 2 is the guided
  operator walkthrough.
- ⬜ Rung-2 **publish to marketplace** — extract a live-tested tool/agent into a catalog PR.
- ⬜ **Team templates** — a scaffold referencing agent templates plus a wiring spec.
- ⬜ Third-party template **trust & safety** (review/signing) before non-first-party publishing.

### Deploy targets

- ⬜ **Vercel** zero-config adapter (deprioritized behind VPS parity).
- ⬜ **Cloudflare** target (the probable next adapter after VPS).
- ⬜ Additional Worlds (Redis / Turso / Cloudflare).

### Runtime & sandbox

- ⬜ Per-destination sandbox **egress policy** (upstream; allow-all / deny-all only today).
- ⬜ Full sandbox-container **GC** on environment delete (partially closed by #8 and M6.2).
- ⬜ **eve-version adapter** layer to isolate beta churn; per-repo eve pinning UX.

### Teams / delegation

- ⬜ Multi-turn teammate conversations, approval gates across a delegation chain,
  wake-on-delegation for stopped instances, cross-repo delegation, chain-depth tracking.

### Observability & managed

- ⬜ Repo-level all-runs rollup; per-member assistant transcripts.
- ⬜ Off-Vercel observability parity (Workflow event log + OTel).
- ⬜ Managed multi-tenant security hardening; evals-as-gate UI; alerting; SSO at scale.

### Open source

- ⬜ Choose a **LICENSE** and define the open-core boundary (OSS core vs. managed service).
- ⬜ Contribution docs — `CONTRIBUTING.md`, code of conduct, issue templates.

---

## Where the detail lives

- **Per-milestone rationale + "deliberately not built" notes:** [`PRD.md`](./PRD.md) §11 (Phasing).
- **Open questions & risks:** [`PRD.md`](./PRD.md) §12.
- **Managed-service infrastructure:** [`ARCHITECTURE.md`](./ARCHITECTURE.md).
