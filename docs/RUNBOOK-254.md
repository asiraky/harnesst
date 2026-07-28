# Runbook — migrating `worksauceapp/agents` onto the platform layer (issue #254)

This runbook covers **Phase 3 and Phase 4** of issue #254. Neither is a code change to this repo.
Both are operations performed *through* a deployed harnesst, and neither can start until the
Phase 1 + Phase 2 work in this PR has merged and reached production.

---

## Why this isn't in the PR

The marketplace catalog ships **inside the control-plane image**. `Dockerfile` copies `catalog/`
into the image and the default `CatalogSource` reads `<cwd>/catalog`
(`app/seams/oss/catalog.fixture.server.ts`). The GitHub-raw alternative is gated on
`HARNESST_CATALOG_REPO`, which is set in no checked-in environment — not `deploy/vps/env.example`,
not `docker-stack.production.yml` — so that source is currently dead code.

**A catalog change therefore reaches customers only after CI rebuilds
`ghcr.io/asiraky/harnesst:<sha>` and the swarm stack is updated.** Phase 3 step 3.1 (updating
`github-bundle` to 0.5.0) is not offered by production until then. There is no way to bring it
forward, and no useful hand-migration to do in the meantime — anything hand-written now is
guesswork the real update would overwrite.

> If we later want catalog changes to ship independently of the control plane, setting
> `HARNESST_CATALOG_REPO` in production is the lever. That is a separate decision with its own
> blast radius (a catalog push would go live within the 5-minute SWR cache, with no CI gate).

## The ownership rule — read this before touching the repo by hand

Direct pushes to `worksauceapp/agents` remain deployable. Deploy builds from a release `gitSha`
(`app/deploy/controller.server.ts`) and the roster re-syncs from the repo tree
(`resolveSyncedAgentContext`), so an out-of-band commit is picked up normally. **Deployability was
never the risk.** Ownership is:

| You hand-edit… | What happens |
| --- | --- |
| a **lock-owned** file (incl. `agent/channels/github.ts`) | the next marketplace update overwrites it — accepted by decision, see `PLAN-channel-overwrite.md` |
| anything under **`harnesst/`** | the publish hash gate fails your publish outright |
| a **customer-owned** file | fine, and expected |

Customer-owned means `agent/instructions.md`, subagent code, schedules — everything the agent's
operator actually authors. The channel file is NOT on that list: it is the template's, rewritten in
full by every update, and everything an operator legitimately varies about it is panel
configuration (wake rules) or secrets.

**Rule: template files only ever arrive via a marketplace update; hands only touch customer-owned
files.** If a template file is genuinely wrong, fix the template and re-run the update; never
patch it in place.

---

## Phase 3 — migrate and reconfigure both members

Each step gates the next. Do not run them out of order.

### 3.0 Confirm production is on the new image

Compare the running image tag to repo `HEAD` **before anything else**. A redeploy re-ships a pinned
SHA; only the merge-triggered build advances it. If prod is on an older tag, nothing below will be
offered and you will waste an hour looking for the update button.

### 3.1 Update `github-bundle` to 0.5.0 on both members

harnesst → project `worksauceapp/agents` → Settings → **Update** on `github-bundle`, for **Ivy and
Sam separately**.

The channel is one self-contained file again and **updates overwrite it** (the 0.4.0
platform/wrapper split and its install-once preservation were reversed — decision and rationale in
`PLAN-channel-overwrite.md`). The 0.4.0 update left each member's `agent/channels/github.ts` in the
lock's `preservedFiles`; 0.5.0 reclaims it — the file is rewritten from the template even though an
earlier update preserved it.

Review the staged change-set for both members. Expect:

- `agents/<member>/agent/channels/github.ts` **overwritten** with the full implementation
- `agents/<member>/harnesst/github-channel.ts` **staged for deletion** (no longer shipped)
- `harnesst-lock.json`: the entry owns the channel file again, with no `preservedFiles` and no
  `platformFiles` for this template (the hash gate keeps guarding only `harnesst/model.ts`)

### 3.2 Configure the channel settings panel

Deployment tab → GitHub channel row → settings.

| Member | Repositories | Wake labels | Wake on new issues |
| --- | --- | --- | --- |
| Ivy | `worksauceapp/marketing-site` | `ready`, `changes-requested` | off |
| Sam | `worksauceapp/marketing-site` | — | **on** |

Sam's toggle is what restores the direct GitHub intake behaviour lost in `d171e19`.

Settings already saved under an earlier version **carry across the update** (`carriedSettings` in
the planner) — a member configured before 3.1 needs nothing re-entered here.

Settings are stored in `harnesst-lock.json` and shipped to the container as env at deploy time, so
**a settings change needs a publish and a deploy to take effect.** That is the accepted cost of
keeping the dispatch gate free of any network call — there is no "harnesst is unreachable" failure
mode in the hot path.

### 3.3 Rewrite Sam's `instructions.md`

Drop every mechanism claim — "that label wakes Ivy", "there is no polling schedule". Those were
true when written, are false now, and will drift again. Narrow Sam to **intake and triage**, and
state the full label table and the invariants verbatim.

### 3.4 Rewrite Ivy's `instructions.md`

Same treatment, plus:

- **Ivy owns UAT.** Ivy posts the UAT packet and asks the operator directly through the channel's
  `input.requested` park. Sam keeps intake and triage — one less hop, less relayed distortion.
- "You never need a label to wake yourself" — an agent continues in-turn; labels are for handoffs
  across actors and for resuming after a gap.
- The silence rule: comment only when you changed state or produced evidence, never to say you did
  nothing.
- Replace the blanket `ask_question` ban with the truth: you may ask, it reaches the operator's
  inbox, but a redeploy ends a waiting session — so the ledger holds the state, not the park.

**Quinn's browser QA and Remy's final review stay mandatory.** Ivy now runs its own acceptance, so
independence has to come from somewhere; it comes from those two being separate subagent contexts
with their own instructions. They are the reason this is safe, not an optimisation to trim later.

### 3.5 Install `agent-browser` on Ivy from the marketplace

Both artefacts must be **lock-owned**: the member-root bootstrap addon and the Quinn-scoped skill
markdown. Delete the hand-authored orphans afterwards.

This is the actual reason to install through the marketplace rather than hand-author. The original
incident's second regression was exactly this: `sandbox/sandbox.ts` was regenerated from the lock,
agent-browser was never in the lock, and its import vanished — leaving an orphan file on disk that
nothing imported and Quinn's browser QA dead. The orphan-addon warning added in Phase 1 is what
would have caught it.

### 3.6 Fix the hardcoded subagent models

`agents/ivy/agent/subagents/quinn/agent.ts` hardcodes `openrouter.chatModel("openai/gpt-5.6-sol")`.
Change it — and Remy, and legal-advisor if affected — to `harnesstAgentModel('ivy')`. Models are
workspace configuration, never code.

### 3.7 Add Ivy's reconciliation schedule

A handler-form eve schedule, every 30 minutes: list open PRs **in the configured repos**, and for
any carrying `needs-qa` or `changes-requested` whose newest evidence comment predates the head SHA,
resume that work.

Bookkeeping and mechanical resumption only. A task-mode schedule cannot park, so anything needing a
human gets `blocked` and stops.

Webhooks are single-delivery, and a dead turn strands a stage label — PR #19 carries three
`Stream ended before a terminal response event` comments. Deleting `schedules/check-for-tasks.md`
removed the safety net exactly when the system started depending on webhooks.
**Events for latency, a schedule for durability.**

### 3.8 Publish and deploy both members

Publish commits every staged draft in one compare-and-swap commit and queues a deploy for the whole
roster. If the publish fails on the platform-file hash gate, **do not hand-fix the file** — that
failure means a platform file on disk doesn't match what the install recorded, which is a broken
install. Re-run the update.

---

## The repaired state machine

Nine labels stay; **only two wake anybody**.

| Label | On | Set by | Wakes | Meaning |
| --- | --- | --- | --- | --- |
| `needs-triage` | issue | Sam | — | criteria incomplete; Sam resolves with the requester |
| `ready` | issue | Sam or human | **Ivy** | criteria agreed — implement it |
| `in-progress` | issue | Ivy | — | Ivy holds it |
| `needs-qa` | PR | Ivy | — | Ivy continues in-turn; the sweep resumes it if the turn died |
| `needs-uat` | PR | Ivy | — | UAT packet posted, waiting on the operator |
| `changes-requested` | PR | human, or Remy's review | **Ivy** | numbered feedback exists — resolve it |
| `needs-review` | PR | Ivy | — | Ivy continues in-turn into Remy |
| `ready-to-merge` | PR | Ivy | — | the human's merge queue |
| `blocked` | either | either | — | needs a human; Sam clears it |

**Invariants**, to be stated verbatim in both agents' instructions:

- one stage label at a time
- every evidence comment carries the full head SHA, and approval never crosses SHAs
- comment only when you changed state or produced evidence, never to say you did nothing
- never act on a label you set yourself
- never open a second issue, branch or PR for work that already has one

A park does not survive a redeploy, so UAT **state** lives on the ledger — the packet is a comment
plus `needs-uat`. The park is a convenience for a fast answer, never the record. If the park dies,
the operator's reply or label re-wakes Ivy through the normal path.

---

## Phase 4 — verify on the live PR

- [ ] Both containers on the new release; `sandbox/sandbox.ts` imports the agent-browser addon;
      `agent/channels/github.ts` is the full single-file implementation and
      `agents/<member>/harnesst/github-channel.ts` is **gone** (only `harnesst/model.ts` remains
      at the platform root).
- [ ] Re-apply `changes-requested` on PR #19 **as a human** → an Ivy row in `runs` for project
      `ltwhnfmhbgdi`, a turn in the container log, and the four numbered UAT items resolved
      (restore GTM/GA, revise the privacy copy, no consent banner, nothing else touched).
- [ ] Quinn's browser QA runs — `agent-browser --version` succeeds in the sandbox, then
      `QA PASSED — <sha>` or `QA FAILED — <sha>`, **not** `QA BLOCKED`.
- [ ] No self-loop: Ivy's own `needs-qa` produces no second turn and no "Handled idempotently"
      comment. (Six such comments landed on PR #19 in 90 seconds on 14 Jul — that is the failure
      case-folded sender self-suppression exists to kill.)
- [ ] Edit a wake label in the panel, publish, deploy, confirm it takes effect.
- [ ] Confirm an **unconfigured** install stays inert — no settings, no dispatch, no spend.

Sam mentioning Ivy is **not** a viable fallback if any of this misbehaves: eve's
`isIgnoredGitHubComment` drops any comment authored by a `Bot`, so a bot `@mention` is inert by
construction. Only a human commenting `@ivy-agents` starts an Ivy turn.

---

## Known follow-ups, deliberately out of scope

- **Migration dry-run for other installs.** Any other project on `github-bundle` ≤ 0.3.0 takes this
  same migration on its next update. Dry-run against every known install before considering this
  done. (This PR ships unit coverage only — an explicit scope decision.)
- **Sam's webhook 401s.** `/e/occqicjfvkje/eve/v1/github` returned 401 on roughly half its
  deliveries during the incident window — a webhook-secret mismatch. Unrelated to this work and not
  fixed by it. Needs its own issue.
- **A "create these labels in the repo" button** on the settings panel. Viable whenever we want it:
  harnesst already holds `issues:write`.
- **The `agent` marketplace category is empty** now that the Engineer template is deleted, until
  something replaces it.
