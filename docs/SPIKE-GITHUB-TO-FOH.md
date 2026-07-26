# Spike: GitHub → Front of House

> The "Follow-up spike — harnesst channel" scoped in
> [`PRD-FRONT-OF-HOUSE.md` §5](./PRD-FRONT-OF-HOUSE.md): prove or deny that a
> harnesst-authored channel (mayi pattern) can home work sessions so `input.requested`
> from any entry point files to the control plane and resumes via signed callback — and
> whether eve's `cross-channel-receive` lets externally triggered work (schedules,
> GitHub) be homed on it.
> **Status:** Complete — verdicts below · **Owner:** asiraky@gmail.com · **Date:** 2026-07-27
>
> Evidence basis: harnesst `main` @ `33e0f79`, eve `0.24.2` (read from the published
> package's `dist/` + shipped docs), `@mayiapp/eve` `0.3.0` source. File:line references
> to eve are into the published package; everything else is this repo. This document was
> adversarially reviewed (fact-check pass against the code, then an independent
> adversarial review); §5's "contracts to settle" and several §7 corrections came out of
> that review.

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

## 2. Verdicts

Four separate verdicts — they do not collapse into one:

| Claim | Verdict |
| --- | --- |
| A harnesst-authored channel (mayi pattern) is buildable with zero eve changes | **Proven** — every API it needs (`defineChannel`, `receive`, channel-owned `input.requested`, resume via a channel-registered route calling `args.send({inputResponses})`) exists in eve 0.24.2 and is exercised in production by `@mayiapp/eve` (§4.3). Gated on raising harnesst's eve floor (§4.4) |
| `cross-channel-receive` re-homes **schedule**-triggered work onto it | **Proven, handler-form schedules only** — `schedule.d.ts:17` gives `defineSchedule` handlers `receive: CrossChannelReceiveFn`; markdown schedules stay task-mode and unparkable (§4.2) |
| `cross-channel-receive` re-homes **GitHub**-triggered work onto it | **Denied** — eve's `githubChannel` inbound hooks (`onComment`, `onIssue`, …) are dispatch *gates* (`return {auth}` or `null`); they never see `args.receive`, so work arriving at the GitHub channel cannot be handed to another channel (§4.2). **Any** GitHub→FOH design therefore starts with the control plane receiving the webhook itself |
| GitHub → FOH overall | **GO on feasibility** — the control-plane receiver is forced (above), and every downstream mechanism it needs exists and is proven in-tree. **Where the received work is homed is a weighted sequencing decision, not a foregone conclusion** — §5 lays out the options, the contracts any of them must settle, and a recommendation with its conditions stated |

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
| Back-of-house Runs | ✅ within ~60s, via the pull reconciler (`app/observability/reconcile.server.ts:367-497`). The channel string is passed through from eve's `$eve.trigger` verbatim (`app/observability/session-turns.server.ts:147-152`); eve rewrites authored-channel adapter kinds to `channel:<name>`, so expect `github` or `channel:github` — the runbook records the actual value |
| FOH activity feed | ⚠️ a generic "`<agent>` ran" row (`app/routes/foh.activity.tsx:148-168` has no `github` case); input/error redacted for members (`app/foh/activity.server.ts:14-20`) |
| FOH sessions / sidebar / inbox | ❌ nothing — no `playground_sessions` row is ever created |
| A mid-turn question (`input.requested`) | ❌ **not deliverable to any actionable surface.** GitHub dispatch runs in conversation mode (`requestInput: true` — eve `dist/src/channel/send.js`, mode defaults to `"conversation"`), so the session parks durably — but `githubChannel` installs no built-in `input.requested` handler (its built-ins are `turn.started`, `message.completed`, `session.failed`/`turn.failed` — `githubChannel.d.ts:72-78`). No issue comment, no FOH item, no answer path. Note the reconciler still *settles the run row*: `session.waiting` with a pending request completes the folded turn (`app/observability/session-turns.server.ts:343-374`), so Runs shows a **completed** run (the question may appear as a step input) while the eve session sits parked forever behind it |
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

### 4.2 `cross-channel-receive` — exact semantics

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

## 5. Design: the receiver is forced; the homing target is a decision

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

### 5.2 Option A — home on the eve HTTP channel (existing FOH machinery)

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

### 5.3 Option B — keep eve's GitHub channel, control plane in front

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

### 5.5 Recommendation and conditions

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

## 6. Risks and open questions

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

## 7. Verification runbook

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
- [ ] **O3 — back of house:** Runs tab shows a new run within ~60s (the reconciler's
      pull interval). **Record the exact channel string** — expected `github` or
      `channel:github` (eve rewrites authored-channel adapter kinds; §3).
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
   - **Runs will likely show the run as *completed***, possibly with the question
     visible as a tool-step input — the reconciler settles a turn whose session went
     `waiting` with a pending request (§3). The park lives on the *eve session*, behind
     a "completed" run row. A completed run + a question nobody can answer **is** the
     gap, rendered at its most deceptive.
   - The issue thread simply goes quiet.
   - [ ] **G3 — the parked question is not delivered to any actionable surface (issue
         or FOH), while Runs shows the turn as settled.** Record exactly what each
         surface shows.
   - If instead the agent *posts* its question as a comment or answers without asking,
     the model disobeyed the probe prompt — note it and re-run; the probe verifies
     surface behavior, and needs a real `input.requested` to do so.
3. Cleanup: the parked eve session **persists** — the bare GitHub channel has no
   issue-event handler (closing the issue changes nothing) and local redeploys
   deliberately preserve the environment's durable state. There is no supported
   teardown; leave it parked and **use a fresh issue for every subsequent run**.

### Acceptance mapping

O1–O5 passing plus G1–G3 confirmed = every §3 claim verified = the spike's premise and
gap are real. For the Option A implementation, the happy-path criteria are the inversion
of G1–G3 (mention → FOH session exists and streams; question → needs-you + inbox item,
answerable inline, answer resumes the turn and the result lands back on the issue; O-row
GitHub behavior preserved via control-plane transport). The **fault matrix** is part of
acceptance, not an appendix — the implementation PR must state expected delivery state,
FOH state, GitHub response, and operator-visible diagnostics for at least: an
unauthorized commenter; two agents' Apps on one repo; an edited comment; a PR review
comment; two rapid mentions; a mention while the session is parked; control-plane
downtime during delivery; a cold (scaled-to-zero) instance; App uninstall/reconnect;
a crash before and after eve accepts the turn; queue retry exhaustion; and duplicate
GitHub output.
