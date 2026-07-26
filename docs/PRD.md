# harnesst — Product Requirements Document

> **harnesst** — a companion to Vercel's **eve**.
> **Status:** Draft v0.2 · **Owner:** asiraky@gmail.com · **Last updated:** 2026-07-04

---

## 1. Summary

**harnesst is a web application for building, managing, and deploying [eve](https://github.com/vercel/eve) agents without writing code by hand.**

eve is Vercel's open-source, filesystem-first framework for durable AI agents: every agent is a
directory of files (`instructions.md`, `tools/*.ts`, `skills/*`, `subagents/*`, `channels/*`,
`schedules/*`, `connections/*`, `agent.ts`) that eve compiles into a portable Nitro application.
It is powerful, but authoring an agent today means a developer opening a GitHub repo and editing
TypeScript and Markdown by hand. Product managers — the people who actually know what the agent
should _do_ — cannot participate directly.

harnesst closes that gap. It is a structured, opinionated web interface over an eve repository plus an
embedded coding assistant, so a non-developer can:

1. **Connect or create** the eve project (via a GitHub App) and initialize it.
2. **Author every part of an eve agent** through the UI — including generating the TypeScript for
   tools with the help of an in-app coding agent.
3. **Publish it** — one explicit action that checks and builds the saved changes, lands them as
   one commit on the default branch, cuts a version, and **deploys** it to a running instance —
   with the option for harnesst to fully host and operate that instance on the customer's behalf.

harnesst ships as an **open-source product anyone can self-host**, and as a **commercial managed
service** where harnesst runs the infrastructure, meters usage, and bills the customer. Both are the
same product over the same seam; the managed service is the OSS product plus a managed credential
pool, metering, and billing.

---

## 2. Problem & opportunity

- **eve's authoring surface is developer-only.** Even the "no code" parts (instructions, skills)
  live in a git repo; the genuinely-code parts (tools are TypeScript with Zod schemas, `agent.ts`
  config, connections) are out of reach for PMs. Vercel's own blog notes non-technical teams built
  agents — but only _with_ engineering support. harnesst removes the engineering dependency.
- **The full capability of eve is never exposed in one place.** There is no visual, guided way to
  see and configure an agent's model, tools, skills, subagents, channels, schedules, approvals,
  connections, secrets, and evals together.
- **Deployment and lifecycle are manual.** Getting an eve app running, wiring its stateful
  dependencies (a Workflow "World" store, a sandbox backend, model keys), and re-deploying on change
  is devops work. PMs want a button.
- **Commercial gap.** eve is free and open. There is room for a managed "we run it for you" offering
  where the customer never touches infrastructure — the classic OSS-core + hosted-service model.

---

## 3. Goals & non-goals

### Goals

- Expose **100% of eve's agent-configuration surface** through a web UI, backed by real files in a
  git repo (eve's source of truth).
- Let a PM **create a working, deployed agent end-to-end** without hand-writing code, including
  AI-assisted authoring of TypeScript tools.
- Keep change management **git-backed**: every save is a whole-file draft over the repo, and
  Publish lands the whole set as one commit on the default branch. The repo stays the source of
  truth, and history, rollback, and CI come for free.
- Provide **one-click deployment and lifecycle management** for one or many instances of an agent,
  via a pluggable `DeployTarget` adapter. Default target is a **portable container image + Postgres
  Workflow World**.
- Offer a **managed commercial mode** (v1): harnesst owns the infra, meters usage, and bills the customer.
- Keep the whole thing **self-hostable and open source**.

### Non-goals (for v1)

- Being an eve _replacement_ or a general low-code app builder. harnesst authors eve projects; it does
  not invent a new agent runtime.
- A visual node-graph / flowchart builder for agent logic. eve's model is files + an LLM loop, not a
  DAG; harnesst mirrors that.
- Supporting non-eve agent frameworks.
- Building our own model-hosting/inference. We use provider keys / AI Gateway.

---

## 4. Users & personas

| Persona                       | Needs from harnesst                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Product Manager (primary)** | Create and iterate on agents: instructions, tools, skills, schedules, channels. Uses the assistant to generate tool code. Ships via a review flow. Cannot write TypeScript.    |
| **Engineer / Platform owner** | Reviews the PRs harnesst opens, owns secrets and connections, approves risky tools, self-hosts harnesst or manages the managed-service account. Wants git to stay the source of truth. |
| **Ops / Admin**               | Manages members, deployment targets, billing (managed mode), environment/secret governance, and approval policies.                                                             |

---

## 5. Background: the eve substrate harnesst must fully expose

harnesst's UI is a faithful, guided editor over these eve concepts. This inventory _is_ the config
surface harnesst must cover.

| eve concept            | File / API                                                                                                                                                                                                                 | What harnesst must let a PM do                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime config**     | `agent/agent.ts` → `defineAgent({ model, ... })`                                                                                                                                                                           | Pick model (provider-prefixed string, e.g. `anthropic/claude-sonnet-5`), set runtime options, thinking level, etc. via forms.                                                                                         |
| **Instructions**       | `agent/instructions.md`                                                                                                                                                                                                    | Rich Markdown editor for the always-on system prompt, with assistant help and templates.                                                                                                                              |
| **Tools**              | `agent/tools/*.ts` → `defineTool({ description, inputSchema (Zod), execute, needsApproval, outputSchema, toModelOutput })`                                                                                                 | Create/edit tools. The **assistant generates the TypeScript**; PM edits description, inputs, approval policy in a form; test-run in a sandbox.                                                                        |
| **Skills**             | `agent/skills/*` (Markdown playbooks; installable via skills CLI)                                                                                                                                                          | Author/import on-demand skill docs.                                                                                                                                                                                   |
| **Subagents**          | `agent/subagents/*` (own config) + built-in `agent` tool                                                                                                                                                                   | Define specialist child agents with their own model/instructions/tools.                                                                                                                                               |
| **Channels**           | `agent/channels/*` (HTTP, Slack, Discord, Teams, web, CLI)                                                                                                                                                                 | Enable/configure entry points; manage route-auth secrets; preview web chat.                                                                                                                                           |
| **Connections**        | `agent/connections/*` (typed external integrations)                                                                                                                                                                        | Configure typed integrations + credentials (paired with Vercel Connect on Vercel, or generic creds off-Vercel).                                                                                                       |
| **Schedules**          | `agent/schedules/*` (crons)                                                                                                                                                                                                | Create recurring jobs (daily report, weekly digest) with a cron UI.                                                                                                                                                   |
| **Sandbox**            | `agent/sandbox/*` / `defineSandbox()`; `defaultBackend()` local vs Vercel Sandbox                                                                                                                                          | Choose/configure the sandbox backend (needed both for authored tools and for our own tool test-runs).                                                                                                                 |
| **Approvals / HITL**   | `needsApproval` on tools (`always()`, `once()`, predicates)                                                                                                                                                                | Toggle and configure human-approval gating per tool.                                                                                                                                                                  |
| **Evals**              | TypeScript eval suites, run locally or vs deployed                                                                                                                                                                         | Author scored checks; run as a deploy gate (later phase for full UI).                                                                                                                                                 |
| **Env vars / secrets** | project environment variables                                                                                                                                                                                              | Manage secrets per environment (user-defined, M5.7) with encryption and scoping.                                                                                                                                      |
| **Observability**      | Agent Runs (Vercel) / OpenTelemetry via `instrumentation.ts` + the Workflow event log                                                                                                                                      | **First-class pillar (§7.6):** per-agent, per-run transcript + metrics dashboard (inputs, model/tool calls, outputs, errors, tokens, wall-clock). harnesst supplies its own runs store/UI on every host, not just Vercel. |
| **Build/runtime**      | `eve build` → `.eve/` (compiled artifacts) + `.output/` (Nitro host); runtime = **Nitro + Workflow SDK**; durability via **Workflow "Worlds"** (Local dev, **Postgres** reference, community Redis/Mongo/Turso/Cloudflare) | harnesst drives build + deploy and wires the Workflow World, sandbox backend, and model keys.                                                                                                                             |

**Key portability fact (validated against source):** `eve build` emits a standard **Nitro
`.output/`** deployable via Nitro presets to _any_ supported host. Durability is the open-source
**Workflow SDK**, whose **Worlds** adapter system (event log + compute + queue) has a **Postgres**
reference implementation for self-hosting and a **Local World** for dev. The sandbox and model layer
are likewise adapters (local bash/Docker sandbox; direct provider keys off-Vercel). **eve is not
Vercel-locked** — off-Vercel you supply three things: a Workflow World store, a sandbox backend, and
model keys. This is the foundation of harnesst's deployment design.

---

## 6. Product pillars

harnesst has seven pillars. v1 delivers the first five; **Recruit** and **Teams** follow (§11).

1. **Connect** — GitHub App integration: create a new eve repo or connect an existing one; run
   `eve init`; detect and parse the agent structure.
2. **Author** — the full visual config surface of §5, backed by files, with an embedded **Pi-based
   coding assistant** that writes/edits the code parts (tools, connections, `agent.ts`) for PMs.
3. **Review & version** — edits accumulate as **saved drafts** in one shared staging area; the
   publish panel shows every change with a diff, and **Publish** is the ship signal (Save &
   Publish cutover, M8.6).
4. **Deploy & operate** — one-click deploy through a `DeployTarget` adapter (default: container +
   Postgres World); manage multiple instances/environments; **managed mode** where harnesst runs it and
   bills usage.
5. **Observe** — first-class run observability: for every agent, browse every execution and open the
   **full transcript** — the triggering input, each model call and tool call (with inputs, outputs,
   and errors), the final answer, plus tokens, wall-clock time, and execution context.
6. **Recruit** — a **marketplace of templates** at every level of the hierarchy (tools, skills,
   subagents, whole agents): browse, click install, answer an onboarding wizard (secrets,
   connections), and the item lands in your repo as a normal reviewable change-set. Templates are a
   shortcut for creation, not a new runtime concept.
7. **Teams** — model an **organisation**, not just an agent: a team of top-level eve agents
   (PM, designer, developers, QA, deployer) living in one **monorepo by convention**, each with its
   own channels, schedules, credentials, Releases, and run history — auto-wired by harnesst so
   teammates can delegate to each other.

---

## 7. Pillar detail

### 7.1 Connect — GitHub App & repo lifecycle

- **GitHub App** (not just OAuth) so harnesst can create repos, read/write files, open PRs, manage
  branches, and receive webhooks on the user's behalf, scoped to selected repos.
- **Two entry paths:**
  - _Create new:_ harnesst creates a repo and scaffolds it by running the equivalent of
    `npx eve@latest init` (an eve project skeleton), commits the initial structure.
  - _Connect existing:_ point harnesst at an existing eve repo; harnesst validates it is an eve project
    (`agent/` present), parses the manifest, and hydrates the UI from the files.
- **Repo model = source of truth.** harnesst never keeps a divergent copy of agent config; it reads and
  writes the files. UI state is a projection of the repo (plus in-flight, uncommitted edits on a
  working branch).
- **Detection & sync:** webhooks keep harnesst in sync when the repo changes outside harnesst (an engineer
  edits a tool directly). Conflicts surface in the UI.

### 7.2 Author — visual config + embedded coding assistant

**Structured editors** for each eve concept in §5 (forms for `agent.ts`/approvals/schedules/channels;
Markdown editors for instructions/skills; a code view for tools/connections).

**Embedded authoring assistant (Pi SDK).** Built by embedding
[`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)
as a library — _not_ eve. Rationale: harnesst itself is a normal web app, not an eve runtime; Pi's SDK
(`createAgentSession`, custom `defineTool` tools, streaming events, model registry, in-memory or
persisted sessions) is designed exactly for embedding an agent inside your own app.

The assistant:

- **Writes and edits tool TypeScript** from a PM's natural-language description ("a tool that looks up
  an order by ID in our Postgres and returns status"), producing a valid `defineTool(...)` file with a
  Zod `inputSchema`, description, and `execute` body — then explains it in plain language.
- **Operates on a workspace bound to the working branch** (Pi's built-in `read`/`write`/`edit`/`bash`
  tools scoped to a checkout/sandbox of the repo), so its edits become part of the same PR.
- **Helps configure everything else**: drafts instructions, proposes skills, wires connections and
  the env vars/secrets a tool needs, and can run the tool in a sandbox to validate.
- **Is scoped and safe**: custom harnesst tools (via Pi's `customTools`) expose only repo-authoring and
  sandbox-test actions; destructive/host actions are excluded. Model + keys come from harnesst config.

> **Decision (revised 2026-07-02):** v1 ships a **Claude-API generator** (stateless: describe →
> generated `defineTool` file → lands on the working branch via the normal PR flow) behind an
> `AuthoringAssistant` seam, with a Pi adapter stubbed next to it. The full **Pi SDK live session**
> (persistent workspace bound to a working-branch checkout, streaming read/write/edit/bash) remains
> the target for the richer experience but depends on the workspace-checkout spike (§12) — it slots
> in behind the same seam without touching the editors.

**Secrets & env vars UI:** when a tool or connection needs a secret, the assistant references it by
name; the PM sets the value in harnesst's secrets manager (per environment), never in code. Values are
encrypted at rest and injected at deploy time.

### 7.3 Review & version — Save & Publish (revised, M8.6 / issue #225)

- All harnesst edits (form changes and assistant code changes) land as **saved drafts** in one shared
  staging area — every editor has a Save button, and an assistant turn saves its file diff the
  same way. Saving never touches git.
- **Publish = ship.** One button in the workspace header shows every pending change (diff, owning
  member, who saved it), then runs the pipeline: **check → build → commit → version → deploy**.
  A failed build means nothing lands — the drafts stay saved, and the failure names the step and
  the member and shows the compiler's own output.
- The commit is one compare-and-swap fast-forward onto the default branch; the commit history
  **is** the audit trail. harnesst authors no branches and no pull requests. Developers can still
  push or merge PRs directly on GitHub — harnesst cuts Releases for merges to the default branch via
  webhook (and never auto-deploys them).
- Benefits inherited for free: history, blame, rollback (§7.7), and CI hooks (evals as a gate —
  later phase).

### 7.4 Deploy & operate — `DeployTarget` adapter

**Build:** at publish, harnesst builds the staged tree **before** the commit lands (nothing broken
ever reaches the default branch) — `eve build` produces `.eve/` + the Nitro `.output/`, packaged
as a **container image** of the host; the deploy step reuses that image rather than rebuilding.

**`DeployTarget` adapter interface** — one seam, multiple providers. Each adapter knows how to:

1. take the built image/output,
2. ensure the three stateful dependencies exist — a **Workflow World** (default **Postgres**), a
   **sandbox backend**, and **model API keys / gateway** —
3. deploy/replace the running instance, and
4. report health, logs, and runs.

**Default target (v1): Container + Postgres World.** Build a Docker image of `.output/`, run it on a
generic container host (Fly/Railway/Cloudflare/VPS/our cloud) with a Postgres Workflow World and a
sandbox backend. This is the portable path and underpins both OSS-BYO and managed modes.

**Credential-ownership models over the same adapter:**

- **BYO (OSS / self-host):** customer connects their host + their Postgres + their model keys. The
  instance runs in _their_ account; they pay their providers. harnesst orchestrates.
- **Managed (commercial, v1):** _harnesst_ owns the host, the Postgres World, the sandbox, and pays the
  bills; the customer never picks a provider. harnesst meters usage and bills the customer (§8).

**Other targets behind the seam (later):** a **Vercel** adapter (zero-config: Workflows store,
Vercel Sandbox, AI Gateway auto-wire) and additional Worlds (Redis/Turso/Cloudflare).

**Instance & environment management:**

- **Environments are user-defined and per-agent (M5.7).** A new member starts with exactly ONE,
  named `default` — the user renames it and creates/deletes others as their workflow demands
  (someone who wants dev/staging/production makes them; nothing is imposed). harnesst enforces one
  invariant: a member always has at least one environment. Environments render as equal peers
  everywhere; the member's first (creation order) is only the _mechanical_ default the Ship
  dialog preselects — no environment name or position is special in the UI. Deleting an
  environment always works
  behind an explicit confirm: it stops anything running there, tears down instance state, and
  permanently removes that environment's deployment history and env-scoped secrets (agent-wide
  secrets and Releases are untouched).
- Multiple **instances/deployments** (e.g. per customer, per region) from one agent codebase.
- Per-instance: status, logs, runs/observability, secrets, scaling knobs, start/stop, rollback,
  and the channel endpoints (HTTP URL, Slack install, cron status).

**Deploy UX (M5.6/M5.7, revised by M8.6) — Publish and Deploy.** Two verbs cover the whole
deploy surface for a PM: _Publish makes versions; Deploy places them._ A version is **running on**
zero or more environments (never globally "live" — with peer environments there is no single
live slot); each environment runs exactly one version.

- **Publish** — the one action, in the workspace header on every back-of-house page (§7.3): every
  saved draft goes through check → build → commit → version → **cutover deploy** into the
  project's live environment — the current version keeps serving until the new one is healthy.
  The environment is asked at most once (single-env projects never ask; the answer persists as
  `liveEnvironmentName`). The pipeline's five steps render live in the publish panel and, in
  compact form, in the header control; a failed step names the member, shows the error, and
  leaves nothing landed. With nothing saved, Publish deploys HEAD.
- **Deploy** — the **Deployment** tab is the advanced, mostly read-only surface: environments as
  equal rows (each: running version, in-flight progress, latest failure with retry,
  rename/delete) over version history, whose rows are badged with the environment names they run
  on. Any version — new or old — deploys to any environment in one confirmed click (image
  reused — seconds, no rebuild), replacing that environment's current version on health. Deploy
  is deliberately direction-neutral: **Roll back** — a primary action in version history — is
  just deploying an older version again.

### 7.5 Managed commercial offering (v1)

The managed mode turns harnesst into a hosted service:

- **Managed credential pool:** harnesst-owned provider accounts/infra; customers deploy without bringing
  cloud accounts.
- **Multi-tenancy & isolation:** each customer's instances run isolated (separate namespaces/DBs;
  sandbox isolation per eve's model).
- **Metering:** capture requests, compute-seconds, sandbox usage, and model tokens per instance.
- **Billing:** plans + usage-based billing (Stripe or similar); harnesst pays providers, marks up.
- **Governance:** org/team/roles, SSO (later), audit log, approval policies, spend limits.

### 7.6 Observe — run observability

Observability is a primary reason teams can trust an agent in production. harnesst must let anyone open
**any agent** and inspect **any execution** of it in full. This works on **every deploy target**
(managed and BYO/self-host), not just Vercel's Agent Runs.

**The unit of observation.** A **Session** is a durable conversation/task; each triggering input
(user message, HTTP request, channel event, or a scheduled cron) creates a **Run** (one turn:
input → agent loop → final output). A Run contains an ordered list of **steps**: model calls, tool
calls, reasoning, and messages. The dashboard is: _Agent → its Runs → drill into one Run's transcript._

**Per-Run summary (the list/overview view)** — scannable without opening the transcript:

- trigger/source (channel, cron, HTTP), start time, **wall-clock duration**,
- **status** (success / error) and error surface,
- **tokens** (input / output / total) and estimated cost,
- model(s) used, **# tool calls**, **# tool errors**,
- the **agent version** it ran against (git commit / build id — see below).

**Per-Run transcript (the detail view)** — progressive disclosure so it isn't overwhelming:

- the **user/input prompt** for that run (runtime data — always recorded),
- an ordered timeline of steps, each collapsible:
  - **model calls:** the messages sent, the assistant output/reasoning, tokens, latency, model,
  - **tool calls:** tool name, **input arguments**, **output/result**, **error** (if any),
    duration, and whether it hit an approval gate,
- final answer, and links to any **subagent** runs spawned during the turn.

**System prompt — link, don't (only) snapshot.** Each Run records the **deployed agent version**
(git commit SHA / build id) it executed under. Because `instructions.md`, tools, and skills all live
in the repo, harnesst reconstructs the exact **system prompt at run time by linking to that commit** —
no need to duplicate it in the telemetry store (resolving the user's open question). harnesst _may_ also
snapshot the resolved system prompt for convenience/immutability, but the versioned source is the
source of truth. The **user input**, tool I/O, tokens, and timing are runtime data and _are_ recorded.

**Where the data comes from.** Two complementary sources (see ARCHITECTURE §3.7): eve's
**OpenTelemetry** AI-SDK spans (via `agent/instrumentation.ts`) give tokens, model, latency, and
model/tool I/O; the **Workflow event log** (in Postgres) is the durable, replayable record of every
turn and step. harnesst ingests both into its own runs store and renders the UI.

**Cross-cutting requirements:** works for **BYO** deploys by shipping telemetry from the customer's
instance to harnesst's collector over an authenticated OTLP endpoint; **tenant-isolated** in managed
mode; **access-controlled** by active Better Auth organization membership (transcripts contain
sensitive prompt/response data);
**retention + redaction** controls; and the deployer-disclosure note eve already flags. Token counts
here relate to but are distinct from **billing metering** (§7.5): the model gateway is the billing
source of truth; observability is the per-run detail view.

### 7.7 Version & release

eve has **no built-in agent-versioning primitive** (validated against source): it is git-native
(`init` initializes git) and relies on **immutable deployments**. harnesst builds a thin product layer
over that — it does _not_ invent a parallel versioning system.

**A Release = an immutable build of an agent at a git commit.** Because every publish lands one
commit on the default branch, the **publish commit SHA is the canonical, immutable version
identity**, and the container image built from it is content-addressed. Immutability is therefore
inherited from git + image digests, not engineered. A Release carries: a friendly label
(auto-incremented `v1, v2, …` / release #N), the commit SHA, the image digest, the commit's
changelog, author, and timestamp. Environments/deployments point at a Release.

**Why it matters (three payoffs):**

1. **Observability linkage.** Every Run is tagged with its Release/commit (§7.6). A run from two weeks
   ago reconstructs its _exact_ system prompt, tools, and skills from the repo at that commit —
   immutable versioning is what makes the observability system-prompt link truthful.
2. **Safe iteration / rollback.** _Roll back_ re-points an environment at a previous Release (its
   image is retained) — near-instant, no rebuild, direction-neutral. PMs can be cavalier because
   rollback is one click; there is no per-change undo machinery, because a failed build never
   lands in the first place (§7.3).
3. **Run multiple versions at once (data-plane primitive; product surface deferred in M5.6).** The
   deploy plane can run **more than one Release of the same agent concurrently** behind a
   **weighted, session-sticky traffic splitter** at ingress (a conversation stays pinned to one
   version for its lifetime). **Revised (M5.6):** the _product_ model is now **one live Release per
   environment** — a deploy is a clean cutover that demotes whatever else was live once the new
   instance is healthy, and the weights/split UI is removed. In practice, surfacing N-live as the
   default outcome of ordinary deploys confused users (environments silently accumulated live
   versions) without a clear multi-version product story to justify it. The splitter,
   `trafficWeight`, and the concurrent-deployments data model are all retained, so the primitive
   can return behind a deliberate surface (progressive rollout, explicit A/B) when that story
   exists.

**"A/B" is emergent, not a first-class feature.** harnesst deliberately does **not** build an automated
experimentation framework — no thumbs UI, no eval-gated winner selection, no auto-rollout engine in
v1. The product gives PMs (a) **per-version telemetry** (Runs are already version-tagged, so
observability groups/filters/compares by Release) and (b) one-click movement between versions.
While single-live is in effect (M5.6), "compare versions" means telemetry across sequential
deploys; concurrent-version comparison returns with the multi-version surface. Progressive/auto
rollout can come later as a policy on top of the splitter + per-version metrics, but it is not
required for the value.

**Immutability caveat:** a Release pins everything _in the repo_ (config, tools, skills, instructions)
but **not secrets/env vars**, which live outside git and change independently. For faithful
"what ran then" we version secret _metadata/generation_ (never values), and note that a Release is
code+config, not full runtime state.

### 7.8 Recruit — the marketplace

Building a capable agent from scratch is laborious — a Cloudflare deployer needs a dozen carefully
written tools, skills, and connection wiring before it does anything useful. The marketplace removes
that cost: **pre-built, expert-authored templates a customer instantiates instead of authoring**.
"Recruit this agent into your team" is the product moment.

**Templates exist at every level of the hierarchy** — turtles all the way down, mirroring eve's own
composition model:

| Template type | Installs into                                                                                                                     | Example                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Tool**      | an existing agent's `tools/`                                                                                                      | `cloudflare_deploy_worker` — a `defineTool` with Zod schema + execute body  |
| **Skill**     | an existing agent's `skills/`                                                                                                     | "Writing a PRD" playbook                                                    |
| **Subagent**  | an existing agent's `subagents/`                                                                                                  | a code-review specialist invoked by a developer agent                       |
| **Agent**     | a **new top-level agent** (new single-agent repo, or a new member of a team monorepo — §7.9) _or_ a subagent of an existing agent | "Cloudflare Deployment Engineer" — instructions + tools + skills, pre-wired |

**A template = files + a manifest.** The manifest (`template.json`) declares: name, type, version,
description, the **file list**, **npm dependencies**, **required secrets** (by name), **required
connections**, suggested model, and the eve version range it targets. No new runtime concept
exists — a template is a shortcut for creating the same files a customer could author by hand.

**Dependencies are npm-resolvable, full stop.** Every agent is already a complete npm project
(scaffold ships a per-agent `package.json`; teams are npm workspaces) and every release build runs
`npm install` in the image build — so anything in the target's `package.json` at publish time is
present at runtime. Template dependencies ride that machinery in two tiers:

- **Light (in-repo files):** multi-file templates land under a directory the template _owns_
  (namespaced by template id, e.g. `tools/cloudflare-ci/…`) — collisions are impossible and the
  lock file knows exactly which files are whose. The manifest's `dependencies` map is applied as a
  deterministic JSON-merge into the target agent's `package.json` — one more reviewable file in
  the install change-set. Conflict policy: if the target already has a package and the ranges
  intersect, keep the existing (no diff churn); if disjoint, the wizard surfaces it pre-change-set
  and a human decides.
- **Heavy (npm package):** substantial logic ships as a published npm package
  (e.g. `@eve/marketplace-cloudflare-ci`); the template's tool file is a thin `defineTool` wrapper
  importing it. Versioning, transitive deps, and updates ride npm; "update available" becomes a
  one-line semver bump. Catalog authoring convention: anything past ~200 lines goes here.

System-level dependencies (apt packages, non-npm binaries) are **out of scope** — templates run in
the standard eve runtime image and may not mutate it. Most infra CLIs (wrangler included) are npm
packages, so the realistic cases fit tier one. Uninstall removes the template's files but _leaves_
npm packages (they may be shared with hand-written code); the uninstall's saved changes list them
so the user can prune.

**Install = saved changes.** Installing an item:

1. harnesst materializes the template's files into the right location as **saved drafts** (the normal
   §7.3 flow — visible in the publish panel, history and rollback for free).
2. An **onboarding wizard** walks the customer through the manifest's requirements: "this agent
   needs `CLOUDFLARE_API_TOKEN` — set it now." Secret _values_ go to the secrets store (§7.2), never
   the repo; the wizard creates the per-environment placeholders.
3. Publish ships the install like any other edit.

For agent templates the wizard first asks the **install target**: _new top-level agent_ or
_subagent of an existing agent_. This one question is how customers choose between the two team
fidelities in §7.9 — no separate "team builder" needed for the simple case.

**After install it's just a regular agent.** The customer edits its instructions, removes tools,
adds skills — the template was a starting point, not a subscription. Files are theirs.

**Update-from-source (provenance).** Each install is recorded in a repo-root **`harnesst-lock.json`**
(generalizing the existing `skills-lock.json` pattern): source registry, template id, version,
content hash. When the upstream template publishes a new version, harnesst shows "update available";
accepting opens a **PR with the diff**. If the customer has locally modified the installed files,
the PR surfaces the conflict and a human resolves it in review — git review _is_ the merge
machinery; harnesst does not build three-way merge tooling.

**Distribution — the catalog lives in the eve repo.** v1 is a **first-party curated catalog**: a
`marketplace/` directory inside the eve OSS repo (owner decision — no separate repo), laid out as
`marketplace/templates/{tools,skills,subagents,agents}/<id>/` with each template's `template.json`

- files. Templates are **not built artifacts** — the only compilation ever happens in the
  customer's repo at install time — so the catalog's CI _validates and indexes_ instead of building:
  schema-check every manifest, typecheck each template against its declared eve range, verify the
  manifest file list matches the directory, enforce a version bump when contents change, and
  regenerate a root **`marketplace/index.json`** (id, type, version, description, content hash).
  harnesst consumes _only_ that index for browse (one cached fetch, no tree walk) and reads a template's
  subtree at install time. The catalog location is a **config pointer** (repo + path + ref) behind a
  `CatalogSource` seam, which also defines what a registry _is_ — a repo with this layout and an
  index — so third-party registries later are the same shape with a different pointer. Publishing
  policy, trust/review, and revenue share stay out of scope for v1 (§12).

**Authoring is back-of-house, gated by CI — no harnesst feature required.** Creating a template is a
coding-agent session (or human PR) in the eve repo: a scaffold script stamps the directory
convention, the JSON schema makes the manifest checkable, and catalog CI is the gatekeeper —
curation is literally code review. The contribution ladder has two rungs: rung 1 (now), outsiders
PR the catalog and CI + review gate it; rung 2 (later), an in-product **"publish to marketplace"**
flow extracts a customer's live-tested tool/agent from their harnesst workspace, generates the manifest
from what harnesst already knows (secrets referenced, deps, eve version), and opens the catalog PR.

**Team templates are deliberately _not_ in the marketplace v1.** A team is a harnesst-level construct
(§7.9); once agent templates and the monorepo convention exist, a team template is trivially a
scaffold referencing agent templates plus a wiring spec — it can come later without redesign.

### 7.9 Teams — modelling an organisation

The end-state vision: a customer models their **organisation**, not just an agent — a product
manager that writes PRDs on a Monday-morning cron, a developer that builds and pushes to GitHub, a
QA tester, a deployer holding Cloudflare credentials. Each role has its own tools, skills,
schedules, channels, and audit trail.

**Two team fidelities — both supported, deliberately different products:**

1. **Subagent team (v0):** one top-level agent (the "lead") with role-specialists installed as
   eve subagents. eve-native, one runtime, one deployment, orchestration via the built-in `agent`
   tool. Cheap and immediate — but subagents **cannot have their own channels or schedules**, and
   cannot be independently versioned, deployed, or observed. Right when only the lead talks to the
   outside world.
2. **Peer team (the real thing):** multiple **top-level eve agents in one repo**. Each teammate has
   its own channels (the PM sits in its own Slack channel), its own crons, its own secrets scope,
   its own Releases and run history. This is what "model an organisation" actually requires — the
   examples above all want top-level-agent properties. Peers, not a hierarchy.

The cost objection to N runtimes is already answered by our own architecture: **compute ⟂ state and
scale-to-zero** (ARCHITECTURE §2.3–2.4) mean an idle teammate is a _stopped container_ — ~zero
CPU/RAM. A five-agent team is five mostly-sleeping containers, not five machines. Density comes from
concurrent _active_ turns, and a team's members are idle almost always.

**Monorepo convention (convention over discovery).** A repo is either a single agent or a team,
detected structurally — no dynamic configuration:

```
repo/                          repo/
  agent/            (single)     agents/                      (team)
  package.json                     product-manager/   ← complete eve project
                                     agent/ …  package.json
                                   developer/
                                   deployer/
                                 packages/shared/   ← optional shared code (npm workspaces)
                                 harnesst.json          ← optional: team name, roster metadata
```

- `agent/` at the repo root → **single-agent mode** (today's behavior, unchanged).
- `agents/*/agent/` → **team mode**; each subdirectory is a complete, independently buildable eve
  project. `harnesst.json` is metadata only (team name, display order) — never required for discovery.
- Each teammate builds independently: `eve build` in its directory → its own image → its own
  Release → its own instance container. **Multiple runtimes, one repo.**
- A single-agent repo is just a team of one; the UI stays simple for the common case.

**One repo, atomic team changes.** Because the team shares a repo, a single PR can change multiple
teammates **atomically** — "PM now hands the developer a structured ticket; developer expects that
format" ships as one reviewable change-set. This is the core argument for team-in-one-repo over
team-as-N-repos.

**Teammate wiring — what makes it a _team_, not a folder of agents.** eve exposes a stable HTTP
contract per agent (`POST /eve/v1/session` + stream). When harnesst knows two agents are teammates, it
**auto-generates a delegation tool in each** — a `defineTool` (e.g. `ask_developer(...)`) that calls
the peer's channel endpoint, with the route-auth secret injected from the secrets store and the
peer's role description baked into the tool description so the model knows when to delegate. harnesst
generates and keeps these tools in sync as the roster changes.

**Cross-agent observability.** Every delegation carries a **correlation id**, so a task that flows
PM → developer → deployer renders as **one linked trace** across the teammates' run transcripts
(§7.6). This is a genuinely differentiated capability over raw eve.

**"Team" is a harnesst construct, not an eve construct.** eve knows nothing about teams; the repo
convention, the roster, the generated delegation tools, and the linked traces are all harnesst's product
layer. In harnesst's data model this introduces an **`agents` entity between `projects` and everything
downstream** — releases, deployments, runs, schedules, and drafts key by _agent_, not project.

> **Decision (2026-07-04): teams are a hard commitment, and the schema lands now.** The
> `projects → agents` split is not deferred to the Teams milestone — it lands **pre-emptively,
> while production data is small**, with every existing single-agent repo migrating as a team of
> one. All new features from this point key by _agent_, never by project, so nothing built in the
> interim deepens the migration.

> **Decision (2026-07-04): environments and secrets scope per agent, for security.** Each team
> member has its own environments and its own secret scope — the deployer holds
> `CLOUDFLARE_API_TOKEN`; the PM agent cannot see it. Least privilege is the point of modelling
> roles as separate agents, and per-project scoping would silently grant every teammate every
> credential. Members deploy independently, so their environments are independent too.
> Single-agent repos are unaffected (a team of one scopes identically to today). Workspace-level
> defaults (e.g. the OpenRouter key, §12) still cascade: workspace → agent-environment override.

---

## 8. System architecture (high level)

```
                    ┌────────────────────────────────────────────┐
                    │               harnesst Web App              │
                    │  (Next.js UI + API; OSS + managed control)  │
                    └───────┬───────────────┬───────────────┬─────┘
                            │               │               │
              GitHub App ◄──┤               │               ├──► Pi authoring assistant
              (repos, PRs,  │               │               │    (@earendil-works/
               webhooks)    │               │               │     pi-coding-agent, sandboxed
                            │               │               │     checkout of working branch)
                            │               │               │
                     Secrets/Env store      │        DeployTarget adapters
                     (encrypted, per-env)    │        ├─ Container + Postgres World (default)
                            │                │        ├─ Vercel (later)
                            │          Metering/Billing│        └─ others (Redis/Turso/CF Worlds)
                            │          (managed mode)  │
                            ▼                          ▼
                    ┌───────────────┐        ┌──────────────────────────┐
                    │  eve repo(s)  │  build │  Running eve instance(s)  │
                    │  = source of  │───────►│  Nitro .output/ +         │
                    │  truth        │ eve    │  Workflow World (Postgres)│
                    └───────────────┘ build  │  + sandbox + model keys   │
                                             │  channels: HTTP/Slack/... │
                                             └──────────────────────────┘
```

**Core components**

- **Web app (React Router 7 / Vite):** UI + control-plane API, built on **React Router 7 framework
  mode** (the `@react-router/dev` Vite plugin — SSR, loaders/actions, nested routing). OSS-deployable;
  managed adds tenancy/billing.
- **Identity & auth (Better Auth):** self-hosted email/password authentication plus the organization
  plugin's organizations, members, invitations, active-organization sessions, and default roles.
  Better Auth organizations map directly to harnesst tenants; users and tenancy live in the same
  Postgres database as the control plane (see §9). Login is email-first then password; signup is
  name/email/password with no verification gate. Password resets use Better Auth's standard
  single-use token flow and transactional email.
- **GitHub integration service:** app auth, file R/W, PR/branch management, webhook ingestion.
- **Authoring assistant service:** hosts Pi sessions against a sandboxed working-branch checkout;
  streams tokens/tool events to the UI.
- **Secrets service:** encrypted per-environment secret storage + deploy-time injection.
- **Deploy controller:** runs `eve build`, packages the image, invokes the `DeployTarget` adapter,
  tracks instance state.
- **Metering & billing (managed):** usage capture + plan/invoice management.
- **Release registry:** immutable Releases (label, commit SHA, image digest, changelog) and the
  Release each environment/deployment points at — the version layer over git (§7.7).
- **Traffic splitter (ingress):** weighted, session-sticky routing across concurrent Releases of one
  agent — data-plane capability retained; the product runs one live Release per environment since
  M5.6 (§7.7).
- **harnesst datastore:** projects, repos, environments, instances, releases, members, secrets metadata,
  runs index, billing — _not_ agent config (that lives in the repo).

**Data-model note:** agent configuration is **not** duplicated in harnesst's DB. The repo is
authoritative; harnesst stores pointers, projections/cache, and operational metadata only. This avoids a
two-source-of-truth reconciliation problem.

---

## 9. Cross-cutting concerns

- **Identity, auth & tenancy (Better Auth):** all human authentication runs through Better Auth's
  same-origin React Router handler using email/password credentials. A **Better Auth organization is
  a harnesst tenant**; the organization plugin is authoritative for members, invitations, its standard
  owner/admin/member roles, and `session.activeOrganizationId`. Invitation delivery uses the
  installation's React Email/Postmark sender and acceptance uses the plugin API. Password reset
  delivery uses the same sender. Ordinary signup/sign-in are not gated by email verification, but
  invitation recipients must verify the invited mailbox before Better Auth will reveal or accept
  an invitation ID. The same local auth model serves OSS and managed installations. SSO and
  directory sync are not part of this implementation.
- **Security & secrets:** encrypted at rest, scoped per environment/instance, never written to repo
  files; least-privilege GitHub App scopes; the assistant runs in an isolated sandbox and cannot
  reach production secrets or hosts.
- **Observability (pillar §7.6):** harnesst ships its own run-observability subsystem on every host (not
  just Vercel's Agent Runs) — per-agent, per-run transcripts + metrics, fed by eve's OpenTelemetry
  (`instrumentation.ts`) and the Workflow event log. See ARCHITECTURE §3.7 for the pipeline.
- **Approvals surfaced in UI:** tool `needsApproval` events must render as actionable items in harnesst
  (and in Slack where used), pausing the durable session with no compute cost until resolved.
- **Multi-repo / multi-agent:** an org may manage many eve projects; harnesst lists and switches between
  them. Within one repo, the team convention (§7.9) allows many agents; a project is a repo, an
  agent is a member of it (single-agent repos are teams of one).

---

## 10. Success metrics

- **Activation:** % of connected repos that reach a first successful deploy.
- **PM autonomy:** % of tools created via the assistant with no manual code edit before publish.
- **Time-to-first-agent:** median time from connect → deployed working agent.
- **Iteration velocity:** publishes per agent per week.
- **Managed conversion (commercial):** OSS → managed upgrade rate; usage-based revenue per account.

---

## 11. Phasing

**Milestone 0 — Foundations**

- React Router 7 (Vite) app skeleton; **auth via Better Auth** email/password;
  org/project model built on the Better Auth organization plugin.
- GitHub App: connect existing repo, parse eve project, read files.
- Read-only visualization of an eve agent's full config surface.

**Milestone 1 — Author (no deploy yet)**

- Structured editors for all §5 concepts (write path).
- Working-branch + PR flow (branch → commit edits → open PR → merge; retired by Save & Publish, M8.6).
- Embedded Pi assistant: generate/edit tool TypeScript; sandbox test-run; secrets UI.
- `eve init` for new-repo creation.

**Milestone 2 — Deploy + versioning (default target)**

- Deploy controller + `DeployTarget` adapter interface.
- **Container + Postgres World** adapter; BYO-credential deploys.
- **Releases** (immutable = commit SHA + image digest, labels, changelog); version history;
  **fast rollback** (re-point to prior Release) + git-revert.
- **Multiple Releases live at once** behind a **weighted, session-sticky traffic splitter** at ingress
  (the core "run two versions" primitive — §7.7; product surface later removed in M5.6, data
  plane retained).
- Environments (dev/preview/prod seeded; superseded by user-defined environments in M5.7),
  instance status/logs.
- Merge-triggers-deploy pipeline; optional PR preview instances (both retired by Save & Publish, M8.6).

**Milestone 3 — Observe (run observability, §7.6)**

- Telemetry ingestion: OTel collector (`instrumentation.ts`) + Workflow-event-log reader; authenticated
  OTLP endpoint so **BYO** instances ship runs back to harnesst.
- Runs store + per-agent **Run list** (tokens, wall-clock, status, tool-call/error counts).
- Per-Run **transcript** view (input, model/tool calls with I/O + errors, final answer); link each Run
  to its deployed git commit/Release to resolve the system prompt.
- **Compare by version:** group/filter Runs by Release so PMs judge concurrent versions from telemetry
  (emergent "A/B" — no formal experimentation framework; §7.7).
- Access control (Better Auth organization membership), retention + redaction controls.

**Milestone 4 — Managed commercial mode**

- Managed credential pool + multi-tenant isolation (incl. tenant-isolated telemetry).
- Metering + plans + usage billing (reconciled with observability token counts).
- Governance: Better Auth organization roles and invitations, operational audit log, spend limits.

**Milestone 5 — Breadth**

- Additional `DeployTarget` adapters (Vercel zero-config; Redis/Turso/Cloudflare Worlds).
- Evals-as-deploy-gate UI; richer observability (traces across subagents, alerting); SSO.
- Optional **progressive rollout** policy (auto-ramp/auto-rollback on thresholds) over the §7.7
  splitter — only if demand appears; not required for the multi-version value.

**Milestone 5.5 — Agents schema split (committed, do next)**

- Land the `agents` entity under `projects` **now, ahead of Milestones 6–7**: releases, deployments,
  runs, schedules, and drafts re-key by agent. Existing single-agent repos migrate as teams of one;
  the UI stays unchanged for the single-agent case.
- **Environments and secrets are per-agent** (§7.9 decision) — each member gets its own
  environments and secret scope; workspace defaults cascade workspace → agent-environment.
- Roster sync: connect and repo webhooks reconcile agent rows from the layout convention
  (`detectAgentRoots`); the deploy controller builds per member directory; runs ingestion tags
  the agent; editors/drafts resolve paths against the agent's root.
- Rationale: hard-committed direction (§7.9 decision) + the migration is cheapest while data is
  small; deferring means every intervening feature deepens it.

**Milestone 5.6 — Deploy UX: single-live + Ship (shipped)**

- **Single-live cutover:** a deployment that lands live now demotes the environment's every other
  live deployment (controller-enforced; rollback rides the same path, so a failed deploy or
  rollback never takes the serving version down). A one-time data migration reconciled
  environments that had accumulated multiple live versions (newest kept at weight 100, rest
  stopped). The splitter/`trafficWeight` data model is retained without a product surface
  (§7.7 revision).
- **Ship:** the one-click deploy (originally on the agent Overview; later the team-level Quick
  deploy in the tab row; **superseded by Publish in M8.6** — Ship, Quick deploy, and the
  branch/PR/merge chain no longer exist) — staged drafts → publish → merge →
  Release → cutover deploy — with an environment picker (production default; the member's
  first environment since M5.7), team fan-out to
  affected members, "ship latest from `main`" when nothing is staged, and a refresh-proof
  progress banner with Retry on build failure (§7.4 Deploy UX).
- **Versions page** (replaced the Deployments tab; folded into the Deployment tab in M5.8):
  environment status + version history with
  one-click redeploy of any prior successful Release (confirm dialog). Weights/split controls,
  the per-environment deploy selectors, and the "cut release" button are gone. (Layout and
  vocabulary revised in M5.7: environments-first, "Deploy"/"running on".)
- Rationale: shipping an edit took ~6–8 clicks across three pages, and ordinary deploys silently
  accumulated live versions. Two verbs + one invariant (one running version per
  environment) replace the exposed pipeline; the multi-version primitive waits for a deliberate
  product story (§7.7).
- Deliberately not built: weights/canary UI, environment-promotion pipelines, per-PR preview
  deploys, deploy approvals/locks (consistent with §7.7's no-experimentation stance).

**Milestone 5.7 — User-defined environments (shipped)**

- The static seeded trio (production/preview/development) is gone: a new member starts with ONE
  environment named `default`, and environments are ordinary user data — **create, rename,
  delete** from the deploy surface. Rationale: the trio was arbitrary (most agents used only
  production; the other two sat empty on every member), and imposed vocabulary the user never
  chose. Whoever wants dev/staging/production simply creates them.
- **Environments are equal peers.** No environment name or position is special in the UI; the
  member's first environment (creation order, id tiebreak) is only the mechanical Ship-dialog
  preselect. The deploy surface leads with the environments as identical rows (running version,
  in-flight progress, failures) over the version history; version rows are badged with the
  environment names they run on, and the verb is **Deploy to \<env\>** — "live" vocabulary is
  gone, since with peer environments a version is only ever _running on_ specific environments.
  A data migration made the previously-implicit primary ("production") sort first for existing
  agents; existing environments were otherwise left exactly as they were.
- **Invariant:** a member always has ≥1 environment (`ensureDefault` seeds `default` only for
  members with zero — roster self-heals and webhooks can never re-seed over user CRUD; the
  last environment refuses deletion).
- **Delete is total but explicit:** one confirm dialog; it stops running instances, destroys
  per-instance state (containers + instance databases via the new `DeployTarget.destroy` seam
  method), and cascades away that environment's deployment history and env-scoped secrets.
  Agent-wide secrets and Releases survive.
- **Teams:** Ship still fans out across members by environment _name_ (a shared name like
  `default` keeps team ships one-click); members lacking the target name are reported in the
  ship banner rather than silently skipped.
- Deliberately not built: cross-member environment sync ("create staging for every member"),
  per-environment protection rules, environment-scoped roles.

**Milestone 5.8 — IA: two-level hierarchy (shipped)**

- The root defect: ONE tab row (Overview · Changes · Versions · Playground · Runs · Secrets ·
  Assistant) served three scopes, and lied in both directions — Changes and Playground are
  repo-wide but carried the member selector; Versions/Secrets were strictly per-member; tabs
  clicked from a team landing silently landed on the first member.
- **Member context is a URL level.** Team members' pages live at
  `/repos/:id/agents/:name/…` with their own tab row; the repo level has a smaller row;
  single-agent repos collapse both levels into one (no `/agents/…` ever appears). Old
  `?agent=` links and retired tab URLs 301 into the hierarchy. Tab rows per context:
  single-agent = Overview · Deployment · Playground · Runs · Assistant · Settings; team
  landing = Overview · Deployment · Playground · Settings; team member = Overview ·
  Deployment · Runs · Assistant · Settings (+ member switcher).
- **Deployment tab** = Changes + Versions merged into the pipeline story: staged changes
  (the member's drafts + shared ones, badged) → change requests (repo-wide, labeled) →
  environments → version history. Team repos additionally get a repo-level Deployment
  rollup: drafts grouped by member, merge, and each member's latest version. Ship stays on
  the Overview (owner decision — the quick path lives where the edit just happened).
  (**Superseded in M8.6:** the tab is now environments + version history only; pending changes
  live in the publish panel.)
- **Settings tab** (member level; merged with repo sections on single-agent repos): Model
  (moved off the Overview), Secrets (the former tab, env scoping intact), danger zone with
  Remove agent (moved off the Overview header). Repo level: General (GitHub connection),
  Run-ingestion tokens (moved out of Runs), and **Delete repository** — a full harnesst-side
  teardown (owner decision): instances stopped and destroyed, every row cascaded; the
  GitHub repository is never touched; typed-name confirm.
- Punted: repo-level all-runs rollup; per-member assistant transcripts (the shared project
  transcript with member-scoped writes is a known quirk).

**Milestone 5.9 — Performance: GitHub read cache & navigation feedback (shipped)**

- The measured defect: page navigations sat at 2–3s with zero UI feedback. Every GitHub REST
  call costs ~600ms from this machine (Australia), and loaders chained several uncached —
  `fetchAgentSource` alone (repos.get → recursive git tree → per-root file reads) was 1.6–2s per
  call, and it ran on the Overview, Settings, Resources, Deployment, and assistant surfaces.
- **SWR read cache** (`github/cache.server.ts` + `cached.server.ts`): an in-memory
  stale-while-revalidate cache (on `globalThis` to survive HMR, no eviction — keyed per
  connected repo). A hit returns instantly; a stale hit returns the old value AND refreshes in
  the background; concurrent reads for one key share a single fetch. Source (60s), open changes
  (30s), and last-commit metadata (5min) each get a cached wrapper.
- **The rule: loaders read cached, actions read raw.** A stale read composed into a write could
  clobber newer content, so every action and the ship/release pipeline keep the raw functions;
  only the read-only loader surfaces switched. Writes invalidate on success (`proposeChange` /
  close → changes; merge → changes _and_ source, since a merge moves the default branch), and
  the push/PR webhook re-warms the default-branch source and drops the changes cache so
  github.com-side activity can't leave a stale value behind. Connect warms the cache with the
  source it already read to validate the repo, so the first project load is instant.
- **Navigation feedback**: a global 2px indeterminate progress bar in the shell (CSS keyframes,
  gated 150ms behind an opacity fade so sub-150ms navigations never flash), `isPending` tab
  highlighting so a click registers within a frame before its loader resolves, and
  `prefetch="intent"` on the tab rows, breadcrumbs, and team-member cards.

**Milestone 6 — Recruit (marketplace, §7.8)**

- **Phase 1 — format + catalog + browse (shipped).** The template format (files + a
  `template.json` manifest: file list, npm dependencies, required secrets, an optional
  auth-brokered connection descriptor (issue #30), version,
  eve range) as a Zod schema that makes path traversal impossible at the schema layer; the
  first-party catalog as a `marketplace/` tree (`catalog/` in-repo) validated + indexed by
  catalog CI (no build step — templates are source; the index carries a content hash per
  template). The `CatalogSource` seam (config pointer: repo + path + ref; fixture-backed for
  dev/tests, GitHub-raw in production) with browse from `index.json` only, a type-filtered browse
  page, and a per-template detail page.
- **Phase 2 — install / update / uninstall (shipped).** Install is a change-set: a **pure
  planner** (`app/marketplace/install.server.ts`, unit-tested against literals) maps a template
  to final repo paths and hands the wizard route writes/deletions/conflicts/warnings; the route
  stages them as drafts and hands off to the existing Deployment-tab publish/ship pipeline (harnesst
  does not open the PR itself). The **wizard** (`marketplace/:type/:id/install`) is
  searchParams-driven SSR — the URL is the state — with a target picker (tool/skill/subagent →
  member; agent → new team member), a live plan preview, and secret inputs (stored per-agent,
  agent-wide). The **dependency merge** follows the PRD policy — absent → add; ranges intersect
  → keep the agent's silently; disjoint → keep + warn (real `semver`, the one dependency added).
  **Provenance** is a repo-root `harnesst-lock.json` (final paths + version + hash + registry +
  member), folded into the cached `fetchAgentSource` read so loaders get it for free. The
  Deployment tab shows a **Marketplace installs** card per member: **Update to x.y.z** when the
  catalog has a newer version (`semver.gt`), and **Uninstall** (stages deletions of owned files;
  npm deps are left and listed for the reviewer). A catalog outage degrades gracefully (no update
  buttons) rather than breaking the tab.
- Mostly additive — no schema surgery. Real peer teams shipped in M5.5–5.8, so "new team member"
  is a first-class install target here.
- **Deliberately punted:** the other two agent-template targets from §7.8 — a **new standalone
  repo** and a **subagent of an existing agent** (member + new-team-member are the shipped two);
  and the **rung-2 "publish to marketplace" flow** (extracting a live-tested tool/agent from a
  workspace into a catalog PR) — rung 1 (PR the catalog, CI-gated) stands.

**Milestone 6.1 — Runtime: real sandboxes & durable worlds (shipped)**

- **The discovery.** A secrets audit of a live harnesst instance found the model's `bash` tool
  couldn't run a single binary — no git, no node, no npm. eve's `defaultBackend()` picks a
  sandbox in priority order (Vercel Sandbox when `process.env.VERCEL` → Docker when a daemon is
  reachable via a `docker` CLI → microsandbox on a KVM/Apple-Silicon host → **just-bash**, a
  pure-JS bash interpreter with no real binaries). Our instance containers had neither a docker
  CLI nor a daemon, so every agent silently degraded to just-bash. Agents looked alive and could
  do nothing.
- **Real sandboxes.** The reference image now ships the static Docker CLI _client_ (v27.5.1, no
  daemon) at `/usr/local/bin/docker` (`eve-image.server.ts`), and the deploy target mounts the
  host's Docker socket into each instance (`deploy.localdocker.server.ts`,
  `-v /var/run/docker.sock:/var/run/docker.sock`). eve's availability probe then passes and
  `defaultBackend()` selects the real Docker backend — the runtime spawns **sibling** sandbox
  containers on the host daemon (docker-outside-of-docker). **No customer-repo change is needed:**
  availability resolves at first sandbox use. Verified: `docker version` run _inside_ an instance
  built from the new image, with the socket mounted, prints the host daemon version.
- **Durable worlds.** eve's durability model keeps sessions in the Workflow "world" (Postgres) and
  each durable session's sandbox as a long-lived sibling container (labelled `eve.sandbox`) that
  eve reattaches via `docker start`. harnesst used to provision a **fresh instance DB per deployment**
  (`harnesst_inst_<deploymentId>`), so every redeploy orphaned all sessions and their sandboxes. The
  world DB is now keyed by **environment** (`harnesst_env_<sanitized>_<sha1slug>`, from
  `DeployRequest.worldKey = environment.id`): every deploy of an environment shares one world, so
  sessions AND their `/workspace` filesystems (where an agent might keep e.g. SSH keys) survive
  redeploys — eve's intended "sessions survive cold starts, redeploys, and long pauses". During a
  cutover the old-live and new deployments briefly share the world DB; that is eve's normal
  multi-instance mode (Vercel runs many function instances against one world). Per-deployment
  `destroy` now removes only the container; a new `destroyWorld(worldKey)` drops the shared world
  DB once, on environment/repository teardown, after every per-deployment destroy.
- **Migration:** old `harnesst_inst_<deploymentId>` databases are orphaned by design (sessions were
  never durable before this) — no data migration; they can be dropped manually.
- **Security surface.** The Docker socket grants the _runtime_ process host-level Docker control;
  the trusted surface is the eve framework + repo-authored tool code (reviewed via change-sets).
  The model's `bash` runs INSIDE sandbox containers, which have **no** socket. Two hardening notes
  for the host's docker-compose/container (left to the operator): the control-plane Postgres
  publishes `0.0.0.0:5442` — bind it to `127.0.0.1`; and the Docker sandbox backend's egress
  defaults to allow-all (a repo can opt into deny-all via `defineSandbox`).
- **Deliberately punted:** (1) **sandbox-container GC on environment delete** — stopped sibling
  sandbox containers are currently orphaned; the `eve.sandbox` label makes them findable, so a
  future `gc` sweep can reap them. _(Partially closed in 6.2: `destroyWorld` now reaps the containers
  mounting a dead environment's home volume.)_ (2) **sandbox egress-policy defaults** — the docker
  backend honors only allow-all / deny-all today; per-destination policy is upstream work.
  (3) **agent-level persistent home directory** — _shipped in Milestone 6.2 below (the eve-docker shim),
  NOT the upstream-mounts route once planned here._

**Milestone 6.2 — Agent home: persistent `/workspace/home` across sessions (shipped)**

- **The gap.** 6.1 made _sessions_ durable, but eve's sandbox filesystem is per **durable session** —
  a new session starts from a clean template. There is no per-_agent_ home, so anything an agent set
  up for itself (an SSH key it generated, a package cache, notes-to-self) evaporated the moment eve
  rotated to a fresh session. Agents couldn't accumulate a working environment.
- **The rejected paths.** (1) _Upstream `mounts` option_ — eve's `docker()` backend exposes only
  `{ image, env, networkPolicy, pullPolicy }`; adding a `mounts` option (what 6.1 had planned) was an
  **owner decision to reject** rather than carry an eve fork. (2) _Materializing a secret store into
  the home_ — would have made per-agent key setup a standing behavioral obligation of the control
  plane (provision, rotate, reconcile), the exact two-source-of-truth trap we avoid elsewhere.
- **The design — an `EVE_DOCKER_PATH` shim.** eve shells out to the docker CLI at `EVE_DOCKER_PATH`.
  The instance image ships a tiny POSIX-sh wrapper at `/usr/local/bin/eve-docker`
  (`EVE_DOCKER_SHIM`, eve-image.server.ts); the deploy target sets `EVE_DOCKER_PATH` to it and
  `HARNESST_HOME_VOLUME` to this environment's volume (both injected AFTER the user-secret env spread, so
  a secret can never shadow them). On a `run` that carries eve's session-container label pair
  `--label eve.sandbox.role=session`, the shim injects `-v $HARNESST_HOME_VOLUME:/workspace/home` right
  after the `run` token and `exec`s the real client; everything else — template-build runs (shared,
  must not capture a volume), `start`/`exec`/`stop`/`rm`, an unset volume — passes through untouched.
  (The image runs as root, so the mount is already writable — no chown needed.)
- **The tripwire.** The shim keys on eve's `eve.sandbox.role=session` label. If a future eve upgrade
  renames it, the shim silently stops matching: no injection, sandboxes still run, homes just quietly
  stop mounting — a graceful degradation back to pre-6.2 behaviour, documented here as the thing to
  check when "my SSH key vanished again" resurfaces.
- **Volume naming & lifecycle.** One named volume per environment: `homeVolumeName(worldKey)` =
  `harnesst-home-<sanitized>-<sha1slug8>` (same stability/collision-safety shape as `worldDbName`, wider
  volume charset). Docker auto-creates it on first sandbox use — no provisioning. `destroyWorld` now
  tears the whole environment down: drop the world DB, then (best-effort) reap the sandbox containers
  mounting that volume — a `docker ps --filter volume=<name>` finds exactly this env's siblings, which
  also closes part of the 6.1 sandbox-GC punt — then remove the volume.
- **The agent-visible contract.** Anything an agent keeps under `/workspace/home` — SSH keys, caches,
  notes-to-self — **survives new sessions, redeploys, and instance restarts, and dies with the
  environment.** Everything outside `/workspace/home` remains per-session scratch.

**Milestone 7 — Teams (peer teams, §7.9) (shipped)**

- ✅ The `agents/*` monorepo convention: detection (`detectAgentRoots`), per-member parse,
  per-member build → image → Release → instance.
- ✅ (Schema split already landed in Milestone 5.5.)
- ✅ Full Teams UX: hierarchy-first IA (team landing, per-member tab rows, member switcher),
  roster CRUD, per-member environments + secret scope, team-fan-out Ship. (commits `0b8a7be`,
  `7bb3153`, `55fc29b`, `0397211`; IA in M5.8.)
- ✅ **Runtime collaboration — teammate delegation.** Every team member gets an `ask-teammate`
  tool, baked into its image at build time (never the repo; a repo file at that path wins), that
  delegates a self-contained task to a peer and returns the peer's final reply. The design:
  - **harnesst relay, not peer-to-peer** — the tool POSTs `POST /api/team/ask` on the control plane,
    which resolves the peer's live deployment and drives its eve session via the hardened
    `sendTurn` client. Instances stay loopback-only and unauthenticated; the relay is the single
    authorization chokepoint and the natural correlation point.
  - **Default-allow, directed permissions** (`agent_links` — absent row = allowed) with a
    Settings → Team collaboration matrix; toggles apply live at the relay, no redeploy. Roster
    identity (`HARNESST_TEAMMATES`) + relay coordinates + an HMAC deployment token are env-injected at
    deploy (stripped-then-set, like `HARNESST_SANDBOX_ENV`); a roster change auto-redeploys the other
    members to refresh it.
  - **Linked traces** — a `delegations` row plus a relay-recorded peer run (channel `teammate`)
    give the caller's tool step a link to the peer's run and the peer's run header a "Triggered
    by" chip, with zero changes to the runs schema.
  - **Deliberately punted** (bounded by concurrency caps + timeouts): approval gates across a
    delegation chain (the parked request surfaces as an error), wake-on-delegation for stopped
    instances, multi-turn teammate conversations (upstream continuation contract unproven),
    streaming intermediate progress into the caller's transcript, cross-repo delegation, and
    precise chain-depth tracking.
- ⬜ (Later, cheap once 6+7 exist:) team templates in the marketplace — a scaffold referencing
  agent templates plus a wiring spec.

**Milestone 8 — Self-host: single-VPS deployment (shipped)**

- The supported production topology for OSS v1: **one Linux VPS runs everything** — harnesst,
  Postgres, agent instances, sandbox containers. Co-residency is a feature of the local-docker
  target (loopback instance URLs), not an accident; multi-host is out of scope.
- Deliverable is a **runbook, not an installer** (owner decision): `deploy/vps/README.md` walks
  firewall → Docker Engine → clone → env file → compose stack (Postgres + harnesst, host networking,
  socket mount) → nginx + Let's Encrypt (host packages, not Caddy) → Better Auth/Postmark configuration
  - GitHub App pointed at the domain → smoke test. Supporting artifacts: production `Dockerfile`
    (docker CLI + tar in the runtime image), `deploy/vps/docker-compose.yml`, `nginx-harnesst.conf`,
    `env.example`.
- **Acceptance (owner's words):** clone the repo on a fresh VPS, follow the README top to bottom,
  and harnesst is up on the domain — connect a repo, ship, and talk to the agent in the playground.
- **Deprioritized:** the Vercel target (§7.4 "later" adapter) moves behind this and behind a
  probable **Cloudflare** target — revisit after VPS parity is proven. The seam stays: nothing in
  M8 hard-codes the topology outside the local-docker target.

**Milestone 8.1 — Sandbox platform: prewarm fix, editable sandbox.ts, secret exposure (shipped)**

- **The bug (confirmed live).** Agent images booted the raw Nitro entry (`node
.output/server/index.mjs`), which skips eve's sandbox-template prewarm. Any agent whose sandbox
  has a non-null template key — a `bootstrap()` hook, or workspace resources (a `skills/`
  directory counts) — then hit `SandboxTemplateNotProvisionedError` on first bash use, forever:
  eve's docker backend requires the `eve-sbx-tpl-*` template image to pre-exist, `eve build` only
  prewarms on Vercel, and the runtime's self-heal retry is disabled for built servers. Off-Vercel,
  `eve start` is the only supported prewarm path.
- **The fix.** The generated image's final stage now inherits the FULL build stage (`eve start`
  needs node_modules + `.eve/compile`; the layers are already retained as the `-build` tag, so
  disk cost ≈ zero) and boots `CMD ["node_modules/.bin/eve", "start"]` — the bin directly, since
  npm exec/run don't reliably forward SIGTERM as PID 1 and scale-to-zero is a `docker stop`. The
  instance `docker run` gains `--init`. Health waits split into named budgets: 10 min on deploy
  (first boot may pull the sandbox base image, run bootstrap, snapshot the template) vs 120 s on
  wake (prewarm re-runs but hits the cached-template fast path). A health failure now folds the
  container's log tail into the error so a failed bootstrap shows its real cause in the UI.
- **Sandbox as a first-class surface.** The eve sandbox definition (`agent/sandbox.ts`, or
  `sandbox/sandbox.ts` + `workspace/` seed) is parsed like instructions (a singleton per agent
  and per subagent), shown as an Overview section (custom vs framework default), and edited
  through the same draft rails as every file. New scaffolds (create repo, add member, both
  catalog agent templates) ship a default `sandbox.ts`; the assistant's METHOD teaches the
  surface, so "add the GitHub CLI to my sandbox" is an assistant edit.
- **Secret exposure — the `HARNESST_SANDBOX_ENV` convention.** eve sandboxes are sealed by default
  (they never inherit the instance env — a property we keep). Each secret gets an
  "available in the agent's sandbox shell" toggle (`secrets_metadata.sandbox_exposed` — metadata,
  never values). At deploy, harnesst joins the exposed names that actually resolved into
  `HARNESST_SANDBOX_ENV`, set AFTER the user-secret spread so it can't be shadowed or smuggled; the
  scaffolded `sandbox.ts` forwards exactly those variables into the sandbox backend's `env`
  (docker + vercel bags). With nothing exposed the allowlist is absent and behavior is identical
  to the framework default. Two propagation facts, by eve's design: env values are hashed into
  the docker template image name (rotating an exposed value → automatic template rebuild at next
  start), and session containers are reused, so env changes reach new sessions only.

**Milestone 8.2 — Catalog agents: capabilities via terminal, not bespoke tools (shipped)**

- **The principle.** A catalog agent's capability lives in `instructions.md` (the playbook), its
  permission in sandbox-exposed secrets (env vars in the shell), and its execution in eve's
  standard bash/file tools. No per-agent `tools/` wrappers for things a terminal already does —
  the versatility IS the terminal. Modeled on the proven live `cloudflare-dev` agent, minus its
  ask-in-chat token bootstrap (credentials now arrive as env, never through the transcript).
- **Cloudflare App Builder 0.3.0** — a developer, not a deployer: builds React-on-Workers apps
  and ships them to GitHub (`gh` CLI: new repo → scaffold → push; existing repo → branch → PR,
  never merges its own). Needs `GITHUB_TOKEN` + `GITHUB_ORG`, nothing from Cloudflare; the
  `react-on-workers` skill's deploy step is gone (a clean production build is its definition of
  shippable).
- **Cloudflare Deployment Engineer 0.2.0** — the downstream half: clones any org repo, reads its
  wrangler config, builds, dry-runs, deploys with `npx wrangler deploy`, curls the URL, reports.
  The bespoke `cloudflare-deploy.ts` tool and its wrangler dependency are deleted. Needs
  `GITHUB_TOKEN`/`GITHUB_ORG`/`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`.
- **Manifest `secrets[].sandbox: true`.** A template can declare a secret as sandbox-bound: the
  install wizard flips its exposure flag as it stores the value (and says so under the field), so
  a terminal-driven agent's first deploy has working credentials without a manual Settings trip.
  Secrets left blank at install get the flag when set later from Settings.

**Milestone 8.3 — Models: OpenRouter end-to-end (shipped)**

- Model choices write `@openrouter/ai-sdk-provider` wiring into `agent.ts` (imports + factory +
  `modelContextWindowTokens`) instead of bare AI Gateway slugs; the picker reads OpenRouter's live
  catalog (`app/models/filter.ts`), ids are OpenRouter-native (`z-ai/glm-5.2`). Workspace settings
  gain a **default model** inherited by the assistant and model-less agents. Deploys can force a
  rebuild (rebuild flag through queue → controller). `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN` still
  pass through for legacy repos. Supersedes the Vercel-AI-Gateway model decision recorded earlier
  in the harnesst-project memory. (commits `63dd0db`, `2bcc7a8`, `157bc3f`.)

**Milestone 8.4 — Secrets management rework (shipped)**

- Delivered the `docs/PLAN-SECRETS-REWORK.md` spec: fetcher-based CRUD (no more full-page reload
  per mutation — `useFetcher`, optimistic), secret **fingerprints** (know what/when a value was
  set), install-time values for agent templates (no longer disabled "set it later"),
  **required-by-template** surfacing in Settings (an agent that still needs `CLOUDFLARE_API_TOKEN`
  is flagged), and **project-level shared secrets** with per-agent opt-in (e.g. one `GITHUB_TOKEN`,
  not re-entered per member). Sandbox-exposure can be toggled before a secret exists.
  (commit `7da694e`.)

**Milestone 8.5 — Playground: chat surface + human-in-the-loop (shipped)**

- Playground sessions are stored as **Eve cursors** (`71a8c5f`) and stream live, recorded as runs
  in observability (`c8ac0dc`). The playground/assistant became a **ChatGPT-style chat surface**
  (`61388ac`, `69b8016`): viewport-locked layout, stick-to-bottom transcript, tool activity
  collapsed into a per-turn StepsCard below the reply. **Human-in-the-loop:** eve's
  `input.requested` (ask_question, tool approvals — previously silently dropped) is now structured
  end-to-end (live NDJSON stream, done payload, Eve history replay, runs recording) and rendered as
  callouts with clickable option buttons.

**Milestone 8.6 — Save & Publish (shipped, issue #225)**

- The stage → publish → change-request → merge → deploy pipeline is replaced by **two user
  actions**: **Save** (every editor stages a whole-file draft; unchanged) and **Publish** (one
  header control that shows every pending change with a diff and runs
  **check → build → commit → version → deploy** as a single pipeline). A failed build lands
  nothing; the failure names the step and member and shows the compiler's own output.
- harnesst **authors no branches and no pull requests**: the commit is a compare-and-swap
  fast-forward onto the default branch (an external push mid-publish triggers one
  rebuild-and-retry). Each change is Docker-built **once** — the publish build's image is
  promoted and the deploy reuses it.
- The **assistant stages drafts** like everything else: a turn's file diff lands in the same
  staging area, and nothing deploys until Publish is clicked. The `harnesst/conv-*` mirror branch
  survives as an internal durability mechanism only.
- The **Deployment tab** shrinks to environments + version history, with **Roll back** promoted
  to a primary action. The environment question is asked at most once (persisted as
  `liveEnvironmentName`); Quick deploy, the staged-count pill, per-file publish selection, and
  the `merge_change`/`publish_change` jobs are gone.
- The GitHub webhook's cut-Releases-on-merged-PR path survives unchanged — it serves developers
  pushing to the repo directly, not the harnesst UI.

---

## 12. Open questions & risks

- **eve beta churn.** eve is in public beta; APIs (`defineAgent`, `defineTool`, build output, Worlds)
  may change. harnesst must isolate an "eve-version adapter" layer and pin/track eve versions per repo.
  **Sharpened by the eve spike:** the eve ↔ `@workflow/world-postgres` version pair
  is strict and runtime-enforced (world spec versions) — harnesst must treat it as pinned per repo.
- ~~**`eve init` in a server context.**~~ **Resolved (2026-07-02):** `eve init`
  and `eve build` run fully headless (Node ≥ 24; harnesst runs them inside build containers). A repo is
  deployable off-Vercel only if it declares the Postgres world in `agent.ts` — Connect should
  validate and offer a "make deployable" PR.
- **Assistant workspace model.** Exactly how the Pi session mounts the working branch (ephemeral
  container checkout vs. persistent) and how its edits map cleanly to PR commits.
- **RESOLVED (Milestone 6.1): sandbox backend for the default target.** The local-docker target
  ships the Docker CLI client in the instance image and mounts the host Docker socket, so eve's
  `defaultBackend()` selects its real Docker sandbox (sibling containers) instead of degrading to
  just-bash. A hosted microVM equivalent (gVisor/Firecracker) remains the managed-substrate story
  (ARCH §2.2); egress policy beyond allow-all/deny-all and sandbox-container GC are the open edges.
- **Observability parity.** How much of Agent Runs' fidelity harnesst can reproduce off-Vercel from the
  Workflow event log + OTel.
- **Two-source-of-truth avoidance.** Keep repo authoritative; validate the projection/cache stays
  correct under external repo edits (webhook races, conflicts).
- **Managed multi-tenant security.** Isolation guarantees for customer agents (which run
  model-generated code in sandboxes) in shared harnesst infra.
- **Naming/branding & licensing** of the OSS core vs. managed service (open-core boundaries).
- **Marketplace trust & safety.** Templates contain executable TypeScript that will run in customer
  instances. v1's first-party curated catalog sidesteps this; third-party publishing needs a
  review/signing story before it exists. Related: how template versions pin against eve version
  churn (manifest declares an eve range, but enforcement/UX is undesigned).
- ~~**Teammate delegation semantics.** Generated delegation tools call the peer's HTTP channel —
  fire-and-forget vs. wait-for-completion vs. streaming intermediate progress back into the caller's
  turn; and how approval gates (`needsApproval`) compose across a delegation chain. Needs a spike.~~
  **RESOLVED (2026-07-06): teammate delegation.** Not a peer HTTP channel — a **harnesst relay**
  (`POST /api/team/ask`): the baked-in `ask-teammate` tool speaks
  plain JSON to the control plane, which drives the peer's eve session via `sendTurn` and returns
  its final reply. **Wait-for-completion**, one ask = one fresh peer session (multi-turn punted —
  the upstream continuation contract is unproven). **No progress streaming** into the caller's turn.
  Approval gates **do not compose**: a peer turn that parks on `input.requested` is surfaced to the
  caller as an error rather than tunnelling the gate. Runaway loops are bounded by per-edge (3) and
  per-project (10) concurrency caps plus timeouts, not chain-depth tracking. Permissions are
  default-allow directed overrides (`agent_links`) enforced live at the relay.
- **Monorepo build scope.** On merge, build only the team members whose files changed (path-based
  change detection) vs. rebuild all — affects Release semantics when `packages/shared` changes.
- **RESOLVED (2026-07-04): model API key placement.** Implemented the workspace-level model
  provider key: Org settings holds one OpenRouter key (encrypted, write-only). Every deploy
  inherits it as `OPENROUTER_API_KEY` unless a project/environment secret with that name
  overrides it, and the authoring assistant uses it for model access. In managed mode this
  still collapses into the ModelGateway (harnesst owns the keys; §8).

---

## 13. Appendix — reference facts validated during research

- eve is filesystem-first; agents are files under `agent/`; directories auto-discovered by name.
- Runtime is **Nitro + Workflow SDK**; `eve build` → `.eve/` (artifacts) + `.output/` (Nitro host).
- Durability via **Workflow "Worlds"** (event log + compute + queue): Local (dev), **Postgres**
  (reference/self-host), community Redis/Mongo/Turso/Cloudflare. State locally under `.workflow-data`.
- **Sandbox** is adapter-based: `defaultBackend()` local bash/Docker; Vercel Sandbox on Vercel.
- **Models** via provider-prefixed strings; AI Gateway (keyless) on Vercel, direct keys elsewhere.
- **Tools:** `defineTool({ description, inputSchema: z.object(...), execute(input, ctx), needsApproval,
outputSchema?, toModelOutput? })`; `ctx.session`, `ctx.getSandbox()`, `ctx.getSkill(id)`.
- **HTTP contract:** `POST /eve/v1/session` returns `x-eve-session-id`; stream at
  `/eve/v1/session/<id>/stream`.
- **Pi coding-agent SDK:** `createAgentSession`, `SessionManager` (in-memory/persist), `ModelRegistry`,
  `AuthStorage`, `customTools` via `defineTool`, streaming `session.subscribe(...)`,
  `session.prompt/steer/followUp` — designed for embedding an agent in your own app.

_Sources: github.com/vercel/eve, vercel.com/docs/eve/concepts, vercel.com/blog/introducing-eve,
vercel.com/blog/a-new-programming-model-for-durable-execution,
github.com/earendil-works/pi (packages/coding-agent)._
