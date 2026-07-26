# Upstream report draft — Scheduled (cron) turns hang before their first step and leak one idle sandbox container per fire

> **Status: DRAFT for vercel/eve — not yet filed.** This is harnesst's evidence package for an upstream
> bug report. harnesst never patches or forks eve (project policy); the harnesst-side mitigation for the
> resulting container leak lives in `app/deploy/sandbox-reaper.server.ts` (issue #118). File this
> against `vercel/eve` once a maintainer channel is chosen.

## Summary

An agent with a `schedules/*.md` cron, deployed with a real Docker sandbox backend
(docker-outside-of-docker: the eve runtime shells out to a host Docker socket to spawn sibling
sandbox containers), fires its schedule on time — a `session`-role sandbox container is created at
each scheduled tick — but the scheduled **turn stalls before its first model/tool step**. No command
is ever executed inside the sandbox (`docker top` shows only the keeper `sleep 2147483647`), the
turn produces no telemetry, and the idle `Up` sandbox container is never torn down. One leaked
container accumulates per scheduled fire, forever.

Playground / interactive turns on the *same* instance and deployment work normally, which localizes
the fault to eve's **schedule/channel turn handling between sandbox creation and the first step** —
not to model access or instance health.

## Environment

- eve runtime image derived from `ghcr.io/vercel/eve` (sandbox base image
  `org.opencontainers.image.source = https://github.com/vercel/eve`,
  `org.opencontainers.image.version = 26.04`).
- **Sandbox backend:** real Docker (`defaultBackend()` picks the docker sandbox when a docker CLI +
  reachable daemon are present). The instance mounts the host `/var/run/docker.sock` and spawns
  **sibling** sandbox containers on the host daemon (docker-outside-of-docker).
- **Workflow world:** Postgres (`WORKFLOW_POSTGRES_URL`), one DB per environment.
- Session sandboxes are started with (verified via `docker inspect`) labels:
  `eve.sandbox=1`, `eve.sandbox.role=session`, `eve.sandbox.tag.channel=<channel>`,
  `eve.sandbox.tag.sessionId=wrun_…`, `eve.sandbox.tag.agent=<agent>`,
  `eve.sandbox.template-key=eve-sbx-tpl-docker-…`. Scheduled turns carry
  `eve.sandbox.tag.channel=schedule`.

## Symptom

For a scheduled agent, every cron tick creates a `session` sandbox that then sits idle indefinitely:

- The container stays `Up` with **only the sandbox keeper process** alive — no exec was ever run
  into it, so no shell/tool activity is possible.
- `ExecIDs` on the container is `null`/empty for the entire lifetime (no `docker exec` was ever
  issued against the sandbox — the model's bash never ran).
- The turn emits **no telemetry** — no run row ever reaches the control plane for a `schedule`
  channel turn.
- Instance container logs are **silent after startup**: nothing is logged when a cron turn starts or
  stalls, so the only trace of the failure is the orphaned container itself.

The containers only ever leave `Up` when the instance is redeployed, at which point they are
SIGKILLed (`Exited (137)`) — i.e. they never finish on their own.

## Evidence (captured from a host reproducing the leak, 2026-07-12)

Session sandboxes accumulating at the schedule interval, days old, still `Up` — 132 of 144
`session` sandboxes on this host carry `channel=schedule`, created at a fixed cron interval:

```
$ docker ps -a --filter label=eve.sandbox.role=session \
    --format '{{.Names}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Label "eve.sandbox.tag.channel"}}'
eve-sbx-ses-docker-…-wrun_01KX2MGS2M5VQ2064AYRPN7H37-__root__  Up 2 days  2026-07-09 15:10:03  schedule
eve-sbx-ses-docker-…-wrun_01KX2M7M49C9QHVWKC8VQTC2AE-__root__  Up 2 days  2026-07-09 15:05:05  schedule
eve-sbx-ses-docker-…-wrun_01KX2KYF4KVB3F1GS0CE08P24S-__root__  Up 2 days  2026-07-09 15:00:07  schedule
eve-sbx-ses-docker-…-wrun_01KX2KNA5CTK1EM42A23JXRETX-__root__  Up 2 days  2026-07-09 14:55:02  schedule
…  (schedule sandboxes at ~5-minute cron ticks across 2026-07-08 / 07-09, all still Up)

$ docker ps -a --filter label=eve.sandbox.role=session \
    --format '{{.Label "eve.sandbox.tag.channel"}}' | sort | uniq -c
  12 http
 132 schedule
```

One leaked `Up` schedule sandbox — only the keeper `sleep` runs, and it never received an exec:

```
$ docker top eve-sbx-ses-docker-…-wrun_01KX2KYF4KVB3F1GS0CE08P24S-__root__
UID    PID    PPID   …  CMD
root   1882   1859   …  /bin/sh -c sleep 2147483647
root   1896   1882   …  sleep 2147483647

$ docker inspect … --format '{{.State.Status}} {{json .ExecIDs}}'
running null

$ docker inspect … --format '{{json .Config.Labels}}'
{"eve.sandbox":"1","eve.sandbox.role":"session","eve.sandbox.tag.agent":"engineer",
 "eve.sandbox.tag.channel":"schedule","eve.sandbox.tag.sessionId":"wrun_01KX2KYF4KVB3F1GS0CE08P24S",
 "eve.sandbox.template-key":"eve-sbx-tpl-docker-…", "org.opencontainers.image.version":"26.04", …}
```

The owning instance container logs nothing after boot (4 lines total for an `harnesst-inst-*` instance),
so a stalled cron turn leaves no log trace at all.

### Prod evidence (from the originating report, harnesst issue #118)

- An agent's hourly schedule (`0 * * * *`) fired on time; a sandbox was created at the top of every
  hour, but **no cron run ever completed**. All 11 hourly sandboxes since a redeploy were still `Up`
  and completely idle (only the keeper `sleep`; no shell artifacts, no git/gh state).
- Pre-redeploy cron sandboxes showed the identical pattern; they only "ended" because a redeploy
  SIGKILLed them (exit 137).
- **Zero rows** in the control-plane `runs` table for any cron-channel run.
- Net effect: the scheduled task does zero work, and the host accumulates one idle `eve-sbx-…`
  container per hour, unbounded.

## Minimal repro

1. Author an agent with a schedule, e.g. `schedules/check-for-tasks.md` with `0 * * * *`
   (any interval; a short one reproduces faster).
2. Deploy it so the eve runtime has a real Docker sandbox backend: a docker CLI in the image and the
   host Docker socket mounted, so `defaultBackend()` selects the docker sandbox and spawns sibling
   sandbox containers on the host daemon.
3. Let the schedule fire. Observe: each tick creates a `eve.sandbox.role=session`,
   `eve.sandbox.tag.channel=schedule` container that **never receives a single `docker exec`**
   (`ExecIDs` stays empty, `docker top` shows only the keeper). The turn stalls before its first
   step; no run/telemetry is produced; the container leaks `Up` indefinitely.

Interactive/playground turns on the same instance execute their first step and complete normally —
so the trigger path (schedule/channel) is implicated, not the sandbox backend or model access.

## What we ruled out

- **Model access.** The model key is valid and the model responds from inside the instance
  container; a playground run on the same instance/deployment completed normally minutes before the
  investigation.
- **Instance health.** The eve server is up, the sandbox template built, and there are no errors in
  the instance logs (they are simply silent after startup).
- **Sandbox backend generally.** Non-schedule channels on the same instance DO exec into their
  sandboxes and make progress; only the schedule path stalls before the first step.

## Possibly-related observation (flagged, not asserted as cause)

On the reproducing host, every instance's `WORKFLOW_POSTGRES_URL` world database
(`harnesst_env_*`) contains **zero tables** — the Workflow world appears never to have been
initialized/migrated with a live schema. We cannot tell whether the scheduled-turn stall is a
consequence of the Workflow persistence layer never coming up, or an independent issue in the
schedule trigger path. Flagging it for maintainers who know the Workflow world lifecycle; we are not
asserting causation.
