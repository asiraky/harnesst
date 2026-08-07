---
description: Load when the team has (or is adding) the Vercel Issuer agent and the request
  involves provisioning Vercel access for an agent, approving or debugging a provision request,
  token scoping/expiry, or why a teammate's Vercel credential hasn't arrived yet.
---

# Vercel Issuer (installed agent)

The team's credential authority for Vercel. It holds the one full-account token
(`VERCEL_MASTER_TOKEN`, entered at install) and exposes two always-gated tools:

- **vercel-provision** — creates a project, mints a project-scoped (`vcp_…`) token with a TTL,
  and deposits it into a named teammate's container env via harnesst's deposit route. The bearer
  token is never returned or shown; if delivery fails the token is revoked. On success the
  teammate's env gets `VERCEL_TOKEN` (and `VERCEL_PROJECT_ID`), delivered by a queued
  same-release redeploy.
- **vercel-cli** (included tool) — the generic gated CLI wrapper, always approval-gated on this
  agent because the master token is present.

The flow: a dev agent delegates "I need a Vercel project" → the issuer calls vercel-provision →
its turn parks as an approval item in Front of House (structured request + justification) → a
human approves → project created, token minted and deposited → the issuer tells the requester.
The requester's delegation returns "waiting on human" — that is normal, not an error.

Debugging pointers:

- "Credential deposit is not configured" from vercel-provision means the deployment lacks
  `HARNESST_SECRETS_DEPOSIT_URL` — the committed lock must carry the vercel-issuer install for
  that member; redeploy after installing from the marketplace.
- The deposit route only accepts `VERCEL_*` keys, only from a member whose committed lock carries
  the issuer install, and only for members of the same project.
- A teammate that still sees "no Vercel credential configured" after approval is usually waiting
  on the queued redeploy that delivers the env.
- The issuer's approval gates are hardcoded (`always()` in its tool files, and the CLI wrapper
  force-gates whenever `VERCEL_MASTER_TOKEN` is set) — do not offer to disable them.
