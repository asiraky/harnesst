# Matt Pocock procedures

Source: https://github.com/mattpocock/skills

Pinned commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`.

`skills/` and `LICENSE` are unmodified upstream files. `manifest.json` records their SHA-256 digests. Preserve the MIT attribution when distributing them.

`node catalog/ledger/package-agent-procedures.mjs` packages these into the catalog. `--check` validates both upstream digests and every generated output. Run the check as validation, not a unit test of prose.

Agent instructions contain complete upstream SKILL.md files between VERBATIM markers, including original metadata. Do not edit inside those markers or summarize/reword the source. Change HARNESST execution bindings separately in `catalog/ledger/agent-bindings/`, regenerate, and review that binding diff explicitly.

Eve rejects upstream `disable-model-invocation` metadata in discovered skills. Packaged copies therefore retain every byte under `SOURCE.md`; a small Eve-compatible `SKILL.md` points to that source. Supporting files retain their original names and bytes. The original `agents/openai.yaml` files are retained as provenance, not interpreted as Eve configuration. Procedures incorporated in an agent's instructions execute on assignment without a slash command or Skill tool.

## Dependency closure

- grill-with-docs → grilling, domain-modeling → CONTEXT-FORMAT.md, ADR-FORMAT.md.
- to-spec / to-tickets / code-review → configured tracker, domain docs and readiness vocabulary (setup-matt-pocock-skills supplies setup references).
- implement → tdd → tests.md, mocking.md; conditional codebase-design → DEEPENING.md, DESIGN-IT-TWICE.md; implement → code-review.
- Optional triage → grilling, domain-modeling, AGENT-BRIEF.md, OUT-OF-SCOPE.md, tracker configuration.

All eleven skills and their files are vendored. Role-specific copies are distributed where used. Intake includes grilling and specification inline; planner includes to-tickets inline; implementer includes implement and tdd inline; reviewer includes code-review inline. Two review leaf instructions preserve the upstream briefs and standards baseline. Triage is an optional planner reference, not an additional pass over generated tickets.

Upstream updates are deliberate migrations: fetch a specific revision, review the upstream diff, replace the source files and hashes, regenerate, and review binding compatibility. Never silently update to the latest upstream at install time.
