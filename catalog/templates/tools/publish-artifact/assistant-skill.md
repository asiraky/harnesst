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

**Pages** — a single `.html` file, or a directory holding `index.html` plus the css, js, json, font
and image files it loads (at most 40 files, 25 MB in total). Pass `kind: "html"` when publishing a
directory; a lone `.html` path is recognised on its own. Every member needs a plain name (letters,
digits, dots, dashes, no leading dot) and an allowed extension — one unexpected file refuses the
whole publish rather than silently dropping it, and symlinks are refused, so copy real files in.
Name the page `index.html`; a directory with two HTML files and no `index.html` is ambiguous and
refused.

A page is opened by the user from its card, in a preview panel that renders it sandboxed: no network
access, no form submission, no storage, no cookies, no access to anything of the user's. Write it as
a self-contained page — inline styles and scripts, or local sibling files, and data URIs for small
assets. Anything fetched from a CDN or an external host will not load. That is also why a page
publish returns no URL: there is no permanent link to quote, so say in the reply that you published
the page and let the card open it.

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
