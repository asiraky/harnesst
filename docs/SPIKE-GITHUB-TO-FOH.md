# Spike: GitHub → Front of House

> The "Follow-up spike — harnesst channel" scoped in
> [`PRD-FRONT-OF-HOUSE.md` §5](./PRD-FRONT-OF-HOUSE.md): prove or deny that a
> harnesst-authored channel (mayi pattern) can home work sessions so `input.requested`
> from any entry point files to the control plane and resumes via signed callback — and
> whether eve's `cross-channel-receive` lets externally triggered work (schedules,
> GitHub) be homed on it.
> **Status:** Complete — verdicts below, **revised 2026-07-27 against a production run**
> · **Owner:** asiraky@gmail.com · **Date:** 2026-07-27
>
> Evidence basis: harnesst `main` @ `33e0f79`, eve `0.24.2` (read from the published
> package's `dist/` + shipped docs), `@mayiapp/eve` `0.3.0` source. File:line references
> to eve are into the published package; everything else is this repo. This document was
> adversarially reviewed (fact-check pass against the code, then an independent
> adversarial review); §5's "contracts to settle" and several §7 corrections came out of
> that review.
>
> **Revision 2 (2026-07-27):** §7's runbook was executed against production
> (`deputy-jaden` on a private target repo, eve `0.22.6` in the deployed image). Four
> findings changed the document: one verdict was wrong (§2 row 3 / §4.2), one §3
> visibility row was wrong (Runs), the recommendation flipped from Option A to Option B,
> and three separate defects were found that no option can paper over (§4.5). Sections
> carrying revised text are marked **[R2]**.

---

## 1. The question

A user tags an agent on a GitHub issue. Today the agent may act, but the work is
invisible to the person operating the team: no FOH session, no needs-you, no inbox item —
and if the agent asks a question mid-turn, **nobody anywhere can see or answer it**.

The PRD asks, specifically:

1. Can a harnesst-authored channel (mayi pattern, baked into the image like
   `ask-teammate`) home work sessions so `input.requested` from any entry point files to
   the control plane and resumes via signed callback?
2. Does eve's `cross-channel-receive` let externally triggered work (schedules, GitHub)
   be homed on that channel?

Outcome required: a design note + go/no-go.

## 2. Verdicts **[R2]**

Six separate verdicts — they do not collapse into one:

| Claim | Verdict |
| --- | --- |
| A harnesst-authored channel (mayi pattern) is buildable with zero eve changes | **Proven** — every API it needs (`defineChannel`, `receive`, channel-owned `input.requested`, resume via a channel-registered route calling `args.send({inputResponses})`) exists in eve 0.24.2 and is exercised in production by `@mayiapp/eve` (§4.3). Gated on raising harnesst's eve floor (§4.4) |
| `cross-channel-receive` re-homes **schedule**-triggered work onto it | **Proven, handler-form schedules only** — `schedule.d.ts:17` gives `defineSchedule` handlers `receive: CrossChannelReceiveFn`; markdown schedules stay task-mode and unparkable (§4.2) |
| Work **arriving at** eve's GitHub channel can be handed off to another channel | **Denied** (unchanged) — `githubChannel`'s inbound hooks (`onComment`, `onIssue`, …) are dispatch *gates* (`return {auth}` or `null`); they never see `args.receive` (§4.2). **Any** GitHub→FOH design therefore starts with the control plane receiving the webhook itself |
| ~~`githubChannel` can never be a `receive` **target**~~ | **RETRACTED — this was wrong.** Revision 1 generalised the HTTP channel's missing `receive` hook to `githubChannel`. It is false in **both** the deployed `0.22.6` and `0.24.2`: `githubChannel` exports a `receive` hook with a documented `GitHubReceiveTarget` (`owner`, `repo`, exactly one of `issueNumber`/`pullRequestNumber`, optional `initialMessage`/`installationId`/`repositoryId`) — "Target accepted by `receive(github, { target })` for proactive sessions". A harnesst-homed session **can** be re-homed onto a GitHub thread (§4.2) |
| A GitHub-homed session can be resumed through eve's built-in HTTP session route | **Denied — proven at runtime, not inferred** (§4.6). `POST /eve/v1/session/:id` with the byte-exact stored continuation token returns HTTP 500 `Cannot deliver inputResponses — the target session was not found via continuation token`. Resume **must** originate from a route registered on the homing channel |
| GitHub → FOH overall | **GO on feasibility, with three blocking defects to fix first** (§4.5). The GitHub half works in production today — mention → dispatch → session → multi-turn continuation are all proven. What is broken is everything harnesst was assumed to already provide: the run reconciler has never populated a single row, run state is destroyed on every redeploy, and the repo checkout fails on every turn |

## 3. Current state (what actually happens today)

Two GitHub App identities exist and never mix:

- **Connect App** — one per harnesst deployment, installed per workspace; used by the
  control plane to read/write config repos. Its webhook (`app/routes/api.github.webhook.tsx`)
  handles `pull_request` only.
- **Agent App** — one per agent, created via the in-app manifest flow
  (`app/github/app-manifest.server.ts:71-96`). Grants `metadata:read, contents:write,
  issues:write, pull_requests:write`; subscribes to `issue_comment, issues, pull_request,
  pull_request_review_comment` (the #151/#153 fix). Its webhook URL is
  `<origin>/e/<envId>/eve/v1/github` — **straight past the control plane** (nginx →
  splitter → agent container), where eve's `githubChannel` verifies the HMAC and runs the
  turn. Mention detection, bot filtering, thread continuation: all inside eve. Note the
  default dispatch gate is **comments only** (`onComment`): with the shipped bare
  `githubChannel({})` (`catalog/templates/channels/github/files/channels/github.ts`),
  the `issues`/`pull_request` event subscriptions are inert — `onIssue`/`onPullRequest`
  are opt-in hooks with no default dispatch (`githubChannel.d.ts:122-131`), so a mention
  in an issue *body* triggers nothing.

What the operator sees of a GitHub-triggered turn:

| Surface | Visibility |
| --- | --- |
| The GitHub issue | ✅ 👀 reaction on dispatch, reply comment as `<slug>[bot]` on completion, error comment on failure (eve built-ins) |
| Back-of-house Runs | ❌ **nothing, ever** — this row said "✅ within ~60s via the pull reconciler" in revision 1. **Wrong**: the reconciler has never produced a row for any channel (§4.5 defect C). The passthrough claim about `$eve.trigger` → `channel:github` (`app/observability/session-turns.server.ts:147-152`) is correct and was confirmed in the container's own event log; it simply never reaches the reconciler |
| FOH activity feed | ⚠️ a generic "`<agent>` ran" row (`app/routes/foh.activity.tsx:148-168` has no `github` case); input/error redacted for members (`app/foh/activity.server.ts:14-20`) |
| FOH sessions / sidebar / inbox | ❌ nothing — no `playground_sessions` row is ever created |
| A mid-turn question (`input.requested`) | ❌ **not deliverable to any actionable surface.** GitHub dispatch runs in conversation mode (`requestInput: true` — eve `dist/src/channel/send.js`, mode defaults to `"conversation"`), so the session parks durably — but `githubChannel` installs no built-in `input.requested` handler (its built-ins are `turn.started`, `message.completed`, `session.failed`/`turn.failed` — `githubChannel.d.ts:72-78`). No issue comment, no FOH item, no answer path. **Confirmed in production** (§4.5 defect B): two `input.requested` events with real `ask_question` prompts, each followed by `turn.completed` with **no** `message.completed` — the question was raised, parked, and delivered nowhere. Revision 1's follow-on note ("the reconciler still settles the run row as *completed* while the session sits parked") describes code that is real (`app/observability/session-turns.server.ts:343-374`) but never runs, because no run row is ever created (§4.5 defect C) |
| Webhook delivery to a stopped (scaled-to-zero) instance | ❌ **lost.** The splitter proxies only `live` deployments and 503s otherwise (`app/deploy/splitter.server.ts:26-56`); nothing on this path wakes the container (`ensureLiveDeploymentForEnvironment` is only called from FOH/control-plane sends), and GitHub does **not** automatically redeliver failed webhooks. A mention while the agent is asleep silently goes nowhere |

The last two rows are the sharpest forms of the problem; §7's runbook reproduces the
park deliberately and fences the delivery-loss one out of the baseline.

## 4. What the spike established about eve

### 4.1 Homing is channel identity

A session is homed on whichever channel's adapter built the `send` that started it
(`createSendFn`, eve `dist/src/channel/send.js`). The homing channel's `events` handlers
own **all** outbound delivery for the session's life — including `input.requested` — and
its continuation-token namespace (`<channelName>:<raw>`). Only a send built from the same
channel can deliver `inputResponses`; a cross-channel attempt misses the token lookup and
throws (`"Cannot deliver inputResponses — the target session was not found via
continuation token"`). This is why harnesst's existing rule holds: anything that might
need a human must run as a harnesst-driven session — the FOH answer path
(`POST /eve/v1/session/:id` with `inputResponses`, `app/agent/talk.server.ts:400-416`)
can only resume sessions homed on the **HTTP channel**.

### 4.2 `cross-channel-receive` — exact semantics **[R2]**

Not a flag or permission: it is the `args.receive(channel, {message, target, auth})`
function handed to **channel route handlers** and **handler-form schedules**
(eve `dist/src/channel/cross-channel-receive.{d.ts,js}`). It starts a *new* session fully
homed on the target channel (adapter, token namespace, event handlers — the target's
`receive` hook calls its own `send`). Constraints that decide this spike:

- The target must be an authored `defineChannel` value registered in `agent/channels/`,
  matched by reference identity (with a route-shape fallback), implementing `receive`.
  The built-in **eve HTTP channel has no `receive` hook and can never be a target.**
- Only route handlers and schedule handlers get `args.receive`.
  `githubChannel`'s inbound hooks get `GitHubInboundContext` (conversation, delivery,
  repository, thread, sender, github handle — no `receive`, no `send`) and return
  `{auth} | null` — a dispatch gate, not a handoff (`githubChannel.d.ts:37-44, 56-64,
  103-137`). Its `events` handlers get `GitHubEventContext` (the GitHub channel context
  plus `ChannelSessionOps`) — again no `send`, no `receive`.
  **Work arriving at eve's GitHub channel cannot be re-homed. Denied.**
- **[R2] But the GitHub channel *is* a valid `receive` target — revision 1 said
  otherwise and was wrong.** `githubChannel` ships a `receive` hook in the deployed
  `0.22.6` and in `0.24.2`, taking a `GitHubReceiveTarget`: `owner`, `repo`, exactly one
  of `issueNumber` / `pullRequestNumber`, optional `initialMessage`, `installationId`,
  `repositoryId` — documented as "Target accepted by `receive(github, { target })` for
  proactive sessions". The error in revision 1 was generalising the built-in **HTTP**
  channel's missing hook to every non-authored channel. Consequence: the direction that
  matters for a *proactive* agent (harnesst-homed session → post/continue on a GitHub
  thread) is available, and a harnesst channel route can hand work **to** GitHub. It does
  not rescue the inbound direction, which stays denied.
- Handler-form schedules (`defineSchedule({cron, run({receive, waitUntil, appAuth})})`)
  *do* get it, and markdown schedules run `mode: "task"` which cannot park for a human —
  so re-homing scheduled work onto a parkable channel is both possible and the only way
  scheduled work can ever ask a human. **Proven** (`schedule.d.ts:17` gives handler-form
  schedules `receive: CrossChannelReceiveFn`; the mayi connection template documents
  exactly this pattern).

### 4.3 The mayi pattern works and is the blueprint

`@mayiapp/eve@0.3.0` (`~/code/mayi/packages/eve/src/channel.ts`) demonstrates, in
production, every mechanism a harnesst channel needs:

- **Home:** `receive(input, {send})` mints a raw continuation token, stashes it in channel
  state, calls `send(message, {auth, continuationToken, state})`.
- **Park → external surface:** the channel's `input.requested` handler seals
  `{version, rawContinuationToken, requestId, sessionId, expiresAt}` with a
  harnesst-provisioned AES-256-GCM key held in the agent's env, memoizes per `requestId`
  for redelivery idempotence, and POSTs the request + callback URL to the external
  service.
- **Resume via signed callback:** a channel-registered `POST` route verifies the
  envelope signature, opens the sealed state, and calls
  `args.send({inputResponses: [{requestId, optionId?, text?}]}, {auth: null,
  continuationToken: raw})` — the send is bound to the channel's own adapter, so delivery
  succeeds. Duplicates degrade to 208, never to a lost answer.
- **Origin:** `EVE_PUBLIC_ORIGIN` tolerates a path prefix — written for harnesst's
  `/e/<envId>` ingress shape, and harnesst already injects it
  (`app/deploy/controller.server.ts:593-598`).

Baking mechanism precedent: `fetchSource` already injects `agent/tools/ask-teammate.ts`
into the Docker build context — never the repo, repo file wins
(`app/deploy/eve-image.server.ts:271-280`). A harnesst channel ships the same way as
`agent/channels/harnesst.ts`.

### 4.4 Version floor

harnesst pins `EVE_MIN_VERSION = "^0.22.0"` (`app/eve/agentModule.ts:23`).
`cross-channel-receive` and the channel APIs above were verified against 0.24.2; the mayi
adapter peer-pins eve **exactly** `0.24.2`. A harnesst channel means raising the floor
(and inheriting the mayi-collision constraint until `@mayiapp/eve` widens its range).
Option A below needs none of this.

**[R2]** Option B needs none of it either: the composition it relies on
(`githubChannel({events})`, `Channel.routes`, `input.requested` as a channel event) is
present in the **deployed 0.22.6**, verified against the running container — so B ships
without moving the floor or inheriting the mayi exact-pin collision. The floor question
belongs to C alone.

### 4.5 What the production run actually showed (2026-07-26/27) **[R2]**

§7's runbook was executed end to end: `deputy-jaden`, a private target repo, a
per-agent GitHub App, three `@deputy-jaden` mentions on one issue. Everything below is
from the live deployment's event log, container filesystem, and the production database —
not from reading source.

**A. The GitHub half works.** Webhook deliveries 200'd. All three mentions landed on a
single eve session (`wrun_01KYGBY0AM9EG04P269QAA36JP`) carrying
`$eve.trigger: channel:github`, i.e. three turns continuing one thread-homed session.
Mention gating, HMAC verification, 👀 reaction, reply comments, and multi-turn thread
continuation are proven in production. **This is the part of the system nobody needs to
build.**

**B. `input.requested` reaches no surface — confirmed, not inferred.** Two
`input.requested` events (`call_Tw9ItEnLTd6kwLlGLGEduheg`,
`call_2D2skVyLmS9sZmmnpzCaHgEO`) carried real `ask_question` prompts with option lists.
Each was followed by `turn.completed` with **no** `message.completed`. Nothing was posted
to GitHub; nothing appeared in harnesst. The user asked the agent a deliberately
ambiguous question, the agent correctly decided to ask back, and the question died
inside the container. This is exactly the gap §1 names, now with a receipt.

*Correction to an inference made during the investigation:* `session.waiting` in the
event stream is **not** evidence that eve discarded the question.
`createSessionWaitingEvent()` takes no arguments and always emits
`{wait: "next-user-message"}` — a constant. It carries no parking information either way,
and no design should read it as a signal.

**C. The run reconciler has never worked — for any channel.** Not a GitHub bug; a
platform one, and the reason "Runs shows the turn" in §3 was wrong.

- The reconciler discovers sessions via `deps.listWorldSessions(worldKey, since)`
  (`app/observability/reconcile.server.ts`), which queries
  `workflow.workflow_runs` in the per-environment world Postgres
  (`app/seams/oss/deploy.localdocker.server.ts:179+`).
- **All nine `harnesst_env_*` databases in production contain zero tables.** Nothing has
  ever written to them.
- Because the deployed eve (`0.22.6`) **has no Postgres workflow backend at all** — zero
  `POSTGRES` matches in the bundle, no `pg`/`postgres` dependency, nothing matching
  `postgres` under `/app/.output/server/`. It persists to
  `WORKFLOW_LOCAL_DATA_DIR || .workflow-data` on the container filesystem.
  `WORKFLOW_POSTGRES_URL` is dead config.
- `listWorldSessions` catches `42P01` (relation missing) and `3D000` (database missing)
  and returns `[]` **with no log line**, so the failure is silent by construction.
- `run_reconcile_cursors` is empty across the whole production database. The
  `schedule`/`discord` rows that do exist in `runs` came from older in-process paths;
  none is newer than 2026-07-18.

**D. Run state is destroyed by every redeploy.** Corollary of C: the only record of a
session lives in the container's `.workflow-data`. This was demonstrated involuntarily —
a v5 rollout at 23:43–23:44 replaced all four agent containers mid-investigation and took
the parked session with it. Any park that outlives a deploy is lost, which makes
"a human answers tomorrow" unimplementable until state moves off the container.

**E. The repo checkout fails on every turn.** `setDockerNetworkPolicy` throws because the
local Docker sandbox supports only allow-all / deny-all, and the error is swallowed. The
agent then answers **with no repo checked out** — plausibly, and wrongly. Any acceptance
test that only reads the reply text will pass while the agent is working blind.
**[WS3] Closed** by the channel template doing the checkout itself; the exact eve code
path, and what an upstream fix would have to change, are in §6.2.

**F. The FOH landing surface itself is fine.** A control-plane probe filed and resolved a
real park: `inbox_items` row `ljbqbltlqohs` (`kind: question`) raised 23:40:58 and
resolved 23:41:10 against session `gcfsywvbgewk`. The park → inbox → answer loop works;
only the path from a GitHub-homed session into it is missing.

**G. The park was gated behind a lock lookup no bundle install satisfies (2026-07-27).**
The first run of the shipped WS1 code posted the question on the issue thread and filed
nothing to the inbox — the `input.requested` handler was firing correctly, but with an
empty `PARK_URL`. `deployRelease` decided whether to inject `HARNESST_FOH_PARK_URL` with
`findInstall(lock, "github", member)?.type === "channel"`, and `deputy-jaden` installed
the **GitHub bundle**, not the standalone channel. A composite install DROPS its parts'
own lock entries (`planInstall`: "the composite's `includes` provenance replaces it"), so
the lock's only row is `{type: "bundle", id: "github-bundle", includes: [{type: "channel",
id: "github"}, …]}` and the lookup returned `undefined`. The marketplace steers people
into the bundle, so the gate was closed for the common path and open only for the rare
one. Fixed by `hasChannelInstalled()`, which looks through `includes` while still
insisting on `type === "channel"` on both branches (a tool named `github` must not be
handed a delegation token).

**H. Every checkout died on `dubious ownership` (2026-07-27).** With the WS3 checkout in
place the agent announced, on the thread, `configuring the git remote failed (exit 128):
fatal: detected dubious ownership in repository at '/workspace'`. The sandbox mounts the
workspace under a uid git does not run as, so the first git command in it fails — and
because WS3 replaced silence with a loud comment, this surfaced immediately instead of
becoming another blind answer. Fixed by adding the checkout path to `safe.directory`
before any git command, in **both** the real global config (the agent runs its own `git
status` there for the rest of the session) and the scoped credential config the fetch
runs under (`GIT_CONFIG_GLOBAL` replaces `~/.gitconfig`; it does not layer over it).

**I. Asking in two places is asking twice (2026-07-27).** With G and H fixed the loop ran
end to end for the first time — and the question arrived both in the inbox and as an issue
comment, by design (§5.3 step 4). That design was wrong. Only one of the two copies can
actually be answered: a comment reply on the thread starts a NEW turn, while the session
sitting on `input.requested` is resumable only through the channel's answer route. The
thread copy is therefore a question that looks answerable and is not. It is now the
FALLBACK — posted only when no park is configured (a self-hosted eve) or when the park
refuses or never answers, because a question nobody can see is the failure this handler
exists to close. Note the agent keeps every ordinary way of talking on the thread: only
`turn.started` and `input.requested` are overridden, so `message.completed` still posts
replies as comments, and the `github-app-auth` skill still gives it `gh`.

**Authoring note from G/H.** A template change only reaches an installed agent when the
install is updated — templates are materialized into the agent's repo at install time
(`app/marketplace/manifest.ts`), so no deploy mode picks up a catalog edit. A bundle whose
*include* changed but whose own `version` did not shows up as **Repair install**, not
**Update** (`repair: !update && (missingFiles || missingIncludes)`), which reads as
corruption rather than as new work. Bump the bundle's version alongside the channel's.

### 4.6 The delivery experiment: resume is channel-scoped at runtime **[R2]**

§4.1 asserted from source that only a send built from the homing channel can deliver
`inputResponses`. That was tested directly, because the whole design hinges on it.

1. `gh issue comment` created session `wrun_01KYGDB5SM5CY7BTTTEMXP298S` with a parked
   request `call_Ayq6fXrusrF37FPV54szwkWG`.
2. The session's own stored hook file records
   `"token": "github:repo:1310524517:issue:1"`.
3. That **byte-identical** token was POSTed to the instance's built-in HTTP session route
   (`POST /eve/v1/session/wrun_01KYGDB5SM5CY7BTTTEMXP298S`) with
   `{message, continuationToken, inputResponses:[{requestId, text}]}` — the same shape
   `app/agent/talk.server.ts:395-425` sends for FOH resumes.
4. Result: **HTTP 500**, `{"error":"Channel handler failed."}`. Container log:
   `channel: 'eve'` … `Cannot deliver inputResponses — the target session was not found
   via continuation token`.

The token was correct; the *caller's channel* was not. Resolution is scoped to the
handling channel. **Therefore the answer route must be registered on the GitHub channel
itself** — no amount of control-plane plumbing can resume a GitHub-homed session through
eve's HTTP route. This single result is what flips §5.5.

Two composition facts settle how that route gets there, both with zero eve changes:

- **The `input.requested` handler is one config key.**
  `githubChannel(config)` builds `{...createDefaultEvents({api, credentials, progress}),
  ...config.events}` — caller events override built-ins — and `"input.requested"` is a
  first-class `GitHubChannelEvents` key. Handlers receive `GitHubEventContext extends
  GitHubChannelContext, ChannelSessionOps`, so the handler has `channel.continuationToken`
  and `channel.thread`: everything needed to file a park.
- **harnesst already owns the file.** The deployed `/app/agent/channels/github.ts` is a
  harnesst catalog template
  (`catalog/templates/channels/github/files/channels/github.ts`), currently the bare
  `export default githubChannel({})`. Adding the handler is editing our own template.
- **Routes are composable.** `Channel` exposes `readonly routes: readonly
  RouteDefinition<TState>[]` (`public/definitions/channel.d.ts:205-213`), so the resume
  route is appended by spreading, not wrapping:

  ```ts
  const base = githubChannel({
    events: { "input.requested": fileParkToControlPlane },
  });
  export default { ...base, routes: [...base.routes, harnesstAnswerRoute] };
  ```

  The appended route holds the GitHub channel's own `args.send`, so
  `args.send({inputResponses}, {continuationToken: raw})` resolves — the mayi resume
  shape (§4.3), on eve's GitHub channel.

## 5. Design: the receiver is forced; the homing target is a decision

> **[R2] Scope correction.** Revision 1 said the control-plane receiver is forced *by
> homing*. It is not: §4.5-A shows the direct-to-instance webhook homing a session
> correctly today. The receiver is forced by **durability and wake-up** — GitHub does not
> redeliver, so a mention to a scaled-to-zero instance is lost (§3, last row), and a park
> that must survive a redeploy cannot live only in the container (§4.5-D). Under Option B
> (now recommended) the receiver's job shrinks to: durably accept, wake the instance,
> forward the signed payload. It no longer decides where work is homed.

Everything below shares a first stage: the **agent App's webhook points at the control
plane** (manifest `hook_attributes.url` → a new receiver route). What differs is where
the received work is homed. §5.1 states the receiver contracts every option must settle —
the adversarial review established that these, not the homing choice, are most of the
real engineering. §5.2–5.4 are the homing options; §5.5 is the recommendation.

### 5.1 Receiver contracts (option-independent — settle these before any build)

1. **Trust policy.** Webhook HMAC authenticates *GitHub*, not the commenter. On a public
   repo, any account could `@mention` a prompt-driven agent whose App holds
   `contents:write` — and whose private key is sandbox-exposed
   (`app/routes/github.apps.callback.tsx` stores `GITHUB_APP_PRIVATE_KEY` with
   `sandboxExposed: true`). This exposure exists in **today's** eve-channel path too;
   the receiver must close it, not inherit it: require a minimum commenter association
   (repo `write`/`maintain`/`admin`) or an explicit allowlist/label gate, make the
   policy per-project configuration, and add rate/cost limits per repo and per actor.
2. **Durable delivery inbox.** GitHub does **not** auto-redeliver failed webhooks, and
   harnesst's job queue is at-least-once (three attempts, running jobs requeued on
   restart — `app/jobs/worker.server.ts`). The receiver needs a delivery table keyed
   `(appBinding, X-GitHub-Delivery)` with state (accepted → dispatched → homed /
   failed), transactional enqueue, and 2xx returned only after durable acceptance.
   Decide and document the at-most-once vs at-least-once choice across the "eve accepted
   the session but harnesst crashed before persisting `externalSessionId`" window.
3. **App binding identity.** Today the callback stores the four `GITHUB_APP_*` secrets
   with `environmentId: null` and no binding row; the receiver must select the right
   webhook secret *before* it can verify HMAC, and `(repo, issue#)` is ambiguous when
   several agents' Apps are installed on one repo. Introduce a first-class binding
   (App id, hook id, project, agent, environment, secret ref, installation state) and
   give each binding an opaque receiver URL. Thread keys become
   `(binding, repository.id, issue.number)`. The route must also be registered as a
   machine endpoint (mutation-origin middleware exempts, like the existing webhook).
4. **Event/action matrix.** The App subscribes to four event types; the receiver must
   define, per event, the accepted actions (`created` vs `edited` vs `deleted`), the
   mention source, the semantic idempotency key (delivery-GUID dedupe does not cover
   edited comments — a new delivery), the thread key, the context builder (PR diff?),
   the reply target, and the ignore behavior.
5. **Wake-on-delivery.** The receiver accepts durably, then wakes the target environment
   (`ensureLiveDeploymentForEnvironment`, 120s budget) before dispatching — turning §3's
   "delivery to a sleeping agent is lost" into a queued wake. This is a categorical
   improvement no in-container design can offer.
6. **GitHub transport ownership.** Acknowledgement (👀), the single completion comment,
   and the error comment should be **control-plane-owned** (posted via the binding's
   installation token, with an idempotency marker) — not delegated to model behavior.
   The agent's final message is comment *content*, not an instruction to call GitHub.
   (Baseline evidence for why: eve posts `message.completed` itself, so a prompt that
   also tells the agent to `gh issue comment` can double-post; and the bundled
   `github-app-auth` skill mints against `.[0].id` — the first installation — which is
   wrong the moment an App has two.)
7. **Session lifecycle.** An issue thread is not a forever-session: define rollover
   (context growth), close/reopen, App uninstall/reconnect, and repo transfer behavior
   in an external-thread table; record origin metadata (repo, issue/comment URLs, GitHub
   actor login) on the session rather than overloading the delegation-only
   `openedByAgentId` field (which would render as "opened by the agent" and misattribute
   activity).

### 5.2 Option A — home on the eve HTTP channel (existing FOH machinery) **[R2] — no longer recommended, see §5.5**

The receiver homes the work as an ordinary FOH session:
`createPlaygroundSession({surface: "foh", userId: null})` →
`claimPlaygroundSessionForTurn` → a **headless turn runner**. Two corrections to the
naive version of this, from the adversarial review:

- `streamTurnResponse` cannot simply be "awaited from a job": it returns a `Response`
  and detaches the drain internally with no completion promise
  (`app/chat/turn-stream.server.ts:94-157`). The implementation extracts a headless
  runner that exposes drain completion (and terminal/parked outcome) to its caller, and
  runs external turns on a **separate concurrency pool** — the existing queue is
  concurrency-1 and shared with builds/deploys, which a multi-minute agent turn must
  not block.
- The turn claim + `beginFohTurn` **supersede a pending park by design**
  (`app/routes/api.foh.stream.ts`, `app/foh/inbox.server.ts`): a later mention on the
  same thread would silently clear the exact unanswered question this feature exists to
  surface. The receiver therefore needs a per-thread ordered mailbox: while a session is
  parked, new GitHub events queue (or open a sibling session) — only a
  request-correlated answer resumes the ask. Rapid double-mentions otherwise resolve as
  claim-winner + 409, not a queue.

What A buys: the park/inbox/needs-you/answer loop costs zero new code (the FOH drain
chokepoints, `app/chat/turn-stream.server.ts:323-353, 452-494`, fire for any
`surface: "foh"` session), live streaming and the composer work unchanged, and there is
exactly **one** continuation mechanism in the product. What it costs: harnesst owns
mention gating and GitHub transport (§5.1 items 4/6 — machinery eve's channel had), and
eve's PR-context assembly is reimplemented if/when PR events dispatch.

### 5.3 Option B — keep eve's GitHub channel, control plane in front **[R2] — RECOMMENDED**

The receiver accepts durably, wakes, then **forwards the original signed payload** to the
instance's `/eve/v1/github` route (Discord-relay precedent) — eve keeps mention gating,
thread continuity, 👀/reply built-ins, PR context. FOH visibility comes from adopting the
eve session (reconciler-style) plus an augmented `channels/github.ts` template (the
Discord template already wraps its channel the same way): override
`events["input.requested"]` to push the park to the control plane, and add a
wrapper-registered resume route so harnesst can answer with `args.send({inputResponses})`.

Cost: FOH gets a second kind of session — github-homed sessions cannot be messaged
through the HTTP-channel send path (§4.1), so the composer needs a per-session delivery
adapter (a server-side `SessionHome` seam can hide this from the UI, but it exists), and
park-filing depends on template adoption per-repo rather than a control-plane deploy.
Strongest where GitHub-native UX dominates and FOH is a read-and-answer surface.

**[R2] What the production run changed here.** Both of B's costs got smaller and A's
central advantage evaporated:

- The "second kind of session" cost is now **unavoidable in every option**, because
  resume-through-the-HTTP-route is denied at runtime (§4.6). A per-session delivery
  adapter (`SessionHome` seam) is table stakes, not a B-specific tax.
- "Template adoption per-repo" was wrong: the template is **ours**, shipped from
  `catalog/templates/channels/github/` and injected at image build. Rolling the handler
  out is a template edit plus a redeploy, the same shape as any other catalog change.
- A's advantage was "the homing half is already proven in production code." §4.5-C/D
  showed that the FOH-adjacent machinery A leans on (run reconciliation, durable session
  state) **does not work in production at all**, while GitHub-channel homing and
  multi-turn continuation **do** (§4.5-A). The proof burden inverted.

**Concrete shape of B, all zero-eve-change (§4.6):**

1. `catalog/templates/channels/github/files/channels/github.ts` becomes
   `githubChannel({events: {"input.requested": …}})` plus an appended resume route.
2. The `input.requested` handler seals `{rawContinuationToken, requestId, sessionId,
   thread, expiresAt}` (AES-256-GCM, key from agent env — mayi's envelope, §4.3),
   memoizes per `requestId` for redelivery idempotence, and POSTs the question plus a
   callback URL to the control plane, which files an `inbox_items` question against an
   adopted FOH session (the surface proven working in §4.5-F).
3. Answering in FOH calls the callback; the channel-registered route opens the envelope
   and calls `args.send({inputResponses: [{requestId, optionId?, text?}]}, {auth: null,
   continuationToken: raw})` — resolving, because the send is the GitHub channel's own.
4. The handler asks in exactly ONE place. **Superseded by finding I:** the first build
   posted the question to the issue thread *as well*, on the theory that both surfaces are
   better than one. They are not — the thread copy cannot be answered (a comment reply
   starts a NEW turn; only the answer route resumes the waiting session), so it reads as a
   second question that silently does nothing. The thread is now the FALLBACK, used only
   when there is no park configured or the park fails.

### 5.4 Option C — home on the harnesst channel (mayi pattern)

The receiver dispatches to the agent's `/eve/v1/harnesst/dispatch` route
(`HARNESST_TEAM_TOKEN`-authenticated, carrying delivery/thread metadata); the
harnesst channel homes the session, pushes `input.requested` to the control plane
(sealed state + signed callback, §4.3), and the control plane adopts the session into
FOH. Same receiver, same §5.1 contracts; the homing side gains **push-based parks**
(no stream-reconstruction inference) and a single generic entry point that also serves
handler-form schedules — the only mechanism by which scheduled work can ever ask a human
(§4.2). Costs: the eve floor rises to ≥0.24.2 (§4.4), FOH live-streaming/composer
parity against a non-HTTP-homed session must be built (same class of problem as B's),
and the channel file + callback crypto are new surface area.

### 5.5 Recommendation and conditions **[R2] — REVISED: B, not A**

**Current recommendation: Option B.** Two runtime results moved it:

1. **Resume is channel-scoped in fact, not just in the type signatures** (§4.6). Option
   A's implicit premise — that GitHub work re-homed onto the HTTP channel keeps one
   continuation mechanism — survives only if the *original* GitHub session is thrown away
   and re-created, which forfeits eve's thread continuity, PR context, and the 👀/reply
   built-ins that already work. Every option now needs a per-home delivery adapter.
2. **The half A treats as free is the half that is broken** (§4.5-C/D). GitHub homing,
   mention gating, and multi-turn continuation work in production today; run
   reconciliation and durable session state do not work for *any* channel. Option B
   preserves the working half and forces us to fix the broken half explicitly, instead of
   building a second consumer of machinery that has never once produced a row.

Cost of B, stated honestly: FOH holds two kinds of session and needs a `SessionHome`
seam for delivery; the composer against a GitHub-homed session is a build (as it is under
C); and the park path only exists for agents whose image carries the updated channel
template.

**Blocking prerequisites — B is not startable until these land** (§4.5):

| # | Defect | Why it blocks |
| --- | --- | --- |
| P1 | Run reconciler produces nothing (world DBs empty, eve has no Postgres backend, `listWorldSessions` swallows `42P01` silently) | Without it there is no back-of-house record of GitHub work, and the FOH adoption step has nothing to adopt |
| P2 | Session state lives only in the container's `.workflow-data` and dies on redeploy | A park that cannot survive a deploy is not a park |
| P3 | `setDockerNetworkPolicy` throws → repo checkout silently skipped | The agent answers with no repo; acceptance tests that read only the reply text pass falsely |

P1 and P2 are the same fix if session/run state is pushed from the agent to the control
plane rather than pulled from a database eve never writes to — which is also the shape
`input.requested` push-parking needs, so B and the platform fix share a mechanism.

Option C (harnesst channel) remains the right home for **schedules** that must ask a
human (§4.2) and can reuse B's control-plane park endpoint verbatim. Option A is
retained below for the record; it is no longer recommended.

<details>
<summary>Revision 1 recommendation (superseded — kept for the record)</summary>

**Sequencing recommendation: build the receiver + Option A first; build the harnesst
channel (C) when schedules-that-ask-humans or push-based parks are actually scheduled —
and let C's receiver be the one A already built.** The reasoning, stated as weights
rather than a verdict-by-adjective: A is the only option whose *homing* half is already
proven end-to-end in production code (FOH sessions, parks, inbox, resume); its costs are
in §5.1, which every option pays anyway. C's unique payoffs (schedules, push parks,
generic dispatch) are real but not GitHub-specific; buying them now adds the version
floor and a parity build to the critical path of a user-visible feature. B wins only if
GitHub-native UX (eve's PR context, reply built-ins) outweighs a unified session model —
revisit if PR-review workflows become the dominant use.

Conditions attached to the GO (from the adversarial review, adopted): Option A proceeds
only with §5.1 items 1–7 and §5.2's two corrections settled in the implementation
design; acceptance criteria must cover the fault matrix in §7's closing note, not just
the happy path.

</details>

Conditions carried forward to B: §5.1 items 1–7 still apply unchanged (they are
receiver contracts, option-independent), P1–P3 above are prerequisites, and acceptance
must cover §7's fault matrix — plus one new case: a park filed, the agent redeployed, and
the answer still delivered.

## 6. Risks and open questions

**[R2] Promoted from risks to confirmed defects** — each needs its own issue; none is
GitHub-specific, and all three were invisible until the runbook was executed:

- **P1 — the run reconciler has never worked** (§4.5-C). Fix direction: stop pulling from
  a world Postgres eve never writes to; have the agent push run/turn state to the control
  plane (same channel as the park push), and at minimum make
  `listWorldSessions`' `42P01`/`3D000` swallow **log** instead of returning `[]` silently.
- **P2 — session state dies with the container** (§4.5-D). `.workflow-data` is not a
  durable store; any redeploy discards parked sessions.
- **P3 — repo checkout fails every turn** (§4.5-E). `setDockerNetworkPolicy` throws on
  the local Docker sandbox (allow-all/deny-all only) and the error is swallowed, so the
  agent answers without its repo. **[WS3] Closed harnesst-side** — the channel template
  now overrides `turn.started` and checks out with a tokenized fetch, and announces a
  failure on the thread instead of swallowing it. §6.2 is the upstream write-up.

- **Webhook cutover:** a GitHub App has one webhook URL. New Apps get the control-plane
  URL from the manifest; existing Apps must be re-pointed by hand (there is still no
  PATCH/re-sync path — #151's unshipped "Consider" item). The runbook always creates a
  fresh App, so it is unaffected.
- **Member visibility:** homed sessions arrive with `userId: null` (team-wide, like
  relay-parked sessions). The activity feed's "github runs are unattributable" redaction
  (`app/foh/activity.server.ts:14-20`) should be revisited once the session carries the
  GitHub actor's login in metadata (§5.1 item 7).
- **Headless recovery:** park/settle repair currently runs when a human opens the session
  page. Webhook-homed sessions that die with the process need the background sweeper FOH
  already wants (`reconcilePlaygroundSessionFromEve` on a timer) — noted, not solved,
  by this spike.
- **Dev-tunnel ergonomics:** the stable per-worktree tunnel host (`*.dev.zero8.ai`) is
  not in Vite's `allowedHosts` (`vite.config.ts` admits `.loca.lt`/`.trycloudflare.com`
  only), and the tunnel health check passes any status < 500, so a 403 looks healthy.
  Until fixed, dev verification uses the quick tunnel (§7 Phase 0). Small code fix,
  separate PR.

### 6.1 Tier 2 — durable park storage: designed, deliberately not built **[WS2]**

P2 ("session state dies with the container", §4.5-D) is real but is **not** what run
visibility needed, so Tier 1 shipped without it. The design that was worked out while
building Tier 1 is recorded here so the next person does not re-derive it.

**The failure it addresses.** A park (WS1) writes a durable row on the harnesst side:
session, `continuationToken`, `resumeVia`, the channel's `state`, and a backfilled
transcript. Answering it POSTs to the channel's answer route on the *instance*, where eve
resumes the session from `WORKFLOW_LOCAL_DATA_DIR` (`.workflow-data`) on the container
filesystem. That directory does not survive a redeploy. So after any redeploy harnesst
still shows an answerable question whose eve-side session no longer exists — the human
answers into a void.

**What is NOT available as a fix.** Making eve's own state durable across deploy targets
would mean changing eve, which is out of bounds. `WORKFLOW_POSTGRES_URL` is inert in
0.22.6 (§4.5-D): there is no Postgres workflow backend to point at.

Three harnesst-owned moves, in increasing cost:

- **T2-a — tell the truth in the UI (cheap, do this first).** A parked session already
  records the `deploymentId` that parked it. If that deployment is no longer the live one,
  the answer box knows the resume will fail *before* the human types. No migration, no new
  storage: it is a join. Even with T2-b or T2-c shipped, this is the honest-state layer.
- **T2-b — replay instead of resume.** When the parking deployment is gone, do not call
  the channel answer route. Re-pose the work as a NEW inbound channel turn on the current
  live deployment, carrying the original request, the park's channel `state` (issue/PR
  coordinates), and the human's answer. This loses eve-side mid-turn context (tool state,
  partial reasoning) but survives redeploys and works on every deploy target, because it
  uses only the channel's ordinary inbound path. Tier 1 makes this materially better than
  it would have been: channel turns now land in `runs`/`run_steps`, so the replay has a
  real transcript to quote instead of a bare prompt.
- **T2-c — persist eve's data dir.** Mount `WORKFLOW_LOCAL_DATA_DIR` on a per-environment
  volume so a redeploy reattaches the same session store (the local-docker target already
  does exactly this shape for agent home directories). Highest fidelity — the original
  session really does resume — but it is one deploy target out of four, it makes rollbacks
  carry state, and it only holds while the volume and the image agree about the format.

**Recommendation:** T2-a now; T2-b when a redeploy-orphaned park is actually observed in
the wild; T2-c only as a local-docker convenience, never as the contract. None of the
three needs a schema change — the park row already carries everything they read.

### 6.2 P3 — the silent checkout failure: the code path, the fix, the upstream ask **[WS3]**

**What eve does.** `githubChannel`'s built-in `turn.started` (`createDefaultEvents`,
`public/channels/github/defaults.js`) reacts 👀 and then calls `checkoutRepositoryForTurn`,
which wraps `checkoutGitHubRepository` (`public/channels/github/checkout.js`) in a
`try/catch` whose entire handler is `logError(log, "GitHub checkout failed — swallowed", e)`.

Inside `checkoutGitHubRepository`, the **first** await is
`sandbox.setNetworkPolicy(buildBrokerNetworkPolicy(token))`. That policy is not hardening —
it is the *only* credential in the operation: `publicRemoteUrl()` returns a bare
`https://github.com/<owner>/<repo>.git` with no token, and the installation token reaches
GitHub solely through the firewall's `Authorization: Basic …` header transform.

`setDockerNetworkPolicy` (`execution/sandbox/bindings/docker-network.js`) throws for any
policy other than the two literals:

> The local Docker sandbox backend supports only the "allow-all" and "deny-all" network
> policies. Domain-level allow-lists and credential brokering require the Vercel backend
> (vercel()) or microsandbox().

(Type-level confirmation: `DockerSandboxNetworkPolicy = "allow-all" | "deny-all"`.)

Because that throw happens before `mkdir -p` and before `git init`, the failure is total
and leaves **no** partial state — no directory, no repo, no marker. The catch then eats it,
the turn proceeds, and the agent answers about code it never read.

**Why harnesst cannot reach it by configuration.** Three independent walls:

1. `GitHubChannelConfig` has no checkout option whatsoever (`api`, `botName`,
   `credentials`, `events`, `progress`, `pullRequestContext`, `route`, plus the `on*`
   inbound hooks). Nothing disables, redirects or parameterises the checkout.
2. Supplying `credentials.installationToken` does not help: checkout resolves the token and
   *then* calls `setNetworkPolicy` unconditionally.
3. The backend cannot be swapped. `defaultBackend`'s probe order is Vercel → Docker →
   microsandbox → just-bash. Vercel abandons self-hosting; microsandbox needs KVM, which a
   typical VPS does not expose; and harnesst mounts the host docker socket and installs the
   Docker CLI in the agent image *specifically* to win the Docker probe
   (`app/seams/oss/deploy.localdocker.server.ts`, `app/deploy/eve-image.server.ts`) so eve
   does not degrade to `just-bash`. `docker.networkPolicy` is a real eve knob but irrelevant:
   its default is already `allow-all`, and the failing policy is the per-turn broker policy
   pushed by checkout, not the sandbox's standing one.

**Nor could harnesst detect it.** No event is emitted (`turn.started` completes normally;
there is no `turn.failed`). The only artifact is `state.checkoutPath` staying `null`, and
that state lives in the container's `.workflow-data` (§4.5-D), never in harnesst's database.
The single real signal is a structured `error` line tagged `github.defaults` in the
container log — and harnesst's only log reader, `containerLogsTail`, is called from two
deploy-time health paths and nowhere else. There is no runtime log surface.

**What was built instead (WS3).** The one harnesst-owned surface that reaches this is the
channel template's `turn.started` override — eve documents that a supplied handler *replaces*
the built-in for that key, and `catalog/templates/channels/discord/.../discord.ts` already
uses the same lever. `catalog/templates/channels/github/files/channels/github.ts` now:

- re-asserts `thread.react("eyes")`, which the override would otherwise silently drop;
- mints an installation token in the instance process (RS256 App JWT from `GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY` → `POST /app/installations/:id/access_tokens`, cached per
  installation) and runs `git init` / `fetch --depth 1` / `checkout --detach` in
  `ctx.getSandbox()`, passing the credential as an `http.extraHeader` in a throwaway
  `GIT_CONFIG_GLOBAL` file that is deleted in a `finally`. This works because the sandbox's
  standing policy is already `allow-all` and `setNetworkPolicy` is never called;
- skips the whole thing when the workspace already sits on the target commit, so no token is
  minted on a repeat turn;
- and, on failure, **posts on the thread**, immediately above the answer it is about to give,
  that it could not check the repository out and that what follows is not based on the code.
  A `confused` reaction and a `[harnesst] github checkout failed` log line go with it.

That last point is the part that survives regardless of whether the tokenized fetch is the
right long-term answer: it converts "confidently wrong, invisibly" into a visible failure at
the exact place a reader is about to be misled.

Two honest costs. Losing firewall brokering means the token is briefly readable inside the
sandbox — scoped to the installation, ~1h lived, never in `.git/config`, never on a command
line, file deleted after the fetch, but a genuine regression against upstream's design. And
`checkoutGitHubRepository` / `resolveGitHubInstallationToken` are not importable
(`public/channels/github/index.d.ts` re-exports only *types* from `auth.js`, and the package
`exports` map has no wildcard subpath), so the JWT mint is a reimplementation, not reuse.

**The upstream ask.** Any one of these would let the template delete its checkout and keep
only the loud-failure handler:

1. **Make the swallow visible.** At minimum, emit an event (or set a documented marker on
   channel state) when the built-in checkout fails, so a caller can react. A `logError` in a
   container nobody reads is not an error report.
2. **Let the checkout fall back.** When `setNetworkPolicy` rejects the broker policy, retry
   with the credential in the request — `http.extraHeader` or an `x-access-token@` remote —
   rather than aborting. The Docker backend is eve's own default for self-hosted deployments;
   its GitHub channel should work on it.
3. **Give `GitHubChannelConfig` a checkout seam** (`checkout: false`, or a
   `checkout(sandbox, descriptor)` override) so a caller can supply the policy that suits
   its backend without reimplementing ref resolution and token minting.
4. **Widen `DockerSandboxNetworkPolicy`** to honour header transforms for a domain allow-list.
   Largest change, and the only one that preserves the credential-brokering property.

### 6.3 Known gaps in what shipped

Defects and blind spots that survive the WS1–WS3 branch. None of these is a caveat that
excuses the design; each is a thing that is wrong, with the file it is wrong in.

**The database integration tests do not run.** `tests/integration/*.db.test.ts` — including
`foh-park.db.test.ts`, the only place the park's idempotency, the `resume_via` jsonb round
trip, the cross-agent refusal and the fenced upsert are exercised against real Postgres — are
wrapped in `describe.runIf(process.env.HARNESST_DB_SMOKE === "1")`. Nothing in
`.github/workflows/` sets that variable, so on every CI run they report as *skipped*, not as
*failed*. The upsert guards are pure Postgres semantics (`ON CONFLICT … DO UPDATE … WHERE`
matching nothing returns no row); the unit tests substitute a hand-written fake for exactly the
behaviour in question, so a change that broke the real SQL would go green everywhere. Closing
this needs a Postgres service container in CI, which the repo does not have today.

**`headSha` is pinned to a shallow checkout, so mid-conversation commits are invisible.** In
`catalog/templates/channels/github/files/channels/github.ts`, `turn.started` skips the fetch
when `git rev-parse HEAD` already equals `channel.state.headSha`. That is right for the second
turn of a thread against an unchanged branch and wrong the moment somebody pushes to it: the
agent keeps answering from the commit it first fetched, with nothing on the thread saying so.
The fetch is `--depth 1`, so there is no history in the sandbox to notice the divergence from
either. A correct version would re-resolve the target ref against the API each turn and refetch
when it moved; that is a second network round trip per turn and was not built here.

**The eyes reaction ignores `progress.reactions`.** The same `turn.started` override reacts
`eyes` unconditionally. eve's built-in handler — which the override *replaces* — reacts only
when the channel's `progress.reactions` option is on. An operator who deliberately turned
reactions off still gets reacted to, on every turn, and the only way to stop it is to edit the
template. The override does not receive the resolved config, so honouring the option means
threading it through the template's own `githubChannel({...})` call site.

**Delegation tokens are deterministic and never expire.** `mintDelegationToken` in
`app/team/token.server.ts` is a bare HMAC over the deployment id: same deployment, same key,
byte-identical token forever, with no nonce, no issued-at and no expiry. It is the credential
for the team relay, the Discord send proxy, the runs ingest and — new on this branch — the
channel park and the channel answer route, and it is baked into container env, so it also
appears in deploy logs and in any image inspection. A leaked token is valid until
`HARNESST_SECRETS_KEY` is rotated, which invalidates every other agent's token at the same
time. Adding an expiry means a re-mint path for long-lived containers; that is a change to the
existing delegation design, not to this workstream, so it was left alone.

**Nothing typechecks the GitHub channel template.** `catalog/templates/**/*` is excluded from
`tsconfig.json`, and `eve` is not a dependency of this repository — so the 518-line
`channels/github.ts` that ships to customer repos is never compiled by `npm run typecheck`, and
could not be even if it were included. `tests/unit/github-channel-checkout.test.ts` reaches it
by compiling the file with esbuild (type *stripping*, no checking) and evaluating it against
hand-written stubs for `eve/channels`, `eve/channels/github` and `node:crypto`. Those stubs are
now typed against eve 0.22.6's documented shapes, so a drift in the signatures the template uses
shows up as a compile error *in the test file* — but the stubs are a transcription, not the real
typings, and a template that used an eve API the stubs do not model would still compile and
still fail in a container. The only real fix is adding `eve` as a devDependency and typechecking
the catalog against it.

## 7. Verification runbook

> **[R2] This runbook was executed against production on 2026-07-26/27 and its results
> are §4.5.** It remains valid as the *before* baseline, with two corrections found by
> running it: Phase 6 will show **no** Runs row (not "a row within ~60s" — §4.5-C), and
> any observation of the agent's reply should not be read as evidence the repo was
> checked out (§4.5-E). **[WS3]** On an image carrying the 0.4.0 GitHub channel template
> that last correction inverts: a failed checkout now posts "I could not check out …" on
> the thread, so the *absence* of that comment is the evidence the repo was read.

Everything below is executable **today, on `main`, with no spike code** — it verifies the
factual claims this document makes (§3's visibility table, including the silent-park gap)
end to end: create a repo, create an agent, give it tools and a system prompt, mint its
GitHub App, install that App on a target repo, tag it on an issue, and observe every
outcome. Each observation maps to a claim; the G rows are the gap §5 closes, so this
runbook is also the **before** baseline for accepting that implementation.

### Phase 0 — prerequisites

1. **Docker Desktop running** (local deploys use `HARNESST_DEPLOY_TARGET=local-docker`;
   10-minute health budget on first build).
2. **Dev server through a public tunnel** — mandatory, twice over: the GitHub App
   manifest bakes the browsing origin into the webhook URL, and GitHub must be able to
   reach it. Use the **quick tunnel**:
   ```
   npm run dev:tunnel -- --quick
   ```
   (The stable named tunnel requires `npm run tunnel:init` to have been run once from
   the main checkout, and its `*.dev.zero8.ai` host is currently rejected by Vite's
   dev-server allowlist — §6. The quick tunnel's `*.trycloudflare.com` host is
   allowlisted.)
   Then do **everything in the browser via the printed tunnel origin**, not `localhost`
   — the App-creation page shows a *Local development origin* callout if you get this
   wrong. **First, load the tunnel origin in the browser and confirm the app renders**
   (a Vite "Blocked request" / 403 page means the host isn't allowlisted).
   ⚠️ The quick-tunnel URL is **ephemeral**: if the tunnel process restarts, the URL
   changes and the webhook URL baked into any already-created GitHub App silently breaks
   (fixable on github.com under the App's settings → Webhook URL). Keep the process
   alive for the whole runbook.
3. **Sign in** (email/password; email verification is not required for signup) as an
   **owner/admin** — back of house is owner/admin-only.
4. **Workspace default model set**: back of house → Settings → Model providers. Nothing
   deploys or runs without it; agent-template installs are blocked outright. Use a
   provider/model you have already seen complete a Playground turn in this workspace —
   the HITL probe below depends on the model actually calling tools.

### Phase 1 — create the repo (agent's home)

1. FOH (`/`) → account menu (bottom of sidebar) → **New repository** (`/connect`).
2. If prompted, **Install the GitHub App** (this is the workspace-level *Connect App*
   install + a GitHub OAuth ownership check — distinct from the per-agent App in
   Phase 4).
3. Card **"Create a new repository"**: layout **Single agent**, GitHub owner, repository
   name (e.g. `spike-gh-foh`), **Agent's name** (e.g. `deputy`) → **Create & scaffold**.
   harnesst creates a private GitHub repo with the eve scaffold and lands you on the
   repo page.

### Phase 2 — system prompt

Overview → **Instructions** → **Edit** (this is `agent/instructions.md` — the always-on
system prompt, a file in the repo, not a DB field). Paste:

```markdown
You are deputy, a software agent responding to work that arrives from GitHub issues.

When a request references a GitHub issue (owner/repo and issue number):
1. Authenticate as your GitHub App using the github-app-auth skill (mint a GH_TOKEN;
   you act as your app slug with a [bot] suffix).
2. Read the issue and its comments with `gh issue view` before acting.
3. Do the work requested. Keep it small and verifiable.
4. Your final reply is delivered to the issue automatically; do not post an extra
   `gh issue comment` unless you are explicitly asked to comment on a different issue.
5. If the request is ambiguous or requires a decision you cannot make, ask the human
   through your built-in question mechanism (request user input) and stop until it is
   answered. Never post the question as an issue comment, never guess, and never
   proceed without the answer.
```

Click **Save**, then **Publish** in the header (post-#228 UI: Save keeps the change until
Publish takes everything live; pick the `default` environment when asked). The first
publish builds the image and starts the container — expect several minutes cold.

> Rule 4 exists because eve's GitHub channel posts the agent's completed message to the
> issue itself — a prompt that also runs `gh issue comment` double-posts (record it in
> O2 if it happens anyway). Rule 5 arms the HITL probe: it must force eve's
> `input.requested`, not a comment that merely *contains* a question.

### Phase 3 — tools

1. **Marketplace** → **GitHub** bundle (`github-bundle` = `channel/github` +
   `skill/github-app-auth`) → **Install** → Target: this repo + agent → complete the
   wizard (the four `GITHUB_APP_*` secrets show as *provisioned* — the App flow in
   Phase 4 fills them).
2. **Publish** again if the install added files after your first publish.

The `github-app-auth` skill is what installs `gh`, `git`, `jq`, `openssl` into the
sandbox and teaches the token mint. No other tools are needed for this runbook.

### Phase 4 — the agent's GitHub App + target-repo installation

1. Create the **target repo** on GitHub — a repo you own, e.g. `spike-foh-target`
   (**private**, which also keeps the Phase 5 trust surface closed — §5.1 item 1; it
   does *not* need to be an eve repo). This is "the Git repo you install the agent
   onto".
2. Repo page → **Deployment** tab → **Channels** card → **GitHub** row → **Connect
   GitHub**. Verify the shown webhook URL is your **tunnel** origin
   (`https://…/e/<envId>/eve/v1/github`), then **Continue to GitHub**.
3. On GitHub: confirm App creation (adjust the proposed name only if GitHub reports a
   collision — the name/slug must be globally unique). GitHub bounces you back;
   harnesst stores `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
   `GITHUB_APP_SLUG` as agent secrets, then forwards you to the App's **Install** page.
4. **Install the App**, choosing **Only select repositories** → your target repo.
   (Registration ≠ installation — skip this and the agent can see nothing. Also install
   it **only** on the target repo: the bundled auth skill mints against the App's first
   installation, so a second installation makes the token nondeterministic.)
5. Back on the Deployment tab, the GitHub row shows **@\<slug\>** and the installation.
   **Write down the slug** — that literal string is how you tag the agent. It is
   project-suffixed (e.g. `deputy-spike-gh-foh`), *not* the bare agent name.
6. **Redeploy — required.** Container env is frozen at creation (issue #236): the four
   secrets minted in step 3 do not reach the already-running container until a fresh
   deploy. Creating secrets saves no repository change, so the header shows a quiet
   `Live · vN` with **no Publish button** — instead use **Deployment → Version history →
   current version → Redeploy**, confirm the environment, and wait for the row to show
   Live again. Skipping this is the #1 way this runbook "fails".

### Phase 5 — tag the agent

**Immediately before mentioning, confirm the deployment row is Live** — a stopped
(scaled-to-zero) instance makes the splitter 503 the delivery, GitHub does **not**
auto-redeliver, and the mention is silently lost (§3, last row). If that happens, the
App's **Advanced → Recent Deliveries** page on github.com shows the failure and offers
manual **Redeliver**.

On the **target repo**, open an issue:

> **Title:** Add a CONTRIBUTING note
> **Body:** We need a short CONTRIBUTING.md draft.

Then — **as a comment on that issue, not in the body** (§3: only `onComment` dispatches
by default; issue-body mentions are inert):

> @\<slug\> please reply on this issue with a three-bullet draft of a CONTRIBUTING.md
> for this repo.

The literal `@<slug>` string is matched by eve inside the container (GitHub won't
autocomplete App bots — type it manually; it also won't render as a link — that's
expected).

### Phase 6 — observe the outcomes

Baseline loop (expected within ~a minute of the mention):

- [ ] **O1 — dispatch:** 👀 reaction appears on your comment (eve `turn.started`
      built-in).
- [ ] **O2 — result on GitHub:** the agent's reply lands on the issue as `<slug>[bot]`
      (eve's `message.completed` built-in). If a *second*, near-duplicate comment
      appears, the model also ran `gh issue comment` despite rule 4 — record it; it is
      evidence for §5.1 item 6 (transport must not be model-owned).
- [ ] **O3 — back of house:** ~~Runs tab shows a new run within ~60s~~ **[R2] observed:
      the Runs tab stays empty — permanently.** The reconciler produces nothing for any
      channel (§4.5-C). The trigger string *is* `channel:github`, confirmed in the
      container's event log; it never reaches the database. Treat an empty Runs tab as
      the expected (broken) baseline, not as a failed setup.
- [ ] **O4 — FOH activity:** the team's activity feed shows a generic "`deputy` ran"
      entry (unstyled for github — claim §3).
- [ ] **O5 — thread continuity:** reply on the same issue with `@<slug> now shorten it
      to two bullets` → the follow-up runs in the same eve session. Verify in the Runs
      list: each run's title is `<eveSessionId>:<turnId>` — the prefix before the final
      colon must match between the two runs.

The gap (the point of the spike — these are **expected to be missing**):

- [ ] **G1 — no FOH session:** the agent's session list in FOH shows nothing for this
      work; it cannot be opened, streamed, or messaged.
- [ ] **G2 — no inbox/needs-you:** sidebar badge and inbox stay empty throughout.

HITL probe (reproduces the undeliverable park):

1. New issue on the target repo (any title/body), then **as a comment**:
   > @\<slug\> I need a `.gitignore` for this repo, but you must first ask me — via
   > your built-in question mechanism, not as an issue comment — which language
   > toolchain to target. Do not guess and do not write anything until I answer.
2. Expected per §3: the turn dispatches (👀), the agent files eve's `input.requested`,
   and the question reaches **no actionable surface**: no issue comment, no FOH inbox
   item, no answer path anywhere. Two important renderings to record precisely:
   - ~~**Runs will likely show the run as *completed***~~ **[R2] observed: Runs shows
     nothing at all** — no row to settle, because none is ever created (§4.5-C). The
     predicted "completed run hiding a parked session" is real code that never executes.
     The rendering is *more* deceptive than predicted: the question exists only inside
     the container.
   - The issue thread simply goes quiet. **[R2] confirmed** — `input.requested` followed
     by `turn.completed` with no `message.completed` (§4.5-B).
   - **[R2] The park does not survive a redeploy** (§4.5-D). If the agent is redeployed
     between the probe and your inspection, the parked session is gone; re-run the probe
     rather than concluding it never parked.
   - [ ] **G3 — the parked question is not delivered to any actionable surface (issue
         or FOH), while Runs shows the turn as settled.** Record exactly what each
         surface shows.
   - If instead the agent *posts* its question as a comment or answers without asking,
     the model disobeyed the probe prompt — note it and re-run; the probe verifies
     surface behavior, and needs a real `input.requested` to do so.
3. Cleanup: the parked eve session **persists** — the bare GitHub channel has no
   issue-event handler (closing the issue changes nothing). There is no supported
   teardown; leave it parked and **use a fresh issue for every subsequent run**.
   **[R2] correction:** "local redeploys deliberately preserve the environment's durable
   state" is true of the *environment* (volumes, secrets) but **not** of eve session
   state, which lives in the container's `.workflow-data` and is destroyed on every
   redeploy (§4.5-D).

### Acceptance mapping

**[R2] Result of the 2026-07-27 execution:** O1, O2, O4, O5 passed; **O3 failed** (no run
row — §4.5-C, and the claim itself was wrong, not the run); G1–G3 confirmed. The spike's
premise and gap are real, and three defects outside the spike's original scope were found
(§4.5-C/D/E).

O1–O5 passing plus G1–G3 confirmed = every §3 claim verified = the spike's premise and
gap are real. For the ~~Option A~~ **[R2] Option B** implementation, the happy-path
criteria are the inversion
of G1–G3 (mention → FOH session exists and streams; question → needs-you + inbox item,
answerable inline, answer resumes the turn and the result lands back on the issue; O-row
GitHub behavior preserved — under B, by eve's own built-ins rather than by
control-plane transport). The **fault matrix** is part of
acceptance, not an appendix — the implementation PR must state expected delivery state,
FOH state, GitHub response, and operator-visible diagnostics for at least: an
unauthorized commenter; two agents' Apps on one repo; an edited comment; a PR review
comment; two rapid mentions; a mention while the session is parked; control-plane
downtime during delivery; a cold (scaled-to-zero) instance; App uninstall/reconnect;
a crash before and after eve accepts the turn; queue retry exhaustion; duplicate
GitHub output; **[R2] and a redeploy between park and answer**.
