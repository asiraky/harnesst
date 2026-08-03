---
description: Load before building ANY agent↔human or agent↔agent communication — an agent that talks or replies back in a session or chat, messages/notifies/updates someone, asks a question, waits for an answer, pauses for approval or sign-off, checks in, escalates, hands off, or delegates to another agent — and whenever a request mentions Front of House, sessions, the inbox, needs-you, human-in-the-loop, ask_question, notify-user, or ask-teammate. Covers how an agent reaches a human mid-task (eve's native HITL parking), how it opens a conversation itself (notify-user), how harnesst surfaces and answers it, which entry points may safely park and which stall, and the delegation contract.
---

# Talking to humans (and teammates) in harnesst

Humans work with deployed agents on **Front of House (FOH)** — harnesst's chat surface: a sidebar of
teams and their agents, each agent's sessions, and one conversation at a time, plus a global inbox of
everything that needs a human.

FOH is a **surface in harnesst, not a package, channel, or tool you install in the repo**. A roster
member that is deployed appears there automatically, with a presence dot and a needs-you badge.
There is nothing to add to an agent project to "enable FOH", and no HTTP endpoint to post to.

**FOH is the default notification surface.** When a user says "notify me", "tell me", "let me
know", or "message me" without naming a channel, they mean an inbox item here — in this chat
application, where they are already talking to you. Never design the notification onto Discord,
email, or any other channel unless the user names it.

Communication rides four mechanisms:

| Direction                | Mechanism                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Human → agent            | An FOH session is an ordinary eve durable session; the human's message arrives as a normal turn.                 |
| Agent → human (blocking) | eve's **built-in HITL**: `ask_question` (or a tool-approval gate) emits `input.requested` and parks the session. |
| Agent → human (notify)   | The **`notify-user`** tool, baked into every image by harnesst — fire-and-forget, opens an FOH conversation.     |
| Agent → agent            | The **`ask-teammate`** tool, which harnesst bakes into every team member's image at build time.                  |

## Asking a human a question

Use eve's built-in `ask_question`. Never author a tool in the repo that POSTs a question or message
to harnesst or anywhere else — the only agent→human tools are the ones harnesst itself generates into
the image (`notify-user`, like `ask-teammate` below), and they are never written by hand.

When it fires, eve parks the durable session and harnesst (which holds the session handle, because it
started the turn) marks the session needs-you, files an inbox item, and badges the agent. The human
answers inline — an option button or free text — and harnesst resumes the same session with the
answer correlated to that exact request. **The park is durable**: it works even when nobody was
watching at the moment the agent asked, and the human can answer hours later.

Write asks that survive the trip:

- **Self-contained prompt.** The human usually arrives cold from the inbox with no memory of the
  task. "Should revoked users see the sign-in page, or a 'revoked' notice?" beats "which one?".
- **Options** when the answer is a choice — they render as buttons; free text is still available.
- **One question per park.** A human's answer resolves _every_ pending ask on that session, answered
  or not. Two unrelated questions in one turn will lose one of them.

## Which entry points may ask (the rule that breaks agents)

The parked question is delivered by **whichever channel started the session**:

- **FOH session** (a human opened it) → inbox item, badge, inline answer. ✅
- **A delegation** from a teammate → harnesst opens an agent-opened FOH session carrying the question
  and files a team-wide inbox item; the delegation resumes on its own once answered. ✅
- **A channel whose installed skill documents FOH park** → the ask lands as a team-wide needs-you
  inbox item; whoever answers in FOH resumes the channel-homed session. ✅
- **A schedule, or a channel with no documented park** → nobody owns the ask; the session parks
  and the run stalls with no human anywhere. ❌ If the run only needs to _tell_ the human something,
  `notify-user` is the escape hatch — it never parks. A blocking ask still stalls.

Whether a given channel can park into FOH is documented **in that channel's installed skill**
(`skills/harnesst-installed-<template-id>.md`) — check it before designing. `ask_question` is the only
_blocking_ agent→human API; the park is delivered by whichever channel homed the session, so the
channel's skill is the ground truth for what happens to it. `notify-user` bypasses the channel
entirely — it posts to FOH directly from any entry point.

Any run, attended or not, can open a conversation with a human: `notify-user` posts a message that
lands as an inbox notice and opens an FOH session the human picks up on their own time. Choose by
whether the run can continue without the human: "notify me when X" is `notify-user` — fire the
notification and finish the run; the human's reply (if any) starts a fresh conversation with your
message as context. A decision the run cannot proceed without is `ask_question` — it blocks, and it
needs an entry point that can park (the ✅ rows above). When a human asks for "check with me before
doing X", establish which entry point X runs on before choosing the mechanism.

Do not invent a confirmation question to deliver a notification. A reply in an already-visible FOH
conversation needs no extra notification; for work from another entry point, use `notify-user` when
the human should see completion, a UAT or preview link, a finding, status change, or a blocker already
recorded in the durable workflow ledger.

## Opening a conversation with a human (`notify-user`)

`agent/tools/notify-user.ts` is **generated by harnesst into every image at build time**, with the
notify endpoint and credentials supplied as env. Never write, copy, scaffold, or edit a file at that
path — a repo file there overrides the generated tool and silently breaks it. It simply appears in
every deployed agent's toolset.

Calling it with `{ message, title? }` opens a team-wide FOH conversation carrying the message and
files an inbox notice — **fire-and-forget**: the run continues immediately, nothing parks, and there
is no answer to wait for. If the human replies later, that reply starts a normal FOH conversation
with the notification as its opening context — a different session from the run that sent it, so the
message must be self-contained (say what happened and what, if anything, you want from them).

Use it for news, not decisions: `ask_question` when the run must stop until a human chooses;
`notify-user` when the run can finish and the human just needs to know. A notification does not
replace durable workflow evidence: when a GitHub comment, label, or other system-of-record update is
required, write that record as well and include its link in the self-contained notification.

## Delegating to a teammate

`agent/tools/ask-teammate.ts` is **generated by harnesst into the member's image at build time**, with
the roster and relay credentials supplied as env. Never write, copy, scaffold, or edit a file at that
path — a repo file there overrides the generated tool and silently breaks delegation. It simply
appears in a team member's toolset; a single-agent repo has no teammates.

What the agent's instructions should account for:

- Each ask opens a **fresh** conversation with the teammate — they cannot see the caller's
  conversation, so the message must carry all the context.
- The result is normally the teammate's final reply. It may instead be
  `{ ok: true, status: "waiting_on_human", question, note }` — **not a failure**: the teammate parked
  to ask a human, and the delegation resumes and completes on its own once someone answers. The
  calling agent must not re-ask, retry, or route around it.
- Guardrails: 3 in-flight asks per caller→target edge, 10 per repo, 100KB per message, ~10 minutes per
  delegation. A scaled-to-zero teammate is woken automatically.
- Every delegation shows up in the team's activity feed as readable conversation, expandable to the
  full exchange — so asks and replies should read well to a human.

## When you build

- "The agent should be able to ask me" needs **no new tool and no new channel** — it needs
  `ask_question` used at the right decision points, and the work reaching it through FOH, a
  delegation, or a channel whose installed skill documents FOH park.
- "The agent should be able to message me" needs nothing either — `notify-user` is already in
  every image; the authoring work is deciding when a notification is worth the human's attention.
- "The agent should be able to hand work to another agent" needs nothing either, beyond the repo being
  a team.
- Never patch, vendor, or fork eve to change any of this — harnesst-side surfaces only.
- The real authoring work is _when_ to ask: which decisions are genuinely the human's, what a
  self-contained prompt looks like, and what the agent does instead when it runs unattended. Put that
  in the agent's `instructions.md`.
