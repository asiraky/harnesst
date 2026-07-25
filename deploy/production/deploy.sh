#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/eden}"
readonly STACK_NAME="${STACK_NAME:-eden}"
readonly DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-120}"
readonly STACK_FILE="${DEPLOY_ROOT}/docker-stack.production.yml"
readonly ENV_FILE="${DEPLOY_ROOT}/production.env"
readonly IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required}"
readonly RUNTIME_IMAGE="ghcr.io/zero8ai/eden:${IMAGE_TAG}"
readonly MIGRATION_IMAGE="${RUNTIME_IMAGE}-migrate"
readonly EDEN_SERVICE="${STACK_NAME}_eden"
readonly POSTGRES_SERVICE="${STACK_NAME}_postgres"

diagnostics_enabled=false

log() {
  printf '[deploy] %s\n' "$*"
}

dump_service_diagnostics() {
  local service="$1"
  local container_id

  docker service inspect "$service" >/dev/null 2>&1 || return 0
  printf '\n[deploy] %s tasks\n' "$service" >&2
  docker service ps --no-trunc "$service" >&2 || true
  printf '\n[deploy] %s service logs (last 100 lines)\n' "$service" >&2
  docker service logs --raw --tail 100 "$service" >&2 || true

  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    printf '\n[deploy] container %s logs (last 100 lines)\n' "$container_id" >&2
    docker logs --tail 100 "$container_id" >&2 || true
  done < <(
    docker ps --all --quiet \
      --filter "label=com.docker.swarm.service.name=${service}" 2>/dev/null || true
  )
}

on_error() {
  local exit_code=$?
  local line_number="${1:-unknown}"
  trap - ERR
  printf '[deploy] failed at line %s (exit %s)\n' "$line_number" "$exit_code" >&2
  if [[ "$diagnostics_enabled" == true ]]; then
    dump_service_diagnostics "$EDEN_SERVICE"
    dump_service_diagnostics "$POSTGRES_SERVICE"
  fi
  exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '[deploy] required command not found: %s\n' "$1" >&2
    return 1
  }
}

validate_inputs() {
  require_command docker
  require_command curl
  require_command sudo

  [[ "$DEPLOY_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
    printf '[deploy] DEPLOY_TIMEOUT must be a positive integer\n' >&2
    return 1
  }
  [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
    printf '[deploy] IMAGE_TAG is not a valid container tag\n' >&2
    return 1
  }
  [[ -r "$STACK_FILE" ]] || {
    printf '[deploy] stack file is missing or unreadable: %s\n' "$STACK_FILE" >&2
    return 1
  }
  [[ -r "$ENV_FILE" ]] || {
    printf '[deploy] environment file is missing or unreadable: %s\n' "$ENV_FILE" >&2
    return 1
  }

  local swarm_state
  swarm_state="$(docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}')"
  [[ "$swarm_state" == "active true" ]] || {
    printf '[deploy] this host must be an active Docker Swarm manager (got: %s)\n' \
      "$swarm_state" >&2
    return 1
  }
}

configure_postgres_firewall() {
  log "allowing Docker bridge access to Postgres through ufw"
  sudo -n ufw allow in on docker0 to 172.17.0.1 port 5442 proto tcp
}

deploy_stack() {
  local replicas="$1"
  log "deploying stack ${STACK_NAME} with harnesst replicas=${replicas}"
  (
    cd "$DEPLOY_ROOT"
    export IMAGE_TAG EDEN_PG_PASSWORD
    export EDEN_REPLICAS="$replicas"
    docker stack deploy \
      --with-registry-auth \
      --resolve-image changed \
      --detach=true \
      --compose-file "$STACK_FILE" \
      "$STACK_NAME"
  )
}

service_update_state() {
  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' "$1"
}

assert_update_not_failed() {
  local service="$1"
  local state
  state="$(service_update_state "$service")"
  case "$state" in
    paused|rollback_started|rollback_paused|rollback_completed)
      printf '[deploy] %s entered failed update state: %s\n' "$service" "$state" >&2
      return 1
      ;;
  esac
}

service_version() {
  docker service inspect --format '{{.Version.Index}}' "$1"
}

service_task_template() {
  docker service inspect --format '{{json .Spec.TaskTemplate}}' "$1"
}

service_update_started_at() {
  docker service inspect \
    --format '{{if .UpdateStatus}}{{.UpdateStatus.StartedAt}}{{end}}' "$1"
}

service_has_one_healthy_container() {
  local service="$1"
  local expected_image="${2:-}"
  local container_id container_ids current_state health task_id task_image

  container_ids="$(docker ps --quiet \
    --filter "label=com.docker.swarm.service.name=${service}")"
  [[ -n "$container_ids" && "$container_ids" != *$'\n'* ]] || return 1
  container_id="$container_ids"

  current_state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
  health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$container_id")"
  [[ "$current_state" == "running" && "$health" == "healthy" ]] || return 1

  if [[ -n "$expected_image" ]]; then
    task_id="$(docker inspect \
      --format '{{index .Config.Labels "com.docker.swarm.task.id"}}' \
      "$container_id")"
    [[ -n "$task_id" ]] || return 1
    task_image="$(docker inspect --type task \
      --format '{{.Spec.ContainerSpec.Image}}' "$task_id")"
    [[ "$task_image" == "$expected_image" || "$task_image" == "$expected_image@"* ]] ||
      return 1
  fi
}

wait_for_postgres() {
  local deadline=$((SECONDS + DEPLOY_TIMEOUT))
  local desired

  # Pre-migration readiness is deliberately health-based. Docker retains a
  # completed rollback in UpdateStatus indefinitely, so historical metadata
  # must not prevent a later healthy deployment from migrating.
  log "waiting for ${POSTGRES_SERVICE} to have one healthy replica"
  while ((SECONDS < deadline)); do
    if docker service inspect "$POSTGRES_SERVICE" >/dev/null 2>&1; then
      desired="$(docker service inspect \
        --format '{{.Spec.Mode.Replicated.Replicas}}' "$POSTGRES_SERVICE")"
      if [[ "$desired" == "1" ]] &&
        service_has_one_healthy_container "$POSTGRES_SERVICE"; then
        log "Postgres is healthy"
        return 0
      fi
    fi
    sleep 2
  done

  printf '[deploy] timed out waiting for %s\n' "$POSTGRES_SERVICE" >&2
  return 1
}

wait_for_postgres_rollout() {
  local update_is_current="$1"
  local version_before="$2"
  local version_after="$3"
  local update_started_before="$4"
  local deadline=$((SECONDS + DEPLOY_TIMEOUT))
  local desired update_started update_state

  if [[ "$update_is_current" == true ]]; then
    log "waiting for this deployment's Postgres update (${version_before} -> ${version_after})"
  else
    log "Postgres task spec did not change (${version_before} -> ${version_after}); ignoring historical update metadata"
  fi

  while ((SECONDS < deadline)); do
    if docker service inspect "$POSTGRES_SERVICE" >/dev/null 2>&1; then
      desired="$(docker service inspect \
        --format '{{.Spec.Mode.Replicated.Replicas}}' "$POSTGRES_SERVICE")"

      if [[ "$update_is_current" == true ]]; then
        update_started="$(service_update_started_at "$POSTGRES_SERVICE")"
        # The task template changed in this transaction, but Swarm may not
        # have replaced historical UpdateStatus metadata yet. Only interpret
        # the state after a new StartedAt identifies this rollout.
        if [[ -z "$update_started" || "$update_started" == "$update_started_before" ]]; then
          sleep 2
          continue
        fi
        assert_update_not_failed "$POSTGRES_SERVICE"
        update_state="$(service_update_state "$POSTGRES_SERVICE")"
        [[ "$update_state" == "completed" ]] || {
          sleep 2
          continue
        }
      fi

      if [[ "$desired" == "1" ]] &&
        service_has_one_healthy_container "$POSTGRES_SERVICE"; then
        log "Postgres rollout is complete and healthy"
        return 0
      fi
    fi
    sleep 2
  done

  printf '[deploy] timed out waiting for %s after stack deploy\n' \
    "$POSTGRES_SERVICE" >&2
  return 1
}

run_migrations() {
  log "running database migrations from ${MIGRATION_IMAGE}"
  docker run --rm \
    --network host \
    --env-file "$ENV_FILE" \
    --entrypoint npx \
    "$MIGRATION_IMAGE" \
    drizzle-kit migrate
}

requested_image_is_running() {
  local spec_image="$1"
  local task_image task_state
  local running_total=0
  local running_requested=0

  while IFS='|' read -r task_image task_state; do
    [[ -n "$task_image" ]] || continue
    if [[ "$task_state" == Running* ]]; then
      running_total=$((running_total + 1))
      if [[ "$task_image" == "$RUNTIME_IMAGE" || "$task_image" == "$RUNTIME_IMAGE@"* ]]; then
        running_requested=$((running_requested + 1))
      fi
    fi
  done < <(
    docker service ps \
      --no-trunc \
      --filter desired-state=running \
      --format '{{.Image}}|{{.CurrentState}}' \
      "$EDEN_SERVICE"
  )

  [[ "$spec_image" == "$RUNTIME_IMAGE" || "$spec_image" == "$RUNTIME_IMAGE@"* ]] &&
    [[ "$running_total" -eq 1 && "$running_requested" -eq 1 ]]
}

wait_for_eden() {
  local deadline=$((SECONDS + DEPLOY_TIMEOUT))
  local desired spec_image update_state

  log "waiting for ${EDEN_SERVICE} to run ${RUNTIME_IMAGE}"
  while ((SECONDS < deadline)); do
    if docker service inspect "$EDEN_SERVICE" >/dev/null 2>&1; then
      assert_update_not_failed "$EDEN_SERVICE"
      desired="$(docker service inspect \
        --format '{{.Spec.Mode.Replicated.Replicas}}' "$EDEN_SERVICE")"
      spec_image="$(docker service inspect \
        --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$EDEN_SERVICE")"
      update_state="$(service_update_state "$EDEN_SERVICE")"

      if [[ "$desired" == "1" ]] &&
        [[ -z "$update_state" || "$update_state" == "completed" ]] &&
        requested_image_is_running "$spec_image" &&
        service_has_one_healthy_container "$EDEN_SERVICE" "$RUNTIME_IMAGE"; then
        log "harnesst rollout completed with one healthy container"
        return 0
      fi
    fi
    sleep 2
  done

  printf '[deploy] timed out waiting for %s to converge\n' "$EDEN_SERVICE" >&2
  return 1
}

validate_inputs
configure_postgres_firewall
diagnostics_enabled=true

log "pulling migration image"
docker pull "$MIGRATION_IMAGE"

# Let Docker parse the env file. It is Compose-style input and must never be
# sourced as shell code. The password is captured for stack interpolation and
# is intentionally never written to stdout or command arguments.
EDEN_PG_PASSWORD="$(
  docker run --rm \
    --env-file "$ENV_FILE" \
    --entrypoint node \
    "$MIGRATION_IMAGE" \
    -e 'const required=["EDEN_PG_PASSWORD","DATABASE_URL"]; const missing=required.filter((name)=>!process.env[name]); if (missing.length) { console.error(`missing required environment: ${missing.join(", ")}`); process.exit(1); } process.stdout.write(process.env.EDEN_PG_PASSWORD)'
)"
readonly EDEN_PG_PASSWORD
[[ -n "$EDEN_PG_PASSWORD" ]] || {
  printf '[deploy] EDEN_PG_PASSWORD is missing from %s\n' "$ENV_FILE" >&2
  exit 1
}

postgres_bootstrapped=false
if ! docker service inspect "$POSTGRES_SERVICE" >/dev/null 2>&1; then
  log "Postgres service is absent; starting the one-time bootstrap"
  deploy_stack 0
  postgres_bootstrapped=true
fi

wait_for_postgres
run_migrations
if [[ "$postgres_bootstrapped" == false ]]; then
  postgres_version_before="$(service_version "$POSTGRES_SERVICE")"
  postgres_task_template_before="$(service_task_template "$POSTGRES_SERVICE")"
  postgres_update_started_before="$(service_update_started_at "$POSTGRES_SERVICE")"
fi
deploy_stack 1
if [[ "$postgres_bootstrapped" == true ]]; then
  log "Postgres was bootstrapped in this deployment; verifying the stack reapply by health because Swarm may advance service metadata without starting a task update"
  wait_for_postgres
else
  postgres_version_after="$(service_version "$POSTGRES_SERVICE")"
  postgres_task_template_after="$(service_task_template "$POSTGRES_SERVICE")"
  postgres_update_started_after="$(service_update_started_at "$POSTGRES_SERVICE")"
  postgres_update_is_current=false
  if [[ "$postgres_task_template_after" != "$postgres_task_template_before" ]]; then
    postgres_update_is_current=true
  elif [[ "$postgres_version_after" != "$postgres_version_before" ]] &&
    [[ -n "$postgres_update_started_after" ]] &&
    [[ "$postgres_update_started_after" != "$postgres_update_started_before" ]]; then
    postgres_update_is_current=true
  fi
  wait_for_postgres_rollout \
    "$postgres_update_is_current" \
    "$postgres_version_before" \
    "$postgres_version_after" \
    "$postgres_update_started_before"
fi
wait_for_eden

log "smoke-checking harnesst on localhost:3000"
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:3000/ >/dev/null

log "removing dangling images older than seven days"
docker image prune --force --filter 'until=168h'
log "deployment completed successfully"
