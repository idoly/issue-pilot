#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
state="$root/.issue-agent/podman"
env_file="${ISSUE_AGENT_ENV_FILE:-$root/infra/.env}"
network="issue-agent-dev"
postgres_name="issue-agent-postgres"
keycloak_name="issue-agent-keycloak"
label="io.issue-agent.project=$root"

require_env() {
  [ -f "$env_file" ] || {
    printf 'Missing %s. Create it from infra/.env.example.\n' "$env_file" >&2
    exit 1
  }
  mode=$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file")
  [ "$mode" = "600" ] || {
    printf '%s must have mode 600 (current: %s).\n' "$env_file" "$mode" >&2
    exit 1
  }
}

start() {
  require_env
  mkdir -p "$state/postgres"
  podman network inspect "$network" >/dev/null 2>&1 || podman network create --label "$label" "$network" >/dev/null

  if ! podman container exists "$postgres_name"; then
    podman run --detach \
      --name "$postgres_name" \
      --label "$label" \
      --network "$network" \
      --env-file "$env_file" \
      --publish "127.0.0.1:${POSTGRES_PORT:-5432}:5432" \
      --volume "$state/postgres:/var/lib/postgresql/data:U,Z" \
      --volume "$root/infra/postgres/init-databases.sh:/docker-entrypoint-initdb.d/10-init-databases.sh:ro,Z" \
      --health-cmd "pg_isready -U issue_agent -d issue_agent" \
      --health-interval 5s --health-timeout 3s --health-retries 20 \
      --security-opt no-new-privileges \
      docker.io/library/postgres:17.5-alpine >/dev/null
  else
    podman start "$postgres_name" >/dev/null
  fi

  attempts=0
  until [ "$(podman inspect "$postgres_name" --format '{{.State.Health.Status}}')" = "healthy" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 40 ] || { podman logs "$postgres_name"; exit 1; }
    sleep 2
  done

  if ! podman container exists "$keycloak_name"; then
    podman run --detach \
      --name "$keycloak_name" \
      --label "$label" \
      --network "$network" \
      --env-file "$env_file" \
      --publish "127.0.0.1:${KEYCLOAK_PORT:-8080}:8080" \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      quay.io/keycloak/keycloak:26.3.1 start-dev --health-enabled=true >/dev/null
  else
    podman start "$keycloak_name" >/dev/null
  fi

  printf 'PostgreSQL: 127.0.0.1:%s\nKeycloak: http://127.0.0.1:%s\n' "${POSTGRES_PORT:-5432}" "${KEYCLOAK_PORT:-8080}"
}

stop() {
  podman rm --force "$keycloak_name" "$postgres_name" 2>/dev/null || true
  podman network rm "$network" 2>/dev/null || true
}

status() {
  podman ps --all --filter "label=$label" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) printf 'Usage: %s start|stop|status\n' "$0" >&2; exit 2 ;;
esac
