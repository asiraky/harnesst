# SPEC — Vercel deployment with scoped, human-approved credentials (issue #364)

Give harnesst agents the ability to take an app from "code in a GitHub repo" to "deployed
production app on Vercel" with hard security guarantees:

- **No agent ever sees a Vercel credential.** Tokens live in container env only — readable by
  tool code, sealed out of the sandbox shell and out of model context.
- **Per-project blast radius.** A deploying agent holds a project-scoped Vercel token (`vcp_…`)
  that structurally cannot touch any other project.
- **Human-in-the-loop as a harness-enforced gate.** The privileged operations (using the
  full-account token) always require a human approval; per-command approval on deploying agents
  is a per-agent toggle.
- **No bespoke tool per CLI verb.** One generic gated wrapper exposes the full `vercel` CLI; the
  human reviews the actual argv plus the agent's written justification.

## Architecture

```
┌─ dev agent (requester) ─────────────┐      ┌─ vercel-issuer agent ───────────────┐
│ tools/vercel-cli.ts  (gated*)       │      │ tools/vercel-cli.ts  (always gated) │
│   env: VERCEL_TOKEN = vcp_… (proj)  │ ask  │   env: VERCEL_MASTER_TOKEN (account)│
│ skills/deploying-vercel-apps.md     │────► │ tools/vercel-provision.ts (always   │
│                                     │      │   gated; mint + deposit, no stdout) │
└─────────────────────────────────────┘      └──────────────┬──────────────────────┘
        ▲   env delivery = redeploy                         │ POST /api/secrets/deposit
        └───────────────────────────────────────────────────┘ (team-token auth)
```

`*` gated unless the member's `VERCEL_CLI_REQUIRE_APPROVAL` is `0`.

### End-to-end flow

1. Dev agent needs a project → `team ask` to the issuer ("create project `acme-web`, Next.js,
   repo `acme/acme-web`, for member `dev`").
2. Issuer calls `vercel-provision(...)` with a justification → eve parks its turn on the
   `approval: always()` gate → Front of House shows "Approval needed" with the structured
   request. The dev agent's ask returns `{status: "waiting_on_human"}`; it reports and ends its
   turn (it must not re-ask).
3. Human approves → issuer resumes: project created (`POST /v11/projects`, adopting an existing
   same-name project on conflict), `vcp_` token minted (`POST /v3/user/tokens` with
   `projectId` + `expiresAt`), token deposited via `/api/secrets/deposit`. The tool result is
   `{projectId, delivery: "queued"}` — never the token. If the deposit fails after the mint, the
   token is revoked (`DELETE /v3/user/tokens/{id}`); it is never returned.
4. harnesst reconciles the dev member's env (`invalidateAgentEnvironments` → env-revision bump →
   queued same-release redeploy) → project-scoped `VERCEL_TOKEN` (plus `VERCEL_PROJECT_ID`) is
   present in the new container.
5. Issuer notifies the dev member via `team ask (mode: "tell")` — deposit first, notify second,
   so the tell wakes the fresh container.
6. Steady state: the dev agent deploys/configures freely within its one project via the gated
   CLI tool.

## Components

### `catalog/templates/tools/vercel-cli` — the generic gated wrapper

One tool exposing the whole CLI: input `{args: string[], justification, cwd?}`. Enforced in code,
not prompt:

1. Spawns the CLI via `execFile` (argv array, no shell), resolved from the tool's own
   `node_modules` (`vercel` is a declared dependency; the runtime image carries the member's full
   `node_modules`, and the tool process does not share the sandbox filesystem).
2. The token travels child-env only (`VERCEL_TOKEN`, falling back to `VERCEL_MASTER_TOKEN` on
   the issuer); `--token`/`-t` arguments are rejected.
3. `tokens`, `login`, `logout` subcommands are rejected (`vercel tokens add` prints bearer
   tokens to stdout).
4. Defense-in-depth redaction of the configured token values (exact-string) plus `vcp_…`-shaped
   strings from stdout/stderr; exact-match-first so deployment URLs/ids are never mangled.
5. Output truncation cap; result is `{ok, exitCode, stdout, stderr}`.

Approval is a policy, evaluated per call: `VERCEL_MASTER_TOKEN` present → always gated (the
issuer's gate is not configurable); otherwise gated unless `VERCEL_CLI_REQUIRE_APPROVAL === "0"`.
The gate is eve's harness-level `approval` — the turn parks before `execute` and surfaces as a
Front of House approval item; parking is the only durable wait (turn idle timeout is 5 minutes).

Secrets are declared `sandbox: false` (absent flag): tool-process-readable, invisible to the
agent's shell. The skill deliberately ships no `sandbox.bootstrap` — the CLI must not work from
the sandbox shell.

### `catalog/templates/agents/vercel-issuer` — the credential authority

Installed as its own team member holding `VERCEL_MASTER_TOKEN` (the one manually created
credential — the trust root). Ships `vercel-provision` (hardcoded `approval: always()`) and
includes `vercel-cli` (force-gated by the master token's presence).

`vercel-provision` input: `{projectName, targetMember, framework?, gitRepository?,
tokenTtlDays (default 90), justification}`. Execute: create project → mint project-scoped token →
`POST ${HARNESST_SECRETS_DEPOSIT_URL}` (bearer `HARNESST_TEAM_TOKEN`) with
`{member, key: "VERCEL_TOKEN", value, sandboxExposed: false}` → discard the value → return
`{ok, projectId, projectName, tokenExpiresAt, delivery: "queued"}`. Revoke-on-deposit-failure.
`VERCEL_PROJECT_ID` is deposited best-effort alongside. An optional `VERCEL_TEAM_ID` env scopes
the project API calls to a Vercel team.

### `POST /api/secrets/deposit` — the one new harnesst route

`app/routes/api.secrets.deposit.ts`, modeled on the capability proxy:

- **Authn:** bearer → `verifyDelegationToken` → deployment → caller derived server-side; bad
  token → 401; business errors → HTTP 200 `{ok: false, error}`.
- **Authz:** the caller member's **committed** lock must carry the `vercel-issuer` agent install
  (`hasAgentInstalled`, the same convention that gates the deposit URL env var at deploy time in
  `controller.server.ts`). Drafts are not overlaid: a staged install must not grant cross-member
  secret writes. Writable keys are restricted to `VERCEL_*`; `sandboxExposed: true` is refused.
- **Effect:** live roster member → `secrets.set(...)` + `invalidateAgentEnvironments(...)`,
  response `{ok: true, delivery: "queued"}`. Pending member (repo files or staged draft under
  `agents/<name>/`, no `agents` row yet) → sealed into `pending_secrets`
  (`{delivery: "held"}`); the ship point migrates it. Unknown member → refused.
- **Audit:** every authenticated attempt is recorded via `recordCapabilityCall`
  (provider `harnesst`, operation `secrets.deposit`) — caller, target member, key name, never
  the value.

The deposit URL (`HARNESST_SECRETS_DEPOSIT_URL`) is injected at deploy time only for members
whose lock carries the issuer install; the route re-checks the same lock per call, so the env
gate is surface reduction, not the security boundary.

### `catalog/templates/skills/deploying-vercel-apps` + `catalog/templates/bundles/vercel-bundle`

Requester-facing skill (name the tool, don't script mechanics, no secret names) and a one-click
bundle (tool + skill) following `github-bundle`.

## Security invariants (do not regress)

1. No Vercel token in any agent's model context, tool result, delegation message, or sandbox
   shell env — ever.
2. The master token is usable only through the issuer's two always-gated tools; the gate is
   eve's harness-level `approval`, not prompt instructions.
3. The minted project token travels only: issuer tool memory → deposit route → secret store →
   target container env.
4. Cross-member secret writes are authorized by the caller's committed lock carrying the issuer
   install, not by request payload.

## Verified platform facts the design rests on (2026-08-07)

- `VERCEL_TOKEN`-authenticated CLI is fully non-interactive; first `vercel deploy --yes` creates
  the project; `vercel api` exposes the whole REST API under the same token.
- Token scopes: full-account / team / **project** (`vcp_` prefix, denies everything outside one
  project). Only a full-account token can mint tokens (`POST /v3/user/tokens
  {name, projectId, expiresAt}`); the project must exist first. The CLI equivalent
  (`vercel tokens add --project …`) prints the bearer token to stdout — which is why minting
  never goes through the generic CLI wrapper.
- The one-time human browser step (only needed for push-to-deploy) is installing the Vercel
  GitHub App on the org. CLI file-upload deploys need no git integration.

## Open items

- Deploy source of truth: prefer git-connected auto-deploys (push → Vercel builds; CLI for
  config/promote/inspect). If CLI-upload deploys from a repo are needed, the tool must
  materialize the repo itself (clone into a temp dir in the tool process — the sandbox
  filesystem is not shared with the tool runtime).
- Redaction pattern breadth: exact-token + `vcp_…` today; broaden if Vercel introduces new
  token shapes.
- Phase 2 (operator walkthrough on a real Vercel account) is specced in issue #364.
