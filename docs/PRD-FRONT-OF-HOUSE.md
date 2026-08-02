# harnesst — Front of House PRD

> **Working name:** Front of House (FOH).
> Companion to [`PRD.md`](./PRD.md) (pillars 1–7) — this describes the **operate surface**:
> the chat-first UI where a human runs their team of agents day-to-day.
> **Status:** Draft v0.1 · **Owner:** asiraky@gmail.com · **Last updated:** 2026-07-23

---

## 1. Vision

harnesst today is **back of house**: authoring, shipping, deploying, observing — the console where
agents are built. Front of House is where you **work with them**: an agency-style operating
environment where you look at your teams, hand tasks to specific members in chat, chase them up,
answer their questions, and watch them collaborate — the way a CTO runs a small tech team.

The premise: agents are treated as if they were human colleagues. You go to the person you need
(the triager, the architect, a developer), give them an instruction in a conversation, and they
go off and do the work — delegating to teammates, creating issues, opening PRs — coming back to
you only when you're needed.

Everything here composes over machinery harnesst already ships: durable playground sessions and
transcripts, the team relay (`ask-teammate`), delegation records with linked traces, eve's
`input.requested` HITL parking, and scale-to-zero instances.

---

## 2. Decisions (settled in design discussion, 2026-07-23)

These are the load-bearing UX decisions and their rationale. Revisit deliberately, not casually.

1. **Work happens in sessions.** Talking to an agent happens in discrete sessions (the
   ChatGPT model). A session is one piece of work; its full contents are always the agent's
   context — *the window must never lie*: if a transcript is visible, the agent has it in
   context. The user partitions their own work into sessions; each session's status (working /
   needs you / done) is glanceable in the list. This matches eve's session model exactly.
   (Cross-session memory is a possible later layer; it does not change the UI.)

2. **Sessions are bidirectional.** An agent can open a session with you (e.g. mid-task it needs
   a decision and you weren't the initiator). The opener carries the context ("I'm working on
   issue #83 — should revoked users see a sign-in page or a notice?"), like a colleague DMing
   you first. In the UI it's the same session list; only the initiator varies.

3. **Agent questions ride eve's native HITL, and routing is channel-owned.** Verified against
   eve source (`packages/eve/src/channel/*`): `input.requested` parks the durable session, the
   **initiating channel's** adapter owns delivery, and answers are `inputResponses` on a
   continuation send — only the holder of the session handle can answer. Therefore anything
   that might need a human runs as a **harnesst-driven session** (FOH sessions; relay-driven
   delegations): harnesst holds the handle, sees the park, routes it, answers it. The
   generalization (other entry points routing questions to harnesst) is the **mayi pattern**: a
   channel that homes the session, files `input.requested` with an external surface, and
   resumes via signed callback (see `~/code/mayi/packages/eve/src/channel.ts`) — the extension
   path, spiked in §5. _Amended by #288 (succession):_ channel-homed sessions are no longer
   answer-only forever. Answers to a pending ask still ride the channel answer route, but free
   text with nothing pending triggers a **succession** — harnesst reads the prologue from the
   old session's durable stream, starts a fresh HTTP-homed session with it as a strippable seed
   block, and rebinds the FOH row; the channel session stays completed-but-readable in eve's
   world store. The channel wall stands; harnesst routes around it, never through it.

4. **The activity feed is a projection.** Per-team, fully automatic timeline of what actually
   happened: sessions opened, messages, delegations (with the real message text passed between
   agents, expandable to the full exchange), issues/PRs/tool calls, deploys — rendered from
   records harnesst already keeps (delegations + linked runs + deployments + sessions).
   Observability wearing a chat UI.

5. **Front of house / back of house split.** The existing harnesst UI (repos, deployment,
   settings, secrets, observability) remains as-is — back of house. FOH is a distinct surface
   in the same app. The existing **Agent Portals** (#180, guest chat at `/a/:slug`) were the
   proto-version of this idea; **FOH replaces portals**, and portal access becomes a
   **workspace invite**: inviting someone to a repo makes them a real workspace member whose
   role scopes what they see — `member` gets front of house for their repos; `admin`/`owner`
   get back of house too. The portal surface and its bespoke auth machinery are deleted as
   part of this feature.

6. **FOH is home: the app root.** (Decided 2026-07-23.) A signed-in user lands in FOH at `/`;
   back of house keeps its `/repos/...` URLs, with a switcher between the two. Consequence:
   the **marketing landing page moves off the root to its own subdomain** — today
   `routes/home.tsx` serves the editorial landing at `/` (plus `/case-studies/*`). The app
   root becomes FOH (unauthenticated → sign-in), and the marketing site is served from a
   marketing host (e.g. `www.<domain>`). Self-host note: the marketing site is optional for
   self-hosters — an installation without the marketing host simply has `/` land on
   FOH/sign-in.

---

## 3. The UI

```
┌───────────────┬─────────────────────┬──────────────────────────────────────────────┐
│ harnesst  🔔2 │ Ivy — sessions      │ Portal 404 fix                    ● working  │
│               │ ┌─────────────────┐ │                                              │
│ ▾ agency-team │ │● Portal 404 fix │ │ you  Revoked users get a 404 on the share    │
│   ⚡ activity  │ │  needs you · 2m │ │      page — fix it.                          │
│   ● sam    ①  │ ├─────────────────┤ │                                              │
│   ● ivy    ①  │ │  DB migration   │ │ ivy  On it. One thing — should they see the  │
│   ○ arch      │ │  working · 1h   │ │      sign-in page instead, or a "revoked"    │
│   ○ deployer  │ ├─────────────────┤ │      notice?                                 │
│               │ │  Fix flaky CI   │ │      ┌────────────────────────────────────┐  │
│ ▾ other-co    │ │  done · Tue     │ │      │ ❓ needs you                        │  │
│   ○ ops       │ ├─────────────────┤ │      │ [Sign-in page] [Notice] [type…]    │  │
│               │ │ + new session   │ │      └────────────────────────────────────┘  │
│               │ └─────────────────┘ │ ┌──────────────────────────────────────────┐ │
│               │                     │ │ message ivy…                             │ │
└───────────────┴─────────────────────┴──────────────────────────────────────────────┘

  ⚡ activity (agency-team)                          🔔 inbox
  ──────────────────────────────                    ──────────────────────────────
  10:42  you → sam    opened "Triage portal bug"    ❓ ivy needs an answer
  10:44  sam → ivy    "Create an issue for the         Portal 404 fix · 2m ago
         portal 404, revoked users…"  [expand]      ✅ sam finished
  10:51  ivy          created issue #83                "Triage portal bug" · 8m
  10:58  ivy → you    asked a question
```

- **Left sidebar:** the user's repos (all of them for admins/owners; team-membership repos
  for members), grouped by repo (team). Each group lists its agents (`●`
  active, `○` idle — presence derived from container/turn state; scale-to-zero *is* the
  presence indicator) with per-agent needs-you badges, plus the team's `⚡ activity` feed.
  The `🔔 inbox` is global, at the top.
- **Middle pane:** the selected agent's sessions, needs-you first. `+ new session` (or typing
  into a fresh composer) starts one. Agent-opened sessions appear here badged.
- **Right pane:** one session — the conversation, parked questions/approvals rendered inline
  as answerable callouts (existing playground `ChatInputRequest` rendering).
- **Inbox:** every "needs you" and "finished" across all agents/teams; click → jumps to the
  session. Badge on session + inbox entry are two views of the same row.
- **Feed:** the automatic per-team timeline; delegation entries show who → whom, wall-clock
  time, and the actual message, expandable to the full linked exchange.

---

## 4. Architecture notes (what carries what)

No eve changes anywhere below (hard constraint — harnesst-side surfaces only).

| Need | Carried by |
| --- | --- |
| Session store + transcript | `playground_sessions` is the index/stitch (handles, status, cursors); the transcript is eve's durable stream on the per-environment world volume, rendered via `GET /eve/v1/session/:id/stream` (#288 replaced the `playground_events` cache and the #71 reseed — sessions now outlive redeploys in eve itself). |
| Live turn streaming, stop, HITL rendering | Existing playground NDJSON stream + drain (`app/chat/*`), `ChatInputRequest` callouts, settle/recovery machinery. |
| Answering a parked question | Existing continuation path (playground option buttons today), from the session row's handle. |
| Delegation records + agent↔agent messages | `delegations` + linked peer runs (`runs`/`run_steps` hold the ask text, reply, and tool calls). |
| "Needs you" detection for unwatched turns | New chokepoint in the event drains: `input.requested` ⇒ inbox row; terminal event ⇒ resolve it. Relay (`runAsk`) does the same for delegation-driven peer turns instead of erroring (supersedes the M7 "parked peer = error" punt). |
| Instance-facing auth for anything new | Existing HMAC deployment token (`HARNESST_TEAM_TOKEN`) + relay pattern (`app/team/*`). |
| Presence | Deploy-target container state + active-turn state — both already known. |

---

## 5. Spec

One feature, delivered whole. What gets built:

### Session model

Surface discriminator on `playground_sessions` (FOH vs playground vs assistant);
`conversation_reads` (per-user read cursor → unread badges); session `status` mapping for
lists (working / needs-you / done). Agent-opened sessions are a session row whose initiator
is the agent, created by the relay chokepoint below. Queries for per-agent session lists and
per-user badge counts.

### Inbox

`inbox_items` table (kind: question | approval | finished; refs: session/delegation/run;
status: pending | resolved), written/resolved ONLY at event-drain chokepoints; resolution
action = answer/approve → continuation send into the parked session (reuse the playground
answer path). Badge count endpoint (poll or SSE, same pattern as `workspace_tasks`).

### Relay parking

`runAsk` change: a peer turn hitting `input.requested` records the park (delegation
`status: waiting`), creates the agent-opened FOH session row + inbox item carrying the
question, and returns a structured "waiting on human" result to the caller.
Human's answer resumes the peer session; on completion the delegation finalizes normally.
Includes wake-on-delegation: relay starts a stopped peer container before `sendTurn`
(existing 120s wake budget). Supersedes the M7 "parked peer = error" punt.

### Landing migration

Implements decision §2.6. Move the marketing surface (`routes/home.tsx`, `/case-studies/*`,
marketing chrome) behind a host check or a separate entry so it serves from the marketing
subdomain; `/` becomes the FOH entry (sign-in when unauthenticated); nginx/deploy config for
the new host; self-host works with no marketing host configured.

### Invites & roles (portal replacement)

Access to FOH is workspace membership, on Better Auth machinery harnesst already runs:

- **Roles gate the houses.** Org members carry a role (owner / admin / member). `member` =
  front of house only; `admin` / `owner` = front and back. Route guards on
  BOH (`/repos/...`) enforce it.
- **Repo scope via Better Auth teams.** Enable the organization plugin's `teams` feature; one
  team per repo, kept in sync with the repo lifecycle (created/deleted alongside it). A
  member sees the repos whose team they belong to; admins/owners see all repos.
- **Invite flow.** From back of house, invite an email to a repo — the org invitation carries
  the repo's `teamId`. Recipient clicks the invite email, verifies their mailbox (existing
  `requireEmailVerificationOnInvitation` gate), and lands in FOH as a `member` scoped to that
  repo.
- **Portal deletion.** Delete the portal surface (`/a/:slug` routes, portal components,
  `chat_portals` machinery) and its bespoke auth (the portal OTP and magic-link plugins in
  `app/lib/auth.server.ts`).

### FOH UI

- **Shell.** The three-pane surface at `/`: team/member sidebar with presence + badges,
  per-agent session list, session view = existing playground chat surface (stream, composer,
  steps, callouts) rebound to FOH sessions. `+ new session`. Inbox flyout (list +
  jump-to-session). Switcher to back of house (`/repos/...`).
- **Activity feed.** Per-team timeline projection (UNION over sessions, delegations, runs,
  deployments; ordered by wall-clock). Delegation entries render as conversation
  ("10:44 sam → ivy: '…'") and expand to the full exchange via the linked run. No new write
  path; materialize an `activity_events` table only if the projection measurably can't keep up.
- **Presence + polish.** Presence derivation (container running / active turn / idle),
  needs-you-first session sort, session titles (first-message auto-title, playground already
  does this), empty states, keyboard nav.

### E2E verification

The acceptance criteria in §6 are verified by automated end-to-end tests, run by the
implementing agent against a running instance (browser-driven for the UI criteria). Two
pieces make the full loops drivable without a human:

- **File mailbox driver.** A third branch in `app/lib/email-client.server.ts` (dev/test
  only): when `MAILBOX_DIR` is set, `sendEmail` writes each message as a JSON file
  (`{to, subject, html}`) to that directory. The e2e test reads the newest message for an
  address, extracts the link from the HTML, and follows it — which makes the invite flow
  (invite → email → accept → land in FOH) fully testable, including signing in as the
  invited user. Production behavior (Postmark) is untouched.
- **Real agents.** The core-loop and delegation criteria run against actual deployed agent
  instances (the existing dev/test deploy path), so parks, wakes, and continuations are the
  real thing.

### Follow-up spike — harnesst channel

Prove/deny: a harnesst-authored channel (mayi pattern, baked into the image like `ask-teammate`)
homing work sessions so `input.requested` from any entry point files to the control plane and
resumes via signed callback; whether `cross-channel-receive` lets externally triggered work
(schedules, GitHub) be homed on it. Outcome is a design note + go/no-go. Ships separately,
after the feature.

---

## 6. Acceptance criteria (the whole feature)

The feature is done when every box checks — each verified by an automated end-to-end test
(see §5 E2E verification), run by the implementing agent against a running instance with real
agents. Email-dependent criteria go through the file mailbox driver.

**Regression:**

- [ ] Existing playground / assistant behavior is unchanged (their tests still pass; no
      surface sees another surface's sessions).
- [ ] Back of house URLs (`/repos/...`) are untouched.

**Routing & hosting:**

- [ ] Prod serves the marketing site on the subdomain, unchanged in content.
- [ ] Prod `/` serves FOH: sign-in when unauthenticated, the shell when signed in.
- [ ] A fresh self-host install with no marketing host configured serves FOH at `/`.

**The core loop (human ↔ agent):**

- [ ] Open a session with a team member from the sidebar, give an instruction, watch the live
      turn stream; leave mid-work and the session keeps going.
- [ ] The agent asks a question while you're away: session shows needs-you, sidebar badge
      increments, inbox gets a pending item — even with no client connected when it parked.
- [ ] Clicking the inbox item jumps to the session and immediately acknowledges its notification;
      unanswered questions/approvals remain answerable inline without a badge. Answering resumes
      the agent, and replies arriving while the session stays open remain read.

**Delegation (agent ↔ agent ↔ human):**

- [ ] Sam → Ivy delegation where Ivy asks a question: the delegation goes `waiting`; an
      agent-opened session appears in Ivy's list with an "Ivy needs an answer" inbox item;
      after you answer, Ivy resumes and the delegation completes end-to-end.
- [ ] Delegation to a stopped peer container wakes it and succeeds.

**Invites & roles (portal replacement):**

- [ ] Invite an email to a repo from back of house: the recipient receives the invite email,
      accepts (mailbox verification enforced), and lands in FOH as a workspace `member`
      seeing that repo's agents — and their own sessions only.
- [ ] The invited member can run the core loop with those agents (new session, live stream,
      needs-you, answer, complete).
- [ ] A `member` requesting a back-of-house URL (`/repos/...`) is denied; `admin`/`owner`
      reach both houses and see all repos in FOH.
- [ ] The portal surface (`/a/:slug`), `chat_portals` machinery, and the portal OTP/magic-link
      auth plugins are deleted.

**Legibility:**

- [ ] The Sam → Ivy scenario is fully reconstructable from the activity feed alone: who
      initiated, when (wall-clock), what was said, what was done — delegation exchange
      expandable to the full transcript.
- [ ] Presence states (active turn / running / idle) render from real container + turn state;
      needs-you sessions sort first in every list.
- [ ] Empty states exist for: no teams, no sessions with an agent, empty inbox, empty feed.
