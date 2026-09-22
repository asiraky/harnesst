# Ledger team prototype

The ledger application runs in Supabase. Its Marketplace bundle installs the member tools and wake channel plus operator deployment assets. Start with [the account and authentication walkthrough](TEAM-SETUP.md) for the prepared harnesst team. The standalone local Postgres bridge below is only a diagnostic harness; it is not the team’s configured service.

## Run locally

Requires Node 22.18+ (native TypeScript stripping), npm and Docker Compose. From the harnesst checkout:

```sh
npm ci
npm run ledger:up
npm run ledger:dev
```

Open **http://localhost:55430**. The database persists across restarts. `npm run ledger:down` stops its container without deleting data. Ports are dedicated to this prototype: UI 55430, authenticated container API 55431, Postgres 55432. The harnesst application's database is untouched.

The playground runs real authorization, transactions, evidence checks, approval queues, outbox claims and redelivery. **It simulates product code, tests and deployments.** Every manual evidence action labels itself simulated. Simulated inboxes claim wakes and wait for you to act; they do not run an LLM. Outbox retries run every second locally, with the same one-minute minimum backoff and 30-minute claim lease as the hosted adapter.

### Approval testing

The diagnostic UI cannot approve gates. Human decisions use May I and the Supabase callback backend described in [TEAM-SETUP.md](TEAM-SETUP.md). `npm run ledger:test` verifies SQL behavior and signed callback handling against disposable databases and test signing keys. It does not claim live May I or Supabase deployment has passed.

## Real team in harnesst

The catalog now contains **Ledger Intake**, **Ledger Infra**, **Ledger Implementer**, **Ledger**, and **Cloudflare**. Use this checkout's fixture catalog when testing unreleased templates. Install the three agent templates into a team; implementer contains QA and reviewer subagents. All bundles and skills can also be installed independently using the matrix from PLAN-TEAM.

For inspectable local output, run:

```sh
npm run ledger:team
```

This uses harnesst's actual catalog composer and install planner. Output is under `.local/team/agents/<role>/`, with an `agent/` root, package manifest, lock entries, sandbox add-ons and member `.env` files. It is ignored by git. These are normal eve projects; harnesst supplies notification tools, model configuration and deployment plumbing when installed through its UI. The materialized files alone do not provide Front of House or model credentials.

Credentials are minted once into `.local/actors.json` (mode 0600). Do not commit it. Install these secrets:

| Secret | Local value | Scope |
| --- | --- | --- |
| `LEDGER_URL` | Host processes: `http://localhost:55431`; Docker: `http://host.docker.internal:55431` | Shared |
| `LEDGER_ANON_KEY` | `local` (the local bridge has no Supabase gateway; actor keys still authenticate every RPC) | Shared |
| `LEDGER_ACTOR_KEY` | The corresponding role's `actor_key` | Member |
| `LEDGER_WAKE_TOKEN` | The corresponding role's `wake_token` | Member |

On Linux, add `host.docker.internal:host-gateway` to the agent container's hosts if it is not already provided. Port 55431 exposes **only actor-authenticated RPCs**, not the operator playground. Port 55430 remains bound to loopback with Host/Origin checks. Keep the prototype on a trusted development machine; the local Postgres password is deliberately a development value.

Configure normal model credentials and, for real product work, the GitHub App and scoped Cloudflare credentials through harnesst. Set the ledger project's `repo` and docs to your test product repository. Greet each deployed member once: its first ledger tool call compares `EVE_PUBLIC_ORIGIN` to its stored wake URL and registers the current endpoint. Alternatively use **Connect real agents** in the playground. The delivery worker must be able to reach that URL.

Give each member a 15-minute harnesst schedule: “Read ledger-list-items with mine=true. Inspect unfinished items with no activity in the last hour; resume only work allowed by the ledger.” Schedules are harnesst configuration, not a marketplace template type. The intake, infra and implementer templates already contain the role instructions and ledger grounding.

Real GitHub and Cloudflare calls require your test repository/account credentials. The no-credentials playground does not claim to have run real agents or deployed a product.

## Hosted Supabase

Follow [TEAM-SETUP.md](TEAM-SETUP.md) for migrations, functions, OAuth, cron and recovery. Production uses Supabase PostgREST, Edge Functions, Vault, pg_net and pg_cron. There is no HARNESST ledger route and no hosted dependency on the diagnostic Node bridge.

## GitHub and deployment integration

Copy `examples/ledger.yml` into the **product** repo's `.github/workflows/ledger.yml` and `examples/github-ledger.mjs` into `.github/scripts/ledger.mjs`. Add `LEDGER_URL`, `LEDGER_ANON_KEY`, and the **github system actor's** `LEDGER_ACTOR_KEY` as repository secrets.

The workflow runs only trusted default-branch code with its secrets; it never checks out PR code. Same-repository branches use `ledger/<uuid>-<slug>`. PR events record head/branch/PR artifacts. The scheduled/manual job merges only `ready-to-merge` items for this repository, compares the live PR head to the approved SHA, passes that SHA to GitHub's merge API, and records the confirmed merge. Branch protections still apply. Your production deploy pipeline must run from the confirmed merge or be explicitly dispatched: merges made using `GITHUB_TOKEN` do not reliably start other Actions workflows.

The product's preview/production pipeline should create a GitHub Deployment with this payload:

```json
{"ledger_item_id":"ITEM_UUID","head_sha":"ORIGINAL_PR_HEAD_SHA"}
```

On success, set its deployment status `environment_url` to the actual URL. Use environment `production` for production and another name for preview. The original PR head is essential: a squash merge commit has a different SHA. A successful preview attaches a SHA-bound preview URL; production attaches deployment evidence and moves a confirmed merged item to deployed. Stale deployment events are refused. Deployments without ledger payloads are ignored. Failed Actions runs remain visible and can be rerun; the adapter retries optimistic-concurrency conflicts with a fresh read while preserving the original binding.

The infra agent owns provisioning and adapting the product's build/deploy workflow; this generic prototype does not assume one framework or invent a Cloudflare account.

## Contracts and intentional plan corrections

- `triage` is owned by intake. Workflow `next` is a destination-to-requirements map; returning to build does not require a pass. Workflow structure is checked by SQL, rather than claiming a SQL CHECK runs Zod.
- Items currently use one PR and a fixed iteration; revise the specification or head SHA to invalidate earlier evidence. Multiple PR iterations are reserved for future work.
- Human merge approval moves to `ready-to-merge`; only GitHub confirms `merged`, and deployment evidence is required for `deployed`.
- All item mutations use explicit versions, including artifacts/head updates. Tools never share an implicit version cache across concurrent turns. Head observations older than the current timestamp are harmless no-ops.
- Live agent turns renew their 30-minute claim every minute using a fenced claim token; completion/failure stops renewal. Claimed wakes suppress concurrent duplicates until lease expiry. They do **not** make external side effects exactly once. Work resumes against existing artifacts after crashes. Notification wakes have a separate completion RPC.
- Plan children are atomic and keyed, but cross-item dependencies are recorded in the specification and enforced by keeping dependent work in triage or blocking it. There is no automatic dependency scheduler.
- The Cloudflare bundle vendors all fourteen upstream skills with license and commit provenance. Wrangler uses harnesst's credential path. MCP OAuth remains optional and is not added to core.
- Migrations, workflow, May I functions, local harness and GitHub examples live here; marketplace bundles materialize only agent runtime files.

To update vendored skills, check out the desired `cloudflare/skills` revision and run `node catalog/ledger/vendor-cloudflare.mjs /path/to/checkout`, review changes, bump affected template/bundle versions, and run `npm run catalog:index && npm run catalog:validate`.
