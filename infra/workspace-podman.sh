#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s create <ISSUE-ID> <workspace-path> <host-port> <password-file> | stop <ISSUE-ID> | status <ISSUE-ID>\n' "$0" >&2
  exit 2
}

command_name="${1:-}"
issue_id="${2:-}"
printf '%s' "$issue_id" | grep -Eq '^ISSUE-[0-9]{4,}$' || usage
name="issue-agent-workspace-$(printf '%s' "$issue_id" | tr '[:upper:]' '[:lower:]')"

case "$command_name" in
  create)
    workspace="${3:-}"
    port="${4:-}"
    password_file="${5:-}"
    [ -d "$workspace" ] || { printf 'Workspace not found: %s\n' "$workspace" >&2; exit 1; }
    printf '%s' "$port" | grep -Eq '^[0-9]+$' || usage
    [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || usage
    [ -f "$password_file" ] || { printf 'Password file not found: %s\n' "$password_file" >&2; exit 1; }

    secret="${name}-password"
    podman secret rm "$secret" >/dev/null 2>&1 || true
    podman secret create "$secret" "$password_file" >/dev/null
    podman run --detach --replace \
      --name "$name" \
      --label issue-agent.issue-id="$issue_id" \
      --userns=keep-id \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --read-only \
      --tmpfs /tmp:size=512m,mode=1777 \
      --tmpfs /home/coder/.cache:size=512m \
      --tmpfs /home/coder/.config:size=64m \
      --tmpfs /home/coder/.local/share/code-server:size=512m \
      --volume "$(realpath "$workspace"):/home/coder/project:Z" \
      --publish "127.0.0.1:${port}:8080" \
      --secret "$secret,type=env,target=PASSWORD" \
      "${CODE_SERVER_IMAGE:-ghcr.io/coder/code-server:4.99.4}" \
      --bind-addr 0.0.0.0:8080 --auth password --disable-telemetry /home/coder/project
    ;;
  stop)
    podman rm --force "$name"
    podman secret rm "${name}-password" >/dev/null 2>&1 || true
    ;;
  status)
    podman inspect "$name" --format '{{.State.Status}} {{range .NetworkSettings.Ports}}{{.}}{{end}}'
    ;;
  *) usage ;;
esac
