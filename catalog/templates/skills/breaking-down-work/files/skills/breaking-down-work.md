---
description: Use when an agreed request needs several independently reviewable changes, infrastructure dependencies, or proposed child items for plan approval.
---

# Breaking Down Work

Read the project's docs before splitting. Each child is one deployable, independently testable change and one PR. Split by behavior, not directories.

Give proposed_children entries stable key, kind, title and spec fields. Each spec carries problem, acceptance_criteria, out_of_scope, decisions and open_questions. Name prerequisites in the spec; infrastructure that does not exist is its own infra child. Keep a dependent child in triage or block it until its prerequisite is complete; v1 does not schedule a dependency graph.

If you cannot write a child's acceptance criteria, keep the uncertainty visible and clarify it. Save the proposed children on a plan; the engineer's architecture approval creates them atomically. Edit the existing children after approval rather than proposing duplicates.
