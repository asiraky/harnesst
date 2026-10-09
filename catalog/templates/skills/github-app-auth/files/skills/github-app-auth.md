---
description: Use when calling GitHub (gh or git) with the agent's GitHub App credentials — minting a short-lived installation token AND assuming the App's bot identity for commits. Credential mechanics only; what to actually do on GitHub comes from the task.
---

# GitHub App auth

The credential is **the agent's own GitHub App** — `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`
in the environment (they arrive with the agent's GitHub channel; `GITHUB_APP_SLUG` is the
app's @name). Using it is always the same two steps, in this order, before any other git or
GitHub work:

**1. Mint a token.** GitHub never accepts the private key directly: sign an RS256 JWT as the
app, find the installation that covers what you are about to touch, then
`POST /app/installations/{id}/access_tokens`. The App can be installed on several accounts (your
organization, a personal account), and each installation has its own token — always look the
installation up by the TARGET, never take "the first one". Set `TARGET` to `owner/repo` for work
in a repository, or to just the `owner` for account-level work such as creating a repository.
Run exactly these commands — they are the known-good flow:

```bash
# 1a. Sign a short-lived (~9 min) RS256 App JWT from the private key.
now=$(date +%s)
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$GITHUB_APP_ID" | b64url)
sig=$(printf '%s' "$header.$payload" | openssl dgst -sha256 -sign <(printf '%s' "$GITHUB_APP_PRIVATE_KEY") -binary | b64url)
jwt="$header.$payload.$sig"

# 1b. Find the installation covering TARGET. The App JWT MUST be sent as
#     `Authorization: Bearer` (see the warning below) — use curl, never GH_TOKEN.
TARGET="owner/repo"   # or just "owner" for account-level work
app_get() { curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" "https://api.github.com/$1"; }
case "$TARGET" in
  */*) installation_id=$(app_get "repos/$TARGET/installation" | jq -r '.id') ;;
  *)   installation_id=$( (app_get "orgs/$TARGET/installation" || app_get "users/$TARGET/installation") | jq -r '.id') ;;
esac

# 1c. Mint the installation token and export it for gh.
export GH_TOKEN=$(curl -fsS -X POST \
  -H "Authorization: Bearer $jwt" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${installation_id}/access_tokens" | jq -r '.token')
```

> **Never put the App JWT in `GH_TOKEN` (or `GITHUB_TOKEN`).** `gh` sends those with the
> `token` scheme — `Authorization: token <jwt>` — and GitHub rejects App JWTs sent that way
> with `A JSON web token could not be decoded (HTTP 401)`. App JWTs must go as
> `Authorization: Bearer`, which is why steps 1b/1c use `curl`. **Only** the minted
> installation token (`ghs_…`) belongs in `GH_TOKEN`. If you see that exact 401, it is a
> request-format error — the JWT was sent with the wrong scheme — **not** a broken
> credential or a misconfigured GitHub channel; do not tell the user their credentials need
> fixing.

If 1b fails with HTTP 404, the App is not installed on that repository or account — tell the
user to install it there (`https://github.com/apps/$GITHUB_APP_SLUG/installations/new`), and do
not try another installation instead.

Export the installation token as `GH_TOKEN` for `gh` (done above); for git-over-HTTPS use it
as the password with username `x-access-token`. Tokens expire after about an hour — re-mint
instead of persisting. A token reaches only its own installation's repositories; working in a
repository on another account means minting again with that `TARGET`.

**Which repositories can I reach?** When the user names a project rather than a repository
("the bug in Project X"), list what the App can see and match the name:

```bash
for id in $(app_get "app/installations" | jq -r '.[].id'); do
  t=$(curl -fsS -X POST -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/$id/access_tokens" | jq -r '.token')
  GH_TOKEN="$t" gh api --paginate /installation/repositories --jq '.repositories[].full_name'
done
```

What the token may do inside a repository is the App's permission set: every agent can clone,
branch, push, open pull requests and work issues (labels, comments, edits, closing). Only an
agent whose App was granted repository administration and Actions workflows/secrets/variables
(the team's infra agent) can create repositories or change CI configuration — anyone else gets
HTTP 403 for those, which is by design, not a broken credential.

**2. Assume the credential's identity.** You are acting as the App, so commits must be
authored as its bot account — an identity *derived from the credential*, never chosen.
Immediately after minting the token, before the first commit, run exactly:

```bash
git config --global user.name  "${GITHUB_APP_SLUG}[bot]"
git config --global user.email "$(gh api "/users/${GITHUB_APP_SLUG}%5Bbot%5D" --jq .id)+${GITHUB_APP_SLUG}[bot]@users.noreply.github.com"
```

(`--global` so every repo cloned this session inherits it — per-repo config gets forgotten.)

Never substitute anything else for this identity: not a name you make up, not the human
user's name or email, not an address seen in the repo's commit history, not a placeholder.
GitHub attributes commits by exact email match, so any other value leaves the work
unattributed — and git-connected deploy platforms (Vercel and friends) refuse to build
commits whose author they can't recognize, which silently kills PR preview deployments. The
bot identity passes those checks precisely because it is the credential's own. If
`GITHUB_APP_SLUG` is missing or the id lookup fails, stop and tell the user — do not commit
with a guessed identity.

> **Installation tokens cannot assign the bot to issues.** GitHub refuses it on every API
> (`Assigning agents is not supported with GitHub App installation tokens` /
> `Resource not accessible by integration`). That is platform policy, not an auth failure —
> do not retry, do not report the channel broken, and never treat it as a blocker; claim
> work however your instructions say and keep going. Assigning human collaborators works.

If the app credentials are missing or the first GitHub call fails, stop and tell the user
(the agent's GitHub channel setup provides them) rather than guessing. Never print a token
or the private key, and never ask for a personal access token in chat.
