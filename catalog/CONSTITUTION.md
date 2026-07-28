# The agent constitution

How we write system prompts for marketplace agents. The manifest format lives in
[`README.md`](./README.md); this is about the words inside `instructions.md` — the
part that decides whether an agent is any good.

Use it two ways: as the brief when authoring a new agent, and as the checklist when
reviewing one (a human or another agent). It is meant to change as our taste changes —
edit it, don't work around it.

There is deliberately no exemplar template to copy from. An exemplar becomes the rule in
practice — including the parts of it that were only ever true for whoever wrote it, which is
how a specific reviewer's username ended up hardcoded in a template every customer installed.
The rules below are stated here in full; where a shipped template disagrees with them, the
template is wrong.

## The one idea

**Ground the agent; don't tutor it.** A system prompt gives the agent its footing in
reality — who it is, what it works on, what credentials and tools it has, where the edges
are. It does **not** teach the agent skills it already has. The model already knows how to
drive `git`, `gh`, a package manager, and the shell; it has read more of that documentation
than we have. Telling it how is noise that buries the part only we can supply: the context.

The failure mode we are correcting is the over-specified prompt — pages that re-explain the
GitHub CLI, enumerate every branch of every workflow, and repeat the same rule in three
sections. It reads as thorough and performs worse: the agent spends attention parsing our
lecture instead of thinking, and the rigid script breaks the moment reality differs.

## Principles

1. **Prefer role and substrate over workflow.** Usually the strongest prompt says who the
   agent is and what it works through ("a software engineer; your work lives in GitHub") and
   lets the model find the path. A short numbered list is fine when it captures the *shape of
   the job* (inspect → change → verify → open a PR); it turns bad when it becomes a script for
   every situation the agent might meet. The exception: when an agent exists precisely to carry
   out one workflow, spelling that workflow out *is* the role — do it. Just don't reach for a
   scripted workflow when a role and a substrate would do.

2. **Name the tools; don't script the mechanics.** State what the agent works through —
   once. "Reach GitHub with `gh` and `git`." Not a tour of `gh` subcommands, and no secret
   names or auth mechanics in the agent prompt. The model already knows how to drive these
   tools, and every agent uses them differently; the channel that grants the credential owns
   setup, and the environment carries it.

3. **No proper nouns.** Don't hardcode repository names, label taxonomies, project boards, or
   a fixed workflow. Tell the agent to *discover* its scope from the credential it was given.
   An agent that names your repo breaks when the repo is renamed or reused elsewhere.

4. **Hand off by role, never by name.** Don't hardcode a specific agent's name — names change,
   and a prompt that says "give it to the Engineer" breaks the day that agent is renamed.
   Coordination is dynamic: the platform injects a teammate tool from the team's permissions,
   and shared substrate (issues, PRs, comments) carries the rest. But when a job genuinely ends
   in a handoff, it's fine to say so in terms of the *role* it goes to — "hand the work off to
   an engineer" — and let the teammate tool resolve who that is. Prefer describing what the
   agent *produces* and leaving pickup implicit; name a role only when the handoff is the job.

5. **Say it once.** If a rule appears in the intro, the steps, and the boundaries, cut it to
   one place. Repetition is the clearest signal a prompt is too long.

6. **A `## Boundaries` section.** The short "ask before you do X" list — irreversible,
   destructive, or trust-sensitive actions. This one section replaces paragraphs of defensive
   hedging scattered through the prompt.

7. **A `## Final report` section.** What the agent leaves behind so a human can pick up: what
   it did, where (links), what it verified, and what's blocked. Be direct about failure — a
   failed check reported plainly is a useful result.

8. **About a page.** If a prompt runs long, the agent is usually too niche or over-specified.
   Split the capability or cut the tutoring. Generic beats clever.

## Smell test

Before shipping an agent, read its prompt and look for:

- a sentence that teaches a tool the model already knows → **cut it**;
- a specific repo, label, or path name → **replace with "discover it"**;
- the name of a *specific* agent → **replace with the role** ("an engineer"), or cut it;
- the same instruction in two places → **keep one**;
- a numbered step that scripts a rare edge case → **trust the model, keep boundaries**;
- more than ~400 words → **ask what's carrying its weight**.

## Where craft lives instead

Deep, reusable know-how — how to write a good issue, how to critique a design, how to run a
review — belongs in a **skill**, not bolted onto an agent's prompt. Skills load when relevant
and stay out of the way otherwise (see `templates/skills/reviewing-a-pull-request`). Keep the agent
prompt about the job; let skills carry the craft.
