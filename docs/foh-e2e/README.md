# Front of House — e2e acceptance evidence

## Runnable suite

The core acceptance flows are covered by an executable suite: `tests/e2e/` (vitest, no new
dependencies) drives the REAL route modules (`api.foh.stream`, `foh.session`, `api.foh.inbox`,
`api.foh.read`), the real disconnect-safe drain, real Better Auth signup/cookies/teams, and the
live Postgres — against a protocol-faithful fake eve instance (`tests/e2e/fake-eve.ts`, a
node:http server implementing the verified eve session/stream/cancel contract from
`app/agent/talk.server.ts`, with every request body recorded for assertions).

Run it from the repo root (same opt-in as `tests/integration`):

```
set -a; source .env.local; set +a
HARNESST_DB_SMOKE=1 npm run test:e2e
```

Without `HARNESST_DB_SMOKE=1` the specs skip; the default `npm test` glob never picks them up
(they are named `*.e2e.ts` and run through `tests/e2e/vitest.config.ts` only).

What it proves, at the HTTP/route layer:

| Spec | Flow |
| --- | --- |
| `core-loop.e2e.ts` | Send into a new FOH session, abandon the response reader mid-turn (away-mid-turn); the detached drain still consumes eve to `done`, advances the session cursor (the transcript lives in eve's durable stream, #288), lands the session `waiting`, and files the `finished` inbox item. |
| `park-recovery.e2e.ts` | eve parks on TWO approval requests (`input.requested` → `session.waiting`) with no client attached → `pendingInputAt` + one pending item per requestId; answering ONE via the stream action forwards `inputResponses` with EXACTLY that requestId on the continuation POST, and the supersede rule resolves both items (the un-answered one included). |
| `concurrent-turns.e2e.ts` | A second stream POST while a fresh turn holds the session `running` → 409 before eve is touched; the fencing token is untouched and the winning drain settles cleanly. |
| `roles-and-inbox.e2e.ts` | A member's session 404s for a fellow team member but loads for an admin; the inbox loader scopes items per viewer (personal items invisible even to admins); the generic resolve action refuses question items and dismisses `finished`; opening the session acknowledges every notification visible to that viewer and advances the read cursor. |

Deliberately NOT re-covered here:

- **Invite → email → accept → scoped member** is already an executable end-to-end test:
  `tests/integration/foh-teams.db.test.ts` (real Better Auth handler + `MAILBOX_DIR` mailbox
  driver, invitation/team/member rows asserted in Postgres).
- **Delegation & wake** (agent↔agent↔human, waking stopped containers) needs real deployed eve
  containers and a running control plane — it stays browser-run/manual, evidenced by the D1/D2
  screenshots below.
- **Browser-level UI criteria** (badges, sorting, empty states, marketing/host routing) remain
  screenshot-evidenced below.

## Screenshot evidence

Screenshot evidence for every acceptance criterion in
[`../PRD-FRONT-OF-HOUSE.md`](../PRD-FRONT-OF-HOUSE.md) §6, captured by browser-driven e2e runs
(agent-browser) against a live dev instance of this branch with **real deployed eve agents**
(project `agents`, team members `sam` and `ivy`) and the `MAILBOX_DIR` file mailbox driver.
Two rounds were run on 2026-07-24; delegation criteria were re-run after the test agents were
redeployed from the branch's own control plane (their previous containers carried a stale
`HARNESST_TEAM_URL` from another checkout — an environment issue, not a code path).

## Regression

| Criterion | Result | Evidence |
| --- | --- | --- |
| Playground/assistant unchanged; no surface sees another's sessions | ✅ (full unit suite green; live checks) | `R1-playground-unaffected.png`, `R2-assistant-unaffected.png` |
| BOH URLs (`/repos/...`) untouched | ✅ | `H2-boh-dashboard.png`, `H2-boh-repos-page.png` |

## Routing & hosting

| Criterion | Result | Evidence |
| --- | --- | --- |
| Marketing site on subdomain, content unchanged | ✅ | `H1-marketing-landing.png`, `H1-case-study.png` |
| `/` serves FOH (sign-in unauth / shell signed in) | ✅ | `H2-unauth-signin.png`, `H2-foh-shell.png` |
| Self-host with no marketing host: `/` is FOH | ✅ | `H3-selfhost-root.png`, `H3-selfhost-case-studies-by-path.png` |

## Core loop (human ↔ agent)

| Criterion | Result | Evidence |
| --- | --- | --- |
| Open session, live stream, leave mid-work, turn continues | ✅ | `C1-live-stream.png`, `C1-navigated-away.png`, `C1-left-and-returned.png` |
| Park with no client connected → needs-you + badge + inbox item | ✅ | `C2-needs-you-badge.png`, `C2-inbox-item.png` |
| Inbox click → session; inline answer resumes; resolve clears badges | ✅ | `C3-question-callout.png`, `C3-resumed.png`, `C3-resolved-clear.png` |

## Delegation (agent ↔ agent ↔ human)

| Criterion | Result | Evidence |
| --- | --- | --- |
| Delegation parks `waiting`; agent-opened session + inbox item; answer resumes peer; completes end-to-end | ✅ | `D1-agent-opened-session.png`, `D1-inbox-needs-answer.png`, `D1-question-callout-sam.png`, `D1-sam-final-note.png`, `D1-delegation-complete.png`, `D1-ivy-waiting-result.png` |
| Delegation to stopped peer wakes it | ✅ (wake ~5–7s) | `D2-sam-stopped-before.png`, `D2-sam-woken.png` |

Note: per PRD §5, the delegating agent receives a structured "waiting on human" result and its
turn ends; the peer's final answer lives in the peer's session, the completed delegation record,
and the activity-feed exchange (`D1-ivy-waiting-result.png` shows the caller's honest end state).

## Invites & roles (portal replacement)

| Criterion | Result | Evidence |
| --- | --- | --- |
| Invite → mailbox email → accept (verification enforced) → land in FOH as scoped member | ✅ | `I1-invite-sent.png`, `I1-invite-email.png`, `I1-member-lands-foh.png` |
| Invited member runs the core loop; sees own sessions only | ✅ | `I2-member-session.png`, `I2-member-session-live.png`, `I2-member-needs-you.png`, `I2-member-needs-you-resolved.png`, `I2-member-no-admin-sessions.png` |
| Member denied BOH; admin/owner reach both houses, see all repos | ✅ (denial = redirect to `/`) | `I3-member-boh-denied.png`, `I3-member-boh-denied-dashboard.png`, `I3-admin-both-houses.png`, `I3-admin-boh-dashboard.png` |
| Portal surface, `chat_portals`, OTP/magic-link plugins deleted | ✅ | `I4-portal-404.png`, `I4-portal-route-404.png`, `I4-no-portal-ui.png`, `I4-settings-no-portal.png` |

`I2-admin-sees-member-session.png` documents a deliberate decision: admins/owners see all of a
team's sessions (consistent with the activity feed projecting every exchange); members see only
their own.

## Legibility

| Criterion | Result | Evidence |
| --- | --- | --- |
| Sam→Ivy scenario reconstructable from the feed alone; exchange expands to full transcript | ✅ | `L1-activity-feed.png`, `L1-exchange-expanded.png` |
| Presence from real container + turn state; needs-you sorts first | ✅ | `L2-presence.png`, `L2-needs-you-sort.png` |
| Empty states: no teams / no sessions / empty inbox / empty feed | ✅ (3 live + empty-feed by code path — no zero-activity team existed in the fixture DB) | `L3-no-teams.png`, `L3-no-sessions.png`, `L3-empty-inbox.png` |
