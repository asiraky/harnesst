# Maintainer production deployment

> **This is maintainer infrastructure for the canonical hosted harnesst instance.** It is not a
> requirement or replacement for the supported OSS self-host setup. Self-hosters should use the
> [single-VPS Docker Compose runbook](../vps/README.md), which does not require Swarm, GHCR, or
> access to harnesst's deployment secrets.

The root [`docker-stack.production.yml`](../../docker-stack.production.yml) and
[`deploy.yml`](../../.github/workflows/deploy.yml) implement continuous deployment for
`asiraky/harnesst`. A push to `main` runs the same typecheck and tests as CI, builds immutable runtime and
migration images, pushes them to GHCR, applies migrations, and updates the `harnesst` Swarm stack on the
maintained VPS. A manual workflow dispatch must select `main` to do the same. Dispatching another
branch runs the checks only; only `refs/heads/main` in the canonical repository may publish images
or deploy. The deploy job also uses secrets scoped to GitHub's `production` Environment, so forks
cannot deploy to this host.

## Production topology

Swarm manages only the services that the deployment workflow replaces:

- `harnesst`: one replica on the manager, attached to Docker's predefined host network and mounting the
  Docker socket. Host networking is required because deployed agent instance URLs use loopback.
- `postgres`: one replica on the manager with its data bind-mounted from
  `/opt/harnesst/volumes/postgres`. It also uses the host network and listens only on
  `127.0.0.1:5442` and `172.17.0.1:5442`.

nginx and certbot remain ordinary Docker Compose containers from `deploy/vps`. Keeping them outside
Swarm preserves the existing certificate volumes, ACME webroot flow, and renewal cron. nginx
continues to reach harnesst and the traffic splitter at `127.0.0.1:3000` and `127.0.0.1:8787`.

The marketing site (landing page + case studies) is host-split: when `MARKETING_HOST` is set in
the harnesst env, those pages serve only on that host while `/` on the app host is Front of House.
Enabling it on this box is a deploy-day step, not a deploy.sh change: DNS A record for the
marketing host, the marketing `server` blocks from `deploy/vps/nginx-harnesst.conf` (same
`127.0.0.1:3000` upstream and verbatim `proxy_set_header` lines — Better Auth rate-limits on the
nginx-owned `X-Real-IP`), certificate coverage via an extra `-d`, and `MARKETING_HOST` in the
stack env. Without it, `/` simply serves Front of House on the sole host.

Swarm cannot safely publish a service port to selected host IP addresses: stack deployment ignores
the IP portion and publishes it on every interface. Postgres therefore joins the host network and
binds the two required addresses itself. Do not replace that with a Swarm `ports` entry; Docker's
iptables rules can expose the database even when ufw appears to block it.

harnesst is intentionally single-process and owns fixed host ports, so its update policy uses one
replica with `order: stop-first`. Expect a short control-plane interruption during each rollout.
Health-check failure triggers Swarm rollback to the previous service specification, but there cannot
be a start-first, zero-downtime handoff until harnesst supports multiple control-plane replicas.

The deployment uses `docker stack deploy --resolve-image changed`, so the unchanged `postgres:17`
service is not re-resolved on every harnesst release. On the first bootstrap, the second stack apply is
verified from the Postgres service and container health because Swarm may advance service metadata
without starting a task update. Ordinary deploys still monitor any current Postgres update through
completion and require its container to be healthy. The transaction also requires the harnesst service
to converge on exactly one task for the requested SHA, that task's container health check to pass,
and the localhost smoke check to succeed.

## One-time host provisioning

These steps assume Docker Engine and the Compose plugin are already installed using the
[self-host runbook](../vps/README.md), and that nginx/TLS is working. Run them as the SSH user the
workflow will use.

1. Give the deploy user access to the Docker daemon, then log out and back in so the new group takes
   effect:

   ```bash
   sudo usermod -aG docker "$USER"
   docker version
   ```

2. Initialize the single-node Swarm if the host is not already a manager:

   ```bash
   docker info --format '{{.Swarm.LocalNodeState}}'
   docker swarm init
   docker node ls
   ```

3. Create the server-side deployment directory. The workflow writes the stack file here, so the
   deploy user must own it.

   ```bash
   sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/harnesst
   sudo install -d -m 0750 -o "$USER" -g "$(id -gn)" /opt/harnesst/volumes
   sudo install -d -m 0700 -o "$USER" -g "$(id -gn)" /opt/harnesst/volumes/postgres
   ```

4. Copy the maintained instance's existing environment file to the path consumed by the stack.
   Keep the file on the host and out of git.

   ```bash
   sudo install -m 0600 -o "$USER" -g "$(id -gn)" \
     ~/apps/harnesst/deploy/vps/.env /opt/harnesst/production.env
   ```

   It uses the same variables documented in [`deploy/vps/env.example`](../vps/env.example),
   including `HARNESST_PG_PASSWORD` and a `DATABASE_URL` that points to
   `postgres://harnesst:<password>@localhost:5442/harnesst`. Back up `HARNESST_SECRETS_KEY` separately; a
   database restore is not useful without it.

## GitHub production Environment

Create an Environment named exactly `production` under **Repository settings → Environments** and
add these Environment secrets:

| Secret                 | Value                                                                |
| ---------------------- | -------------------------------------------------------------------- |
| `PROD_VPS_HOST`        | DNS name or IP address of the maintained VPS                         |
| `PROD_VPS_USER`        | SSH user provisioned above                                           |
| `PROD_VPS_SSH_KEY`     | Private key for that user, including its header and footer           |
| `PROD_VPS_KNOWN_HOSTS` | Verified `known_hosts` record or records for exactly `PROD_VPS_HOST` |

The corresponding user public key must be in `~/.ssh/authorized_keys`. Pin the server host key in
`PROD_VPS_KNOWN_HOSTS`; do not have the deployment job trust a key discovered with `ssh-keyscan` over
the connection it is about to use. The most direct trusted setup is to obtain the public host key and
its fingerprint through the VPS provider's console:

```bash
# Run in the trusted VPS console. Use the exact value stored in PROD_VPS_HOST.
PROD_VPS_HOST=harnesst.example.com
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
sudo awk -v host="$PROD_VPS_HOST" '{print host, $1, $2}' \
  /etc/ssh/ssh_host_ed25519_key.pub
```

Store the `awk` output as the secret. If an operator instead acquires the record from a trusted
workstation, verify it out of band before storing it:

```bash
ssh-keyscan -t ed25519 harnesst.example.com > production-known-hosts
ssh-keygen -lf production-known-hosts -E sha256
```

The second fingerprint must exactly match the fingerprint displayed in the VPS console. The
`ssh-keyscan` output is not trusted merely because it was fetched; the independent fingerprint
comparison is what authenticates it. Include a verified record for each hostname or address that
may be used as `PROD_VPS_HOST`.

Before copying or running anything, the workflow rejects an empty `PROD_VPS_KNOWN_HOSTS`, checks
that it contains a record matching `PROD_VPS_HOST`, and requires SSH to match the presented key
against that pinned record. GHCR authentication uses the workflow's built-in `GITHUB_TOKEN`; do not
create a long-lived package token or put registry credentials in `production.env`.

Environment protection rules are optional, but any required reviewer turns automatic `main`
deployments into approval-gated deployments. The canonical-repository and `main`-ref guards remain
in force for both push and manual runs.

## One-time Compose-to-Swarm cutover

The maintained instance already has live Postgres data in a Compose-managed mount. Preserve that
data and the old mount until the Swarm deployment has been verified. The commands below deliberately
discover the real source from the container instead of guessing Compose's volume name.

1. From the existing checkout, inspect the Postgres data mount and record its source:

   ```bash
   cd ~/apps/harnesst
   docker inspect harnesst-postgres --format \
     '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{printf "%s\t%s\n" .Type .Source}}{{end}}{{end}}'

   POSTGRES_SOURCE="$(docker inspect harnesst-postgres --format \
     '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')"
   test -n "$POSTGRES_SOURCE"
   ```

2. Stop only the old harnesst and Postgres containers. Leave nginx running in front of them; it will
   return an error during the cutover and reconnect to the same loopback ports when Swarm starts
   harnesst.

   ```bash
   docker compose -f deploy/vps/docker-compose.yml stop harnesst postgres
   ```

3. Confirm the destination is empty, then copy every file, including dotfiles, while preserving
   ownership and modes:

   ```bash
   test -z "$(sudo find /opt/harnesst/volumes/postgres -mindepth 1 -print -quit)"
   sudo cp -a "$POSTGRES_SOURCE"/. /opt/harnesst/volumes/postgres/
   sudo chown --reference="$POSTGRES_SOURCE" /opt/harnesst/volumes/postgres
   sudo chmod --reference="$POSTGRES_SOURCE" /opt/harnesst/volumes/postgres
   sudo du -sh "$POSTGRES_SOURCE" /opt/harnesst/volumes/postgres
   ```

   If the emptiness check fails, stop and inspect the directory before copying. Do not merge two
   Postgres data directories.

4. Do **not** run `docker compose down -v`, remove the source volume, or restart the Compose `harnesst`
   and `postgres` services. Keeping the source intact gives the operator a recovery copy; the old
   services must remain stopped because they would contend for the same host ports and database.

5. Run **Deploy production** from the Actions tab and explicitly select the `main` branch, or let the
   next push to `main` trigger it. A dispatch from any other branch runs checks only and cannot
   publish or deploy. The workflow copies the stack definition to `/opt/harnesst`, runs the migration
   image against Postgres, deploys the stack, and waits for both services to finish their current
   update and pass their container health checks before succeeding.

The existing certbot renewal command remains valid. The old Compose project still owns nginx,
certbot, and their certificate volumes; only its harnesst and Postgres services are retired.

## One-time rename cutover (`eden` → `harnesst`)

Issue #213 renamed the deployment identifiers, so a host provisioned before that change carries
`eden` names the current stack definition no longer looks for: the stack and service names, the
`/opt/eden` deploy root, the Postgres role and database, and the `EDEN_*` keys in `production.env`.
Nothing here is derived at runtime — deploying the new definition against an un-migrated host would
create a *second* stack contending for the same host ports and would initdb an empty Postgres
alongside the real one. Do these steps first, in order, in one sitting.

1. Quiesce the app so the database has no client connections (`ALTER DATABASE ... RENAME` fails
   while any session is attached). Postgres stays up:

   ```bash
   docker service scale eden_eden=0
   ```

2. Rename the role and database in place. Connect to the `postgres` database — you cannot rename
   the database you are connected to. The password reset is required, not optional: an MD5 password
   is salted with the role name, so renaming the role silently clears it. Use the same value that
   `EDEN_PG_PASSWORD` holds in `/opt/eden/production.env`.

   ```bash
   PG="$(docker ps -qf name=eden_postgres)"
   docker exec -i "$PG" psql -U eden -d postgres -c 'ALTER DATABASE eden RENAME TO harnesst'
   docker exec -i "$PG" psql -U eden -d postgres -c 'ALTER ROLE eden RENAME TO harnesst'
   docker exec -i "$PG" psql -U harnesst -d postgres \
     -c "ALTER ROLE harnesst WITH PASSWORD '<the EDEN_PG_PASSWORD value>'"
   ```

3. Remove the old stack and wait for its tasks to drain, then move the deploy root. The Postgres
   data directory travels with it; this is a rename on the same filesystem, not a copy.

   ```bash
   docker stack rm eden
   while docker service ls --format '{{.Name}}' | grep -q '^eden_'; do sleep 2; done
   sudo mv /opt/eden /opt/harnesst
   ```

4. Rewrite the env file's keys and its `DATABASE_URL`. Every `EDEN_*` name became `HARNESST_*`;
   values are unchanged. `HARNESST_SECRETS_KEY` must keep its existing value — a new key makes every
   stored secret unreadable.

   ```bash
   sudo cp /opt/harnesst/production.env /opt/harnesst/production.env.bak
   sudo sed -i 's/^EDEN_/HARNESST_/' /opt/harnesst/production.env
   sudo sed -i 's#postgres://eden:#postgres://harnesst:#; s#/eden$#/harnesst#' \
     /opt/harnesst/production.env
   sudo grep -c '^HARNESST_' /opt/harnesst/production.env   # sanity: non-zero
   sudo grep '^DATABASE_URL' /opt/harnesst/production.env | sed 's/:[^:@]*@/:***@/'
   ```

5. Deploy: run **Deploy production** on `main`, or `gh workflow run deploy.yml --ref main`. It
   creates the `harnesst` stack, migrates, and waits for health.

6. nginx needs no change to keep working — it proxies to loopback ports, which the rename does not
   move. Renaming its container and conf file (`eden-nginx`, `eden.conf`) is cosmetic and can be
   done later.

Per-project follow-up, once the control plane is up. Repositories that harnesst manages carry two
generated filenames that were renamed, and existing agent instances carry the old env names:

- In each agent repo: `git mv eden-lock.json harnesst-lock.json`, and for every member root
  `git mv <member>/eden-model.ts <member>/harnesst-model.ts`, updating the `./eden-model` /
  `../../eden-model` imports in `agent.ts` and each `subagents/*/agent.ts`. Without the lock
  rename the Deployment tab shows no installs and stops injecting their secrets.
- Redeploy each agent instance so it receives `HARNESST_*` env instead of `EDEN_*`. Instances keep
  running on their baked-in old names until then.

## Verification and operations

Inspect service state and recent task history on the host:

```bash
docker stack services harnesst
docker service ps harnesst_harnesst --no-trunc
docker service ps harnesst_postgres --no-trunc
docker service logs --tail 200 harnesst_harnesst
docker service logs --tail 200 harnesst_postgres
docker logs --tail 200 harnesst-nginx
```

Confirm harnesst is serving nginx locally and Postgres is not listening on a wildcard address:

```bash
curl -sI http://127.0.0.1:3000 | head -1
sudo ss -ltnp | grep ':5442'
```

Port `5442` should appear only on `127.0.0.1` and the Docker bridge address (normally
`172.17.0.1`), never `0.0.0.0` or `[::]`. Finally, use harnesst to ship an agent and talk to it in the
Playground. That verifies the host-networked control plane can still reach loopback agent instances
and nginx can still reach the splitter.

Swarm automatically attempts the stack's configured rollback when a new harnesst task fails its health
check. To inspect or manually request the retained previous service specification:

```bash
docker service inspect harnesst_harnesst --pretty
docker service update --rollback harnesst_harnesst
docker service ps harnesst_harnesst --no-trunc
```

The deploy transaction applies database migrations before changing harnesst. Swarm rolls back the
service specification and image, not an already-applied database migration, so every production
migration must remain compatible with the previous runtime image.

Each deploy retains SHA-tagged images for traceability and rollback. Only perform a filtered dangling
image prune:

```bash
docker image prune -f
```

Never run `docker system prune -a`, `docker image prune -a`, or `docker volume prune`. Old
control-plane and agent-version images, `eve-sbx-tpl-*` sandbox templates, and `harnesst-home-*` volumes
can all look unused while still being required for rollback or persistent agent state.
