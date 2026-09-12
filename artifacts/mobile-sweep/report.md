# Mobile sweep — 12 September 2026

## Changes

- Shared cards and form controls shrink within their containers instead of clipping their children.
- Repository cards wrap long titles and badges. Repository pickers preserve room for their controls.
- Breadcrumbs have a separate, horizontally scrollable row on phones; chat headers retain their height.
- Secret name/value/environment inputs stack on phones.
- Model and reasoning controls wrap; chat uses more of the available width and less vertical chrome.
- Long messages, file paths, and model metadata wrap. Markdown tables scroll within the message.
- Publish rows put author/time below the path on phones. Deployment badge groups wrap across rows.
- Confirmation dialogs stay within the visible height and scroll. Popovers stay within the viewport.
- Touch controls have larger targets; archive, manage, and copy actions no longer depend on hover.

## Coverage

The automated sweep renders 39 application routes at 320, 390, 768, and 1280px. Team/member/subagent registrations share route modules; representative scopes are included rather than every possible identifier. It checks document width, unintended clipped content, unexpected redirects, and runtime error overlays. Horizontal scrolling inside tabs, tables, and code remains intentional.

| Screen family | Coverage |
| --- | --- |
| Home/chat | Team list, agent sessions, populated conversation, activity, back navigation |
| Repositories | Dashboard, connect/scaffold, team, member, single agent, nested subagent |
| Configuration | All seven resource categories, source editor, instructions editor, schedule editor, settings |
| Operations | Team/single deployment, run list, populated run detail with a long URL, archived sessions, artifacts |
| Assistant | Chat surface and configuration |
| Marketplace | Catalog, agent/tool detail, installation chooser, populated agent install and file/secret preview |
| Workspace | Settings, connected model picker, members/access, workspace chooser |
| Public/auth | Landing, all five case studies, sign-in steps, signup, forgot/reset password, invitation redirect/error |

Additional interaction checks: sign-in, create an environment, save an agent installation as drafts, review its 157-file publish dialog, model picker, send/receive fake chat, HTML artifact public link and mobile preview overlay, and a 375×420px chat/dialog viewport. Public/auth pages were checked at 320px separately. Screenshots and machine-readable results are local files beside this report.

## Validation

- Final browser pass: 156/156 checks passed (39 routes × four widths), with no unintended overflow, redirects, or runtime error overlays.
- Typecheck passed.
- Production build passed.
- Unit/integration suite: 2,684 passed, 31 skipped (212 test files passed, 17 skipped).
- Independent review identified long run-message wrapping and multi-environment badge wrapping; both fixed.
- Preview interactions used local fixtures; external deployment execution was not exercised.

## Reproduce and limits

See [mobile preview setup](../../scripts/mobile-preview/README.md). The server is at `http://localhost:5293`; marketing is `http://127.0.0.1:5293`. Credentials: `mobile@example.test` / `correct-horse-battery-staple`.

This is Chromium browser verification, including phone viewport/touch emulation and short-height checks. Physical iOS/Android keyboard, browser chrome, and safe-area behaviour still need device testing. External OAuth consent, invitation delivery, and real deployment execution were not exercised. Preview-generated Eve history is in memory and resets when the preview process restarts; the database and draft edits persist.
