#!/bin/sh
set -eu

state_root=$(realpath -m "${ISSUE_PILOT_STATE_ROOT:-.issue-pilot}")
workspace_root=$(realpath -m "${ISSUE_PILOT_WORKSPACE_ROOT:-$state_root/workspaces}")
data_root=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_DATA:-$state_root/code-server-data}")
password_file=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_PASSWORD_FILE:-$state_root/secrets/code-server-password}")
image=${ISSUE_PILOT_CODE_SERVER_IMAGE:-ghcr.io/coder/code-server:4.131.0-39}
port=${ISSUE_PILOT_CODE_SERVER_PORT:-18080}
name=code-server
runtime_version=keep-id-v2-code-server-4.131.0

status() {
  podman inspect "$name"
}

ensure() {
  mkdir -p "$workspace_root" "$data_root" "$(dirname "$password_file")"
  chmod 0700 "$data_root" "$(dirname "$password_file")"
  if [ ! -s "$password_file" ]; then
    umask 077
    head -c 32 /dev/urandom | base64 > "$password_file"
  fi
  chmod 0600 "$password_file"
  if podman inspect "$name" >/dev/null 2>&1; then
    current_version=$(podman inspect --format '{{index .Config.Labels "io.issue-pilot.code-server-runtime"}}' "$name" 2>/dev/null || true)
    if [ "$current_version" = "$runtime_version" ]; then
      podman start "$name" >/dev/null 2>&1 || true
      return
    fi
    podman rm --force "$name" >/dev/null
  fi
  password=$(cat "$password_file")
  podman run --detach --name "$name" --replace \
    --label io.issue-pilot.component=code-server \
    --label "io.issue-pilot.code-server-runtime=$runtime_version" \
    --security-opt no-new-privileges --cap-drop ALL --userns=keep-id \
    --publish "127.0.0.1:$port:8080" \
    --env "PASSWORD=$password" \
    --volume "$workspace_root:/home/coder/project:Z" \
    --volume "$data_root:/home/coder/.local/share/code-server:Z" \
    "$image" --bind-addr 0.0.0.0:8080 /home/coder/project >/dev/null
}

case "${1:-}" in
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  ensure) [ "$#" -eq 1 ] || exit 2; ensure ;;
  stop) [ "$#" -eq 1 ] || exit 2; podman stop "$name" >/dev/null ;;
  *) printf 'Usage: %s status|ensure|stop\n' "$0" >&2; exit 2 ;;
esac
