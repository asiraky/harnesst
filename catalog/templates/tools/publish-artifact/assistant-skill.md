---
description: Load when an agent has the Publish Artifact tool installed and the request involves
  showing an image to the person in the conversation — screenshots, charts, diagrams, rendered
  designs, "show me what it looks like", visual before/after checks.
---

# Publish Artifact (installed tool)

Publishes an image file from the agent's home directory into the Front of House conversation,
where it renders as a card the user can see. Only the PATH crosses the wire: harnesst copies the
bytes out of the agent's home volume at publish time, so the card survives the agent scaling to
zero or redeploying, and serves them back behind the user's own sign-in.

Images only for v1 — PNG, JPEG, WebP or SVG, up to 25 MB — and the type is read from the file's
own bytes, so renaming something else to `.png` is refused. The file must live under
`/workspace/home`: write it to `/workspace/home/artifacts/` (create the directory if needed), or
publish a browser screenshot straight out of `/workspace/home/agent-browser/screenshots/` when the
agent-browser skill is installed too.

Publishing only works from INSIDE the turn you are answering someone in harnesst: the card goes to
that conversation, and harnesst refuses rather than guess when there is no live conversation (a
background/channel run) or when the agent happens to be answering two people at once. So publish as
part of the reply that mentions the image, not from a scheduled job or a follow-up pass.

Pair it with whatever produced the image: an agent that takes screenshots, renders a chart, or
generates a diagram has nowhere to put the result otherwise — a file path in a reply is not
something a user can look at. The card is its own transcript element, so the reply should MENTION
the published image rather than trying to embed it in markdown (agent-written image markdown is
never loaded).
