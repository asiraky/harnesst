---
description: Use when you need to open websites, inspect pages, fill forms, click controls, capture screenshots, test web apps, or extract page content through a real browser.
---

# Agent Browser

Use the `agent-browser` CLI from the sandbox shell for browser automation. It drives Chrome/Chromium through CDP and returns compact accessibility snapshots with stable element refs like `@e1`.

## Before First Use

`agent-browser` and Chromium are installed by this skill's sandbox bootstrap, which runs once when the sandbox template is rebuilt after publish and deploy — the result is baked into every session. Confirm the tools are there before you rely on them:

```bash
agent-browser --version
```

If that fails, the sandbox is misconfigured. **Do not install anything.** A session writes to an ephemeral copy of the sandbox, so an install here is thrown away at session end, costs a package fetch every session, and hides the fault from whoever can actually fix it. Report that the agent-browser sandbox bootstrap did not take effect, quote the failing command and its output, and stop — do not attempt the task through some other means.

## Core Workflow

1. Navigate: `agent-browser open <url>`
2. Inspect: `agent-browser snapshot -i`
3. Act using refs from the latest snapshot: `agent-browser click @e1`, `agent-browser fill @e2 "text"`
4. Wait after navigation or async UI changes: `agent-browser wait --load networkidle`
5. Re-snapshot before using refs again.

## Common Commands

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "value"
agent-browser press Enter
agent-browser get title
agent-browser get url
agent-browser get text body
agent-browser screenshot /workspace/home/agent-browser/screenshots/page.png
agent-browser close
```

Use `--json` when you need machine-readable output:

```bash
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

## Rules

- Always take a fresh `snapshot -i` after page navigation, reloads, major DOM updates, or failed clicks.
- Prefer refs from snapshots for precise interaction.
- Use semantic fallbacks when refs are unavailable: `agent-browser find role button click --name "Submit"`.
- Keep screenshots and saved state under `/workspace/home/agent-browser/` so they survive the agent's durable sessions.
- Do not use `--headed`; harnesst sandboxes are headless.
- Close browser sessions when finished unless you need state for the next step.

For the installed CLI's current guidance, run:

```bash
agent-browser skills get core
```
