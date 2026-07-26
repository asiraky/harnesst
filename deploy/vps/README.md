# Deploying harnesst to a VPS

> **Self-hosters:** this Docker Compose runbook remains the supported OSS deployment path. You do
> not need Docker Swarm, GHCR, or harnesst's GitHub Actions secrets. The repository's
> [`docker-stack.production.yml`](../../docker-stack.production.yml) and
> [maintainer deployment workflow](../../.github/workflows/deploy.yml) run the canonical hosted
> harnesst instance and are provided only as a reference for operators who want a similar CD setup.

This is the supported production topology for self-hosted harnesst today: **one Linux VPS runs
everything** — the harnesst dashboard, Postgres, every deployed agent instance, and their sandbox
containers. That co-residency is by design (the `local-docker` deploy target addresses agent
instances over loopback), so don't split these across machines; scale the box instead.

```
                        ┌─────────────────────────── your VPS ───────────────────────────┐
 https://harnesst.example.com                                                                 │
   │                    │  nginx (container, TLS via Let's Encrypt)                       │
   ├── /e/… ────────────┼──► splitter :8787 ──► agent instance containers (127.0.0.1:*)   │
   └── everything else ─┼──► harnesst :3000 ─► Docker socket (builds images, runs agents) │
                        │                └────► Postgres :5442 (control plane + worlds)   │
                        └─────────────────────────────────────────────────────────────────┘
```

No installer script — the steps below _are_ the deployment: an ordered sequence meant to be run
top to bottom exactly as written, whether you follow it yourself or hand it to a coding agent
you've given SSH access to the box. Everything an install needs is in this directory (this
runbook plus the compose, nginx, and env templates). Budget ~1 hour the first time, most of it in
DNS/TLS, the GitHub App, and Postmark setup.

## 0. What you need before starting

- A VPS running **Ubuntu 24.04 LTS** (other systemd distros work; commands below are apt).
  Sizing: **2 vCPU / 4 GB RAM / 40 GB disk minimum** — agent image builds are the peak load,
  and every agent version keeps an image on disk.
- A **domain** (or subdomain) with an **A record** pointing at the VPS, e.g. `harnesst.example.com`.
  Needed before the TLS step and by external GitHub/Discord callbacks.
- A **Postmark** server with a verified sender for password-reset and workspace-invitation email.
- A **GitHub App** (repo access) — you'll create or reconfigure one to point at your domain.
- An **Anthropic API key** (the authoring assistant) and a model key for deployed agents
  (set later in the product UI, not in the env file).

All commands below assume a sudo-capable user on the VPS.

## 1. Firewall

```bash
sudo apt update && sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Containers call back to the host over the docker bridge (`host.docker.internal` →
`172.17.0.1`): agent and assistant instances dial harnesst's callback API on `3000` (run
ingestion, the team relay and Discord send proxy, the connection token broker for
brokered OAuth providers like May I? — issue #167 — and the brokered-capability route for
capability providers like Xero — issue #166) and Postgres
on `5442`. ufw's default deny drops that traffic too — the failure is silent (connect
timeouts inside containers; for the assistant, `harnesst_*` tools failing and conversation
checkouts never appearing). Allow both ports on the bridge interface only; this exposes
nothing to the internet:

```bash
sudo ufw allow in on docker0 to 172.17.0.1 port 3000 proto tcp
sudo ufw allow in on docker0 to 172.17.0.1 port 5442 proto tcp
```

(If you customized the docker0 subnet, adjust `172.17.0.1` accordingly. To confirm this is
your problem later: `sudo grep "DPT=3000" /var/log/ufw.log` — blocked lines with `IN=docker0`.)

> **Docker bypasses ufw.** Docker programs iptables directly, so a container port published as
> `-p 5442:5432` is reachable from the internet _no matter what ufw says_. The compose file in
> this directory avoids that by publishing Postgres only on `127.0.0.1` and `172.17.0.1`
> (the docker bridge), and agent instances are already loopback-only. If you ever edit port
> mappings, keep explicit bind addresses.

## 2. Install Docker Engine

Follow [Docker's apt instructions](https://docs.docker.com/engine/install/ubuntu/), or condensed:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" |
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # then log out and back in
docker run --rm hello-world     # verify
```

## 3. Clone harnesst

```bash
mkdir -p ~/apps
git clone https://github.com/<your-fork-or-org>/harnesst.git ~/apps/harnesst
cd ~/apps/harnesst
```

## 4. Configure the environment

```bash
cp deploy/vps/env.example deploy/vps/.env
```

Fill in every value (`deploy/vps/.env` is gitignored). Notes per section:

> **Upgrading an installation older than issue #213?** Every `EDEN_*` variable is now
> `HARNESST_*`, and the Postgres role and database are `harnesst` rather than `eden`. Values are
> unchanged — keep `HARNESST_SECRETS_KEY` exactly as it was or stored secrets become unreadable.
> `deploy/production/README.md` has the in-place migration, including the role rename (which
> clears an MD5 password and so needs a reset) and the two generated filenames that change inside
> each managed agent repository.

- **Postgres** — invent a strong `HARNESST_PG_PASSWORD` and write the same password into
  `DATABASE_URL` (env-file values are literal; no variable expansion).
- **`HARNESST_SECRETS_KEY`** — `openssl rand -hex 32`. This encrypts every secret your users store
  in harnesst; **back it up** somewhere that isn't this VPS.
- **Better Auth** — set `BETTER_AUTH_URL` to the exact public origin
  (`https://harnesst.example.com`) and generate `BETTER_AUTH_SECRET` with
  `openssl rand -base64 32`. Keep that secret backed up; rotating it invalidates authentication
  state. Better Auth runs inside harnesst and stores users, sessions, organizations, members, and
  invitations in Postgres, so there is no external auth dashboard or callback registration. Keep
  port 3000 private behind the supplied nginx: it overwrites `X-Real-IP`, which Better Auth trusts
  for per-client production rate limiting.
- **`MARKETING_HOST` (optional)** — leave unset for a normal install: `/` serves harnesst's
  Front of House (sign-in when logged out). Set it (bare host, e.g. `www.harnesst.example.com`)
  only to serve the marketing landing page + case studies from their own subdomain: add a DNS
  A record for that host, fill in the marketing `server` blocks at the bottom of
  `deploy/vps/nginx-harnesst.conf`, and extend the certificate with an extra `-d <marketing-host>`
  in step 6.
- **Transactional email** — set `POSTMARK_SERVER_TOKEN` and `FROM_EMAIL` to a verified Postmark
  sender. Better Auth uses it for password resets and organization invitations. Local development
  may use `SMTP_URL` with Mailpit or Mailtrap instead, but production intentionally uses Postmark.
- **GitHub App** — create one at _Settings → Developer settings → GitHub Apps_ (or repoint an
  existing one):
  - **Webhook URL**: `https://harnesst.example.com/api/github/webhook`, with a
    **webhook secret** you generate (`openssl rand -hex 20`) and copy into the env file.
  - **Setup URL**: `https://harnesst.example.com/connect` (check "Redirect on update").
  - **Callback URL**: `https://harnesst.example.com/github/installations/callback` (GitHub App OAuth).
  - **Permissions**: Contents (R/W), Pull requests (R/W), Administration (R/W — repo creation),
    Metadata (R).
  - **Events**: Push, Pull request.
  - Generate a **private key** (PEM) and a **client secret**; copy the App ID, slug, client ID,
    client secret, and key into the env file. The PEM can be pasted as one line with `\n`
    escapes.
  - After upgrading an existing harnesst deployment, reauthorize every installation from **Connect**.
    Legacy project references are preserved when they map cleanly, but GitHub-backed reads, writes,
    builds, assistant checkouts, and deploys fail closed until the OAuth proof succeeds.
- **Discord app (optional)** — for the one-click Discord channel (issue #32), register **one**
  Discord application for this installation at
  [discord.com/developers/applications](https://discord.com/developers/applications):
  - **OAuth2 → Redirects**: add `https://harnesst.example.com/discord/callback`.
  - The **Interactions Endpoint URL** needs no portal setup: harnesst sets it to
    `https://harnesst.example.com/api/discord/interactions` via Discord's API the first time a user
    runs Connect Discord (and re-asserts it on every connect, so a portal edit heals itself).
  - Copy the **Application ID** → `HARNESST_DISCORD_APPLICATION_ID`, the **Public Key** →
    `HARNESST_DISCORD_PUBLIC_KEY`, and a **Bot** token → `HARNESST_DISCORD_BOT_TOKEN`. The bot token
    stays on the control plane and is never shipped to agent instances. Users then connect
    servers from each agent's Deployment tab — nothing else to configure per agent.
- **`HARNESST_PUBLIC_ORIGIN` (optional)** — set it to harnesst's public origin
  (`https://harnesst.example.com`) so every deployed instance receives `EVE_PUBLIC_ORIGIN` — its
  per-environment public ingress URL — letting channels/connections that take inbound webhooks
  build callback URLs.

## 5. Build and start the stack

The compose file is gitignored so you can tweak it — start from the tracked template (same
copy-and-tweak pattern as `env.example` above):

```bash
cd ~/apps/harnesst
cp deploy/vps/docker-compose.example.yml deploy/vps/docker-compose.yml
docker compose -f deploy/vps/docker-compose.yml up -d --build harnesst  # brings up postgres too
docker compose -f deploy/vps/docker-compose.yml run --rm --build migrate  # apply DB schema
docker compose -f deploy/vps/docker-compose.yml logs -f harnesst        # watch it boot
```

(This starts Postgres and harnesst but not nginx — nginx needs a TLS cert first, which step 6
sets up.)

harnesst now serves plain HTTP on port `3000`. Because it uses host networking, it binds all
interfaces (`0.0.0.0:3000`), not just loopback — so it's the **firewall** (step 1, which never
opens 3000) that keeps it off the internet, not the bind address. nginx terminates TLS and
proxies to it locally. Verify from the VPS:

```bash
curl -sI http://127.0.0.1:3000 | head -1   # expect HTTP/1.1 200 or a 30x to /login
```

## 6. Nginx + TLS (both containerized)

nginx and certbot run as containers in this same compose stack (the `nginx` service and the
`certbot` tool service) — nothing TLS-related is installed on the host. nginx terminates TLS and
proxies `/e/…` (agent channel traffic) to the splitter on `:8787` and everything else to harnesst on
`:3000`, with buffering off — harnesst streams (assistant, playground), and buffered SSE looks like a
hang.

Point the site config at your domain:

```bash
cd ~/apps/harnesst
sed -i 's/harnesst.example.com/<your-domain>/g' deploy/vps/nginx-harnesst.conf
```

The config has a TLS server block, so nginx won't start until a certificate exists — a
chicken-and-egg. Break it with a throwaway self-signed cert, boot nginx, then replace it with the
real one over the ACME **webroot** (the same method the renewal cron uses):

```bash
CO="docker compose -f deploy/vps/docker-compose.yml"

# 1. Placeholder cert (1-day self-signed) so nginx can boot.
$CO run --rm --entrypoint sh certbot -c '
  mkdir -p /etc/letsencrypt/live/<your-domain> &&
  openssl req -x509 -newkey rsa:2048 -days 1 -nodes -subj "/CN=<your-domain>" \
    -keyout /etc/letsencrypt/live/<your-domain>/privkey.pem \
    -out    /etc/letsencrypt/live/<your-domain>/fullchain.pem'

# 2. Start nginx (serves :80 ACME challenges + :443 with the placeholder).
$CO up -d nginx

# 3. Drop the placeholder, obtain the real cert via the webroot, then reload nginx.
#    (nginx keeps serving the old cert from open handles until the reload.)
$CO run --rm --entrypoint sh certbot -c '
  rm -rf /etc/letsencrypt/live/<your-domain> \
         /etc/letsencrypt/archive/<your-domain> \
         /etc/letsencrypt/renewal/<your-domain>.conf'
$CO run --rm certbot certonly --webroot -w /var/www/certbot -d <your-domain> \
  --agree-tos -m you@example.com --no-eff-email
docker exec harnesst-nginx nginx -s reload
```

Confirm TLS from anywhere:

```bash
curl -sI https://<your-domain> | head -1   # expect HTTP/2 200 (or a 30x to /login)
```

**Marketing host (optional):** if you set `MARKETING_HOST` in step 4, request the certificate
for both names in one lineage — append `-d <marketing-host>` to the `certbot certonly` command
above (the marketing `server` blocks in `nginx-harnesst.conf` reference the same
`/etc/letsencrypt/live/<your-domain>/` paths). The marketing host needs its own DNS A record
pointing at this VPS before issuance.

**Renewal** is a weekly host cron entry — certbot's own systemd timer isn't in play here since
it's containerized. Add it with `crontab -e`:

```
17 3 * * 1 cd ~/apps/harnesst/deploy/vps && docker compose run --rm certbot renew --quiet && docker exec harnesst-nginx nginx -s reload
```

## 7. First login & smoke test

1. Open `https://<your-domain>/signup` — you should see harnesst's email/password sign-up form.
2. Create the first account. Better Auth creates the session, and harnesst provisions the account's
   first organization-backed workspace.
3. Sign out, use **Forgot password** on the email-first login, and confirm the Postmark reset link
   lets you set a new password without an email-verification step.
4. Invite a second address from **Members**. Confirm the recipient must use harnesst's Postmark
   verification link before Better Auth reveals and accepts the organization invitation.
5. In **Settings**, set the workspace **model key** — this is what deployed agents use to call
   models; without it, deploys come up but every turn fails.
6. **Connect** a repo (the GitHub App install flow should round-trip through your domain and
   land back on `/connect`).
7. Create or open an agent, **Ship** it, and talk to it in the **Playground**. The first ship
   builds a full agent image (several minutes). The deploy itself is usually seconds — but an
   agent with skills or a sandbox `bootstrap()` prewarms its sandbox template on first boot
   (pulls `ghcr.io/vercel/eve`, runs bootstrap, snapshots an `eve-sbx-tpl-*` image), which can
   add several more minutes the first time. harnesst waits up to 10 minutes before calling a
   deploy failed; later deploys and wakes reuse the cached template and are fast.

If Ship fails at the build step, `docker compose … logs harnesst` has the real error. A deploy-step
failure includes the agent container's own log tail in the UI's failure detail (a broken
sandbox `bootstrap()` shows up there).

## 8. Operations

**Updating harnesst**

```bash
cd ~/apps/harnesst && git pull
docker compose -f deploy/vps/docker-compose.yml up -d --build
docker compose -f deploy/vps/docker-compose.yml run --rm --build migrate
```

The `--build` on the `migrate` step is **not** optional. The `migrate` service is behind the
`tools` profile, so the preceding `up -d --build` does _not_ rebuild its image — without `--build`
here, `run --rm migrate` executes whatever image a _previous_ deploy built, which is missing any
migration files added since. drizzle-kit then finds nothing new and prints `migrations applied
successfully!` while the new migration is silently skipped.

Verify the migration actually landed — the row count in `drizzle.__drizzle_migrations` should match
the number of entries in `drizzle/meta/_journal.json`:

```bash
docker exec harnesst-postgres psql -U harnesst harnesst -tAc \
  'select count(*) from drizzle.__drizzle_migrations'                 # DB rows
grep -c '"idx"' drizzle/meta/_journal.json                            # journal entries
```

Agent instances keep running through a harnesst update (they're independent containers); an
update never rebuilds or restarts them.

**Backups** — two things matter: Postgres (all control-plane + agent session state) and
`HARNESST_SECRETS_KEY` (without it, a restored DB's secrets are unreadable).

```bash
# e.g. in cron, daily:
docker exec harnesst-postgres pg_dump -U harnesst harnesst | gzip > /var/backups/harnesst-$(date +%F).sql.gz
```

**Disk** — agent builds accumulate images. Reclaim space with a _filtered_ prune:

```bash
docker image prune -f          # dangling layers only — safe
```

Do **not** run `docker system prune -a` or `docker volume prune`: agent version images (reused
for instant rollback), `eve-sbx-tpl-*` sandbox template images (a RUNNING instance whose
template is pruned loses its bash tools until the instance restarts and re-prewarms), and
`harnesst-home-*` volumes (each agent's persistent `/workspace/home`) all look "unused" to Docker
whenever the agent isn't running, and pruning them destroys rollbacks and agent state.

**Logs** — `docker compose … logs harnesst` for the control plane; agent containers are named
`harnesst-inst-<deploymentId>` (`docker logs <name>`) and sandbox containers carry the
`eve.sandbox=1` label.

## Security notes

- harnesst's container mounts the **Docker socket** — that is root-equivalent on this host. It's
  what lets harnesst build and run agent containers (and lets agents get real Docker sandboxes),
  and it's the standard trade-off of the single-box topology. Don't co-host unrelated services.
- Agent sandbox containers run with the images and network policy eve requests; they are for
  the agents' _own_ code and shell use. Treat the whole box as the trust boundary.
- Postgres is reachable only from the host and the docker bridge (see the firewall note);
  the only public ports are 22/80/443.

## Known limitations (deliberate, for now)

- **Single host only.** The control plane, instances, and worlds must co-reside — the deploy
  target stores loopback instance URLs. Multi-host (and Cloudflare/Vercel targets) live behind
  the same `DeployTarget` seam, later.
- **No horizontal scaling of harnesst itself** — in-process job worker, splitter, and caches assume
  one process. One box, one harnesst.
- Run-ingest from agents deployed _elsewhere_ (BYO instances posting back to
  `/api/ingest/runs`) needs your public URL configured on that side; nothing on the VPS blocks it.
