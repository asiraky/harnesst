---
description: Load when an agent has the Publish Artifact tool installed and the request involves
  showing something to the person in the conversation — screenshots, charts, diagrams, rendered
  designs, a built HTML page or mock-up, "show me what it looks like", visual before/after checks.
---

# Publish Artifact (installed tool)

Publishes an image, or a static HTML page, from the agent's home directory into the Front of House
conversation, where it renders as a card the user can see. Only the PATH crosses the wire: harnesst
copies the bytes out of the agent's home volume at publish time, so the card survives the agent
scaling to zero or redeploying.

**Images** — PNG, JPEG, WebP or SVG, up to 25 MB. The type is read from the file's own bytes, so
renaming something else to `.png` is refused. Images are served back behind the user's own sign-in
and render straight into the card.

**Pages** — a single `.html` file, or a directory holding `index.html` plus the css, js, font and
image files it loads (at most 40 files, 25 MB in total). `kind` is always passed — `"html"` renders
the page live in a sandboxed preview, `"image"` displays a picture. Every member needs a plain name (letters,
digits, dots, dashes, no leading dot) and an allowed extension — one unexpected file refuses the
whole publish rather than silently dropping it, and symlinks are refused, so copy real files in.
Name the page `index.html`; a directory with two HTML files and no `index.html` is ambiguous and
refused.

A page is opened by the user from its card, in a preview panel that renders it sandboxed: no network
access, no form submission, no storage, no cookies, no access to anything of the user's. Write it as
a self-contained page — inline styles and scripts, or local sibling files, and data URIs for small
assets. Anything fetched from a CDN or an external host will not load.

`fetch()` and `XMLHttpRequest` do not work AT ALL in the preview, including against the page's own
sibling files: a `fetch('./data.json')` returns nothing and the page half-renders with no visible
reason. Put data in the page — a `<script>` literal, or a `<script type="application/json">` block
read with `textContent`. Stylesheets, scripts, fonts and images loaded with `<link>`, `<script src>`
and `<img src>` are fine; only the network APIs are closed.

That is also why a page publish returns no URL: there is no permanent link to quote, so say in the
reply that you published the page and let the card open it.

**Revising something you already published** — publish it again under the SAME file name. The card
already in the conversation updates in place to the new version, with a version picker the user can
look back through; a new name would leave them with two cards and no idea which is current. So
overwrite `artifacts/chart.png` and publish that path again rather than writing `chart-v2.png`. The
reply tells you the version number, and tells you when the file was unchanged (`updated: false`) —
in that case say so instead of claiming you updated it. The card stays where it was first published,
so mention the update in your reply; the user may be scrolled somewhere else.

A name is fixed to one kind for the life of the conversation: a name published as an image cannot
later be republished as a page, or the other way round. Publish that under a different name. Around
fifty publishes of one name is the ceiling, and only the most recent handful stay openable in the
picker — plenty for refining something, not an archive to write history into.

Either kind must live under `/workspace/home`: write it to `/workspace/home/artifacts/` (create the
directory if needed), or publish a browser screenshot straight out of
`/workspace/home/agent-browser/screenshots/` when the agent-browser skill is installed too.

Publishing only works from INSIDE the turn you are answering someone in harnesst: the card goes to
that conversation, and harnesst refuses rather than guess when there is no live conversation (a
background/channel run) or when the agent happens to be answering two people at once. So publish as
part of the reply that mentions it, not from a scheduled job or a follow-up pass.

Pair it with whatever produced the artifact: an agent that takes screenshots, renders a chart, or
builds a page has nowhere to put the result otherwise — a file path in a reply is not something a
user can look at. The card is its own transcript element, so the reply should MENTION what was
published rather than trying to embed it in markdown (agent-written image markdown is never loaded).
