---
description: "Use when reviewing a pull request — checking the change out locally and judging it along two axes: standards (does it follow the repo's conventions?) and spec (does it do what the issue asked?)."
---

# Reviewing a pull request

A review protects the codebase and helps the author. Judge the PR's diff along two separate axes:

- **Standards** — does the code conform to the repo's documented conventions, and is it free of the baseline smells below?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Run each axis as its own focused pass. If you can spawn sub-agents, run the two passes in parallel so they don't pollute each other's context; otherwise run them sequentially, keeping each report self-contained. Aggregate at the end — never merge or rerank across axes (see _Why two axes_).

## Process

### 1. Get a real checkout

Review from a local clone, not from the PR's changed-files view — you need the surrounding code, the repo's docs, and working `git`, not just the hunks. Clone the repository and check out the PR branch (`gh pr checkout <number>`).

The fixed point is the PR's base branch. Capture the diff once: `git diff origin/<base>...HEAD` (three-dot, so the comparison is against the merge-base), and the commit list via `git log origin/<base>..HEAD --oneline`. If the diff is empty or the branch won't check out, stop and say so on the PR — don't review nothing.

### 2. Identify the spec source

Look for what this change was supposed to do, in this order:

1. Issues the PR links — closing keywords in the PR body, issue references in the commit messages. Read them with `gh issue view`.
2. The PR description itself, if it states requirements rather than just narrating the change.
3. A PRD/spec file in the repo (`docs/`, `specs/`) matching the branch or feature.

If none of these exist, the **Spec** axis reports "no spec available" — and that absence is itself worth a line in the review: a change with no traceable requirement is hard to judge done.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written: `CONTRIBUTING.md`, coding-standards docs, agent instruction files (`CLAUDE.md`, `AGENTS.md`), architecture notes. Discover them — don't assume a fixed layout.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch. 3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything the repo's tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Run both axes

**Standards pass** — with the diff, the commit list, the standards files from step 3, and the smell baseline in hand (a sub-agent has no other access to it — paste it in full): report, per file/hunk where relevant, (a) every place the diff violates a documented standard, citing the standard; and (b) any baseline smell, named, with the hunk quoted. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, baseline smells never are. Under 400 words.

**Spec pass** — with the diff, the commit list, and the spec contents: report (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words.

While the axes run (or before aggregating), run the repo's own checks from the checkout — install, tests, typecheck, lint, build — as far as they go. "Tests pass" you observed beats "looks fine" you assumed.

### 5. Deliver the review

Post one review on the PR with `## Standards` and `## Spec` sections, each pass's findings kept separate. Anchor each finding to a file and line, name the problem, and say why it matters. Mark what blocks merge versus what's a suggestion, so the author knows what's required. Include what checks you ran and what happened.

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

Verdict: approve when it's genuinely ready — a review that never approves is noise. Request changes only for blocking findings. A few sharp comments beat a wall of nitpicks.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
