# Spike: GitHub → Front of House

> The "Follow-up spike — harnesst channel" scoped in
> [`PRD-FRONT-OF-HOUSE.md` §5](./PRD-FRONT-OF-HOUSE.md): prove or deny that a
> harnesst-authored channel (mayi pattern) can home externally triggered work — GitHub
> events in particular — so it lands in Front of House with `input.requested` routed to the
> control plane and resumed via signed callback.
> **Status:** Complete — verdict below · **Owner:** asiraky@gmail.com · **Date:** 2026-07-27
>
> Evidence basis: harnesst `main` @ `33e0f79`, eve `0.24.2` (read from the published
> package's `dist/` + shipped docs), `@mayiapp/eve` `0.3.0` source. File:line references
> to eve are into the published package; everything else is this repo.

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

## 2. Verdict

| Claim | Verdict |
| --- | --- |
| A harnesst-authored channel (mayi pattern) is buildable with zero eve changes | **Proven** — every API it needs (`defineChannel`, `receive`, channel-owned `input.requested`, resume via a channel-registered route calling `args.send({inputResponses})`) exists in eve 0.24.2 and is exercised in production by `@mayiapp/eve` (§4.3) |
| `cross-channel-receive` re-homes **schedule**-triggered work onto it | **Proven** — handler-form schedules receive `args.receive`; the mayi connection template already ships exactly this pattern (§4.2) |
| `cross-channel-receive` re-homes **GitHub**-triggered work onto it | **Denied** — eve's `githubChannel` inbound hooks (`onComment`, `onIssue`, …) are dispatch *gates* (`return {auth}` or `null`); they never see `args.receive`, so work arriving at the GitHub channel cannot be handed to another channel (§4.2). GitHub→FOH therefore requires the **control plane to receive the webhook itself**, with or without a harnesst channel |
| **Go/no-go on GitHub → FOH** | **GO** — but not via the harnesst channel. The recommended path (§5, Option A) homes GitHub-triggered work on the eve HTTP channel through the existing FOH machinery; it needs no eve-floor change and reuses the park/inbox/resume chokepoints FOH already has. The harnesst channel remains worth building — for schedules, push-based parks, and future entry points — as a separate follow-up (§5, Option C) |

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
| A mid-turn question (`input.requested`) | ❌ **invisible everywhere.** GitHub dispatch runs in conversation mode (`requestInput: true` — eve `dist/src/channel/send.js`, mode defaults to `"conversation"`), so the session parks durably — but `githubChannel` installs no built-in `input.requested` handler (its built-ins are `turn.started`, `message.completed`, `session.failed`/`turn.failed` — `githubChannel.d.ts:72-78`). The question is delivered nowhere: not to the issue, not to harnesst. The turn hangs until someone happens to continue the thread |

That last row is the sharpest form of the problem, and §7's runbook reproduces it
deliberately.

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
  harnesst-provisioned AES-256-GCM key held in the agent's env, memoizes per `requestId` for redelivery idempotence, and POSTs the
  request + callback URL to the external service.
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

## 5. Design options and recommendation

### Option A — control-plane webhook receiver, HTTP-channel homing (**recommended; build this**)

Point the **agent App's webhook at the control plane** (manifest `hook_attributes.url` →
new route, e.g. `POST /api/github/agent-events`). On `issue_comment`/`issues` events:

1. Verify the per-agent `GITHUB_WEBHOOK_SECRET` (already in the agent's secret store,
   runtime-only). Resolve App → agent → project.
2. Gate exactly like eve does: literal `@<GITHUB_APP_SLUG>` match, drop `sender.type ===
   "Bot"` (loop prevention), dedupe on delivery id.
3. Home the work as an FOH session using the machinery that already exists end-to-end:
   `createPlaygroundSession({surface: "foh", userId: null, openedByAgentId})` → wake
   (`ensureLiveDeploymentForEnvironment`, 120s budget) →
   `claimPlaygroundSessionForTurn` → `streamTurnResponse({channel: "foh"})`, awaited from
   a queue job (GitHub's delivery budget is ~10s — enqueue, don't inline; precedent:
   `api.github.webhook.tsx`). Keep a `(repo, issue#) → sessionId` mapping so later
   mentions on the same issue continue the same session.
4. The park/inbox/needs-you/resume loop then costs **zero new code**: the drain
   chokepoints (`app/chat/turn-stream.server.ts:323-353, 452-494`) file and resolve inbox
   items, and a human's inline FOH answer resumes the turn through the existing
   continuation path.
5. Posting back to GitHub is the **agent's job**, via its own App credential
   (`github-app-auth` skill: mint `GH_TOKEN`, act as `<slug>[bot]`), instructed by its
   system prompt and by a context preamble the receiver prepends to the turn
   ("this request came from issue #N in owner/repo — post your result there as a
   comment"). The eve `githubChannel` file stays installed but no longer receives
   deliveries; the github-bundle remains the credential + skill provisioning path.

Trade-offs, stated honestly: harnesst re-implements the mention gate (small, and we
control it — label dispatch becomes possible harnesst-side later); eve's GitHub-surface
niceties (👀 reaction, automatic reply comment, PR-context assembly) are forfeited or
moved to the agent's own behavior; completion must notify the issue via the agent rather
than a channel built-in.

What Option A buys: **full FOH parity** — live streaming in the session pane, needs-you
badges, inbox answers, activity attribution — because a GitHub-triggered session becomes
indistinguishable from a human-opened one.

### Option B — augment the `channels/github.ts` template (rejected for FOH)

Keep eve's dispatch and GitHub-surface delivery; override `events["input.requested"]` in
the catalog template file (the Discord template already wraps its channel this way) to
POST the question + continuation token to the control plane, and add a wrapper-registered
resume route so harnesst can answer with `args.send({inputResponses})`. Sessions stay
github-homed; harnesst adopts them read-only (reconciler-style) with an answer side-path.

Rejected because FOH parity splinters: the FOH composer's send path
(`POST /eve/v1/session/:id`) cannot deliver into a github-homed session (§4.1), so
"message the agent in this session" — the core FOH gesture — would need a second,
github-specific delivery route, and every FOH surface would need to understand two kinds
of session. Worth keeping in the back pocket for repos where GitHub-surface replies must
stay channel-automatic.

### Option C — the harnesst channel (mayi pattern): build later, for what it's uniquely good at

Verified feasible (§4.3), but for GitHub it changes nothing structural: eve's GitHub
channel can't hand work to it (§4.2), so the control plane must still receive the webhook
— at which point it can home the session on the HTTP channel (Option A) with strictly
less machinery. The harnesst channel's real payoffs are:

- **Schedules that can ask a human** — the only mechanism that exists at all
  (handler-form schedule → `receive(harnesstChannel, …)`).
- **Push-based parks** — `input.requested` filed to the control plane at the moment it
  happens, replacing stream-reconstruction (today's relay/drain inference) with the mayi
  callback shape: sealed state, signed envelope, idempotent redelivery, 208-on-duplicate.
- **A single generic entry point** (`/eve/v1/harnesst/dispatch`, `HARNESST_TEAM_TOKEN`-
  authenticated) for any future trigger the control plane wants to originate.

Gate it on the eve-floor decision (≥0.24.2) and ship it as the follow-up the PRD already
anticipates. Sequencing note: A first also de-risks C — the receiver, session-adoption,
and inbox surfaces A builds are exactly the control-plane half C needs.

## 6. Risks and open questions

- **Webhook cutover:** a GitHub App has one webhook URL. New Apps get the control-plane
  URL from the manifest; existing Apps must be re-pointed by hand (there is still no
  PATCH/re-sync path — #151's unshipped "Consider" item). The runbook always creates a
  fresh App, so it is unaffected.
- **Receiver correctness is load-bearing:** bot-sender filtering prevents comment loops;
  delivery-id dedupe prevents double turns on GitHub redelivery. Both must be in the
  first cut.
- **Issue-thread fan-in:** two rapid mentions on one issue race the
  `(repo, issue#) → session` map; the turn claim (`claimPlaygroundSessionForTurn`)
  serializes them, but the second mention's UX (queued? rejected? appended?) needs a
  decision at build time.
- **Member visibility:** homed sessions arrive with `userId: null` (team-wide, like
  relay-parked sessions). The activity feed's "github runs are unattributable" redaction
  (`app/foh/activity.server.ts:14-20`) should be revisited once the session carries the
  GitHub actor's login in metadata.
- **Headless recovery:** park/settle repair currently runs when a human opens the session
  page. Webhook-homed sessions that die with the process need the background sweeper FOH
  already wants (`reconcilePlaygroundSessionFromEve` on a timer) — noted, not solved,
  by this spike.

## 7. Verification runbook

Everything below is executable **today, on `main`, with no spike code** — it verifies the
factual claims this document makes (§3's visibility table, including the silent-park gap)
end to end: create a repo, create an agent, give it tools and a system prompt, mint its
GitHub App, install that App on a target repo, tag it on an issue, and observe every
outcome. Each observation maps to a claim; the two ❌ rows are the gap Option A closes,
so this runbook is also the **before** baseline for accepting that implementation.

### Phase 0 — prerequisites

1. **Docker Desktop running** (local deploys use `HARNESST_DEPLOY_TARGET=local-docker`;
   10-minute health budget on first build).
2. **Dev server through the public tunnel** — mandatory, twice over: the GitHub App
   manifest bakes the browsing origin into the webhook URL, and GitHub must be able to
   reach it. From the worktree/checkout root:
   ```
   npm run dev:tunnel
   ```
   Then do **everything in the browser via the tunnel origin the script prints**
   (`https://<label>-<hash>.dev.zero8.ai`), not `localhost` — the App-creation page
   shows a *Local development origin* callout if you get this wrong.
3. **Sign in** (email/password; email verification is not required for signup) as an
   **owner/admin** — back of house is owner/admin-only.
4. **Workspace default model set**: back of house → Settings → Model providers. Nothing
   deploys or runs without it; agent-template installs are blocked outright.

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
4. Post your result as a comment on that issue with `gh issue comment`. Every piece of
   work that starts from an issue must end with a comment on that issue — that is your
   report channel.
5. If the request is ambiguous or requires a decision you cannot make, ask a question
   and wait for the answer before proceeding.
```

Click **Save**, then **Publish** in the header (post-#228 UI: Save keeps the change until
Publish takes everything live; pick the `default` environment when asked). The first
publish builds the image and starts the container — expect several minutes cold.

> Rule 5 is deliberate: it arms the HITL probe in Phase 6.

### Phase 3 — tools

1. **Marketplace** → **GitHub** bundle (`github-bundle` = `channel/github` +
   `skill/github-app-auth`) → **Install** → Target: this repo + agent → complete the
   wizard (the four `GITHUB_APP_*` secrets show as *provisioned* — the App flow in
   Phase 4 fills them).
2. **Publish** again if the install added files after your first publish.

The `github-app-auth` skill is what installs `gh`, `git`, `jq`, `openssl` into the
sandbox and teaches the token mint. No other tools are needed for this runbook.

### Phase 4 — the agent's GitHub App + target-repo installation

1. Create the **target repo** on GitHub — any repo you own, e.g. `spike-foh-target`
   (private is fine; it does *not* need to be an eve repo). This is "the Git repo you
   install the agent onto".
2. Repo page → **Deployment** tab → **Channels** card → **GitHub** row → **Connect
   GitHub**. Verify the shown webhook URL is your **tunnel** origin
   (`https://…/e/<envId>/eve/v1/github`), then **Continue to GitHub**.
3. On GitHub: confirm App creation (adjust the proposed name only if GitHub reports a
   collision — the name/slug must be globally unique). GitHub bounces you back;
   harnesst stores `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
   `GITHUB_APP_SLUG` as agent secrets, then forwards you to the App's **Install** page.
4. **Install the App**, choosing **Only select repositories** → your target repo.
   (Registration ≠ installation — skip this and the agent can see nothing.)
5. Back on the Deployment tab, the GitHub row shows **@\<slug\>** and the installation.
   **Write down the slug** — that literal string is how you tag the agent. It is
   project-suffixed (e.g. `deputy-spike-gh-foh`), *not* the bare agent name.
6. **Publish/redeploy again — required.** Container env is frozen at creation
   (issue #236): the four secrets minted in step 3 do not reach the already-running
   container until a fresh deploy. Skipping this is the #1 way this runbook "fails".

### Phase 5 — tag the agent

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

Baseline loop (expected within ~a minute of the mention, longer if the container was
scaled to zero):

- [ ] **O1 — dispatch:** 👀 reaction appears on your comment/issue (eve `turn.started`
      built-in).
- [ ] **O2 — result on GitHub:** the agent replies as `<slug>[bot]` with the requested
      comment (its own `gh issue comment` per the system prompt, and/or eve's
      `message.completed` reply).
- [ ] **O3 — back of house:** Runs tab shows a new run within ~60s (the reconciler's
      pull interval). **Record the exact channel string** — expected `github` or
      `channel:github` (eve rewrites authored-channel adapter kinds; §3).
- [ ] **O4 — FOH activity:** the team's activity feed shows a generic "`deputy` ran"
      entry (unstyled for github — claim §3).
- [ ] **O5 — thread continuity:** reply on the same issue with `@<slug> now shorten it
      to two bullets` → the follow-up runs in the same eve session (Runs detail →
      metadata `eveSessionId` matches O3's).

The gap (the point of the spike — these are **expected to be missing**):

- [ ] **G1 — no FOH session:** the agent's session list in FOH shows nothing for this
      work; it cannot be opened, streamed, or messaged.
- [ ] **G2 — no inbox/needs-you:** sidebar badge and inbox stay empty throughout.

HITL probe (reproduces the silent-park):

1. New issue on the target repo (any title/body), then **as a comment**:
   > @\<slug\> I need a `.gitignore` for this repo, but ask me which language toolchain
   > to target before you write anything. Do not guess.
2. Expected per §3: the turn dispatches (👀), the agent asks its question via eve's
   `input.requested` — and the question **appears nowhere**: no issue comment, no FOH
   inbox item, nothing. The session parks durably and silently; back-of-house Runs
   eventually shows the run stuck in progress / waiting.
   - [ ] **G3 — the parked question is invisible on every surface.** Record what you
         actually observe (including how the run row renders) — this is the
         highest-value observation in the runbook.
3. Cleanup: the parked session holds no resources beyond the container's normal
   lifecycle; closing the issue and (optionally) redeploying clears the way for re-runs.

### Acceptance mapping

O1–O5 passing plus G1–G3 confirmed = every §3 claim verified = the spike's premise and
gap are real, and the Option A acceptance criteria write themselves as the inversion of
G1–G3: mention → FOH session exists and streams (kills G1); question → needs-you badge +
inbox item, answerable inline, answer resumes the turn and the result lands back on the
issue (kills G2/G3); O1–O5's GitHub-side behavior preserved by the agent's own credential
rather than eve's channel built-ins.
