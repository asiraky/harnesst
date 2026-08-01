---
description:
  Load when the user asks to install, configure, update, or understand the standalone
  Impeccable catalog skill or its harnesst/eve design workflow.
---

# Impeccable (installed skill)

Installs the complete vendored Impeccable design skill under `skills/impeccable/` and the pinned
`impeccable@3.5.0` CLI in the agent sandbox. It disables telemetry and Impeccable's local question
page because harnesst/eve supplies the human-in-the-loop surface. An optional `OPENAI_API_KEY`
enables generated direction sketches; without it the workflow remains supported with text-only
direction cards.

The controlling harnesst/eve adapter is `reference/harnesst-v1.md`. It preserves the direction
roll, structured eve question, network-isolated static preview, built-in child-role handoffs,
detector gate, and stable artifact publishing. Browser capture, static serving, and artifact
publishing remain responsibilities of the host agent template; Designer supplies them through its
own bootstrap and its `agent-browser` and `publish-artifact` includes.

The vendored skill and npm CLI have independent versions. When the payload changes, update
`VENDORED.md`, bump this skill's version and sandbox revalidation key, then bump every parent agent
template that must deliver the newer included files.
