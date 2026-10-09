---
description:
  Load when an agent has the Publish Artifact tool installed and needs to retain or show
  a file in the conversation — screenshots, charts, PDF evidence, rendered designs, HTML pages,
  reports in markdown, data as CSV or JSON, code, audio, video, or any other file.
---

# Publish Artifact (installed tool)

Publishes an image, PDF document, static HTML page, or any other file from the current agent or
subagent's home directory. In a live Front of House conversation it appears as a card the user can
see; from a background or scheduled run it is published without a card, reachable through its
public link. For a PDF or other file, the tool reads it from its own sandbox (which, in a declared
subagent, is isolated) and sends it in the private tool request; the bytes never enter model
context. Harnesst stores the exact bytes at
publish time, so the artifact survives the agent scaling to zero or redeploying.

Every publish returns `shareUrl`: a stable PUBLIC link to the artifact's newest version that
anyone holding it can open, with no harnesst sign-in. Quote it in your reply (or post it to a
channel) whenever the result is meant to be shared; keep it out of the reply when the content is
sensitive — the URL itself is the only key, and an operator can revoke or rotate it from the
repository's Artifacts page. Republishing the same name updates what the link shows; the link
itself does not change.

**Images** — PNG, JPEG, WebP, GIF, AVIF or SVG, up to 25 MB. The type is read from the file's own bytes, so
renaming something else to `.png` is refused. Images are served back behind the user's own sign-in
and render straight into the card.

**Documents** — PDF, up to 25 MB. Pass `kind: "document"`. The PDF signature is checked from the
bytes, then the exact version is retained behind the user's sign-in and opens in a PDF viewer. Keep
the returned
`artifactId`, immutable `artifactVersionId` and `sha256` when another record needs to identify the
evidence.

**Files** — anything else, up to 25 MB. Pass `kind: "file"`. Markdown renders as a document, CSV
and TSV as a table, JSON pretty-printed, code and plain text with line numbers, audio and video in a
player; any other format is offered as a download. The type comes from the file's extension, so
name it for what it is (`report.md`, `results.csv`, `clip.mp4`). Prefer this over a page when the
content is a report or a table: the user gets a native viewer and the raw file.

**Pages** — a single `.html` file, or a directory holding `index.html` plus the css, js, font,
image, media and data (json, csv, md, txt) files it loads (at most 40 files, 25 MB in total).
`kind` is always passed — `"html"` renders the page live in a sandboxed preview, `"image"`
displays a picture. Every member needs a plain name (letters,
digits, dots, dashes, no leading dot) and an allowed extension — one unexpected file refuses the
whole publish rather than silently dropping it, and symlinks are refused, so copy real files in.
Name the page `index.html`; a directory with two HTML files and no `index.html` is ambiguous and
refused.

A page is opened by the user from its card, in a preview panel that renders it live in a sandbox:
scripts run, and it has no access to the user's harnesst session, cookies or anything of theirs.
The page may load scripts, styles and fonts from public CDNs (a charting library, a web font), and
`fetch('./data.json')` of its own sibling files works, so data can live next to the page. Links
written root-relative (`/style.css`) resolve inside the page's own directory. `localStorage` works
but is forgotten when the preview closes. Console output and errors are shown to the user in the
preview panel, so an exception is visible rather than a blank page.

The same sandbox applies when a page is opened through its public `shareUrl`, which always serves
the newest version. A page publish returns no in-app `url` (the preview is minted when the user
opens the card), so `shareUrl` is the one link you can quote for a page.

**Revising something you already published** — publish it again under the SAME file name. The card
already in the conversation updates in place to the new version, with a version picker the user can
look back through; a new name would leave them with two cards and no idea which is current. So
overwrite `artifacts/chart.png` and publish that path again rather than writing `chart-v2.png`. The
reply tells you the version number, and tells you when the file was unchanged (`updated: false`) —
in that case say so instead of claiming you updated it. The card stays where it was first published,
so mention the update in your reply; the user may be scrolled somewhere else. The response also
includes `artifactVersionId`, the immutable identifier to retain when another structured record
needs to point at the exact bytes from this publish rather than whichever version is newest later.

A name is fixed to one kind for the life of the conversation: a name published as an image cannot
later be republished as a page or document, or the other way round. Publish that under a different name. Around
fifty publishes of one name is the ceiling, and only the most recent handful stay openable in the
picker — plenty for refining something, not an archive to write history into.

Every kind must live under `/workspace/home`: write it to `/workspace/home/artifacts/` (create the
directory if needed), or publish a browser screenshot straight out of
`/workspace/home/agent-browser/screenshots/` when the agent-browser skill is installed too.

WHERE a publish lands depends on when it happens. Inside the turn you are answering someone in
harnesst, the card goes to that conversation — publish as part of the reply that mentions it.
From a background, scheduled or channel run there is no conversation: the publish still succeeds,
with no card, and the `shareUrl` (plus the repository's back-of-house Artifacts page) is how
anyone reaches it — so a background run that produces something should include the `shareUrl` in
whatever it reports. Background publishes of one name are their own artifact, separate from any
conversation's card with the same name. harnesst still refuses rather than guess when the agent is
answering two people at once, or when several background runs are executing on the same deployment
and it cannot tell whose workspace holds the file.

Pair it with whatever produced the artifact: an agent that downloads evidence, takes screenshots,
renders a chart, or builds a page can preserve the exact output without moving its bytes through
model context. A declared subagent can publish a PDF from its own sandbox and return the immutable
`artifactVersionId` to the parent; this is the safe cross-agent handle because sandbox paths are not
shared. The card is its own transcript element, so the reply should mention what was published
rather than trying to embed it in markdown.
