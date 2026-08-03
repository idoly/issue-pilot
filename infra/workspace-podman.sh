#!/bin/sh
set -eu

usage() {
  printf 'Usage: %s create <ISSUE-ID> <workspace-path> <host-port> <password-file> | stop <ISSUE-ID> | status <ISSUE-ID>\n' "$0" >&2
  exit 2
}

command_name="${1:-}"
issue_id="${2:-}"
printf '%s' "$issue_id" | grep -Eq '^ISSUE-([0-9]{4,}|[0-9]{8}-[0-9]{3,4})$' || usage
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
    workspace_entry="/home/coder/project"
    [ ! -f "$workspace/.issue-pilot.code-workspace" ] || workspace_entry="/home/coder/project/.issue-pilot.code-workspace"
    podman rm --force "$name" >/dev/null 2>&1 || true
    podman secret rm "$secret" >/dev/null 2>&1 || true
    podman secret create "$secret" "$password_file" >/dev/null
    workspace_real="$(realpath "$workspace")"
    state_root="$(dirname "$(dirname "$workspace_real")")"
    terminal_socket_dir="$state_root/run"
    bridge_socket="$terminal_socket_dir/code-terminal.sock"
    pty_socket="$terminal_socket_dir/pi-pty.sock"
    pi_launcher="$workspace_real/.issue-pilot/bin/pi"
    code_server_user="$workspace_real/.issue-pilot/code-server-user"
    [ -S "$bridge_socket" ] || { printf 'Pi terminal bridge not found: %s\n' "$bridge_socket" >&2; exit 1; }
    [ -S "$pty_socket" ] || { printf 'Pi PTY bridge not found: %s\n' "$pty_socket" >&2; exit 1; }
    [ -x "$pi_launcher" ] || { printf 'Pi terminal launcher not found: %s\n' "$pi_launcher" >&2; exit 1; }
    [ -f "$code_server_user/settings.json" ] && [ -f "$code_server_user/keybindings.json" ] || { printf 'code-server user configuration not found: %s\n' "$code_server_user" >&2; exit 1; }
    set -- podman run --detach --replace \
      --name "$name" \
      --label issue-agent.issue-id="$issue_id" \
      --userns=keep-id \
      --security-opt no-new-privileges \
      --cap-drop ALL \
      --read-only \
      --tmpfs /tmp:size=512m,mode=1777 \
      --tmpfs /home/coder/.cache:size=512m,mode=1777 \
      --tmpfs /home/coder/.config:size=64m,mode=1777 \
      --tmpfs /home/coder/.local/share/code-server:size=512m,mode=1777 \
      --volume "$workspace_real:/home/coder/project:Z" \
      --volume "$terminal_socket_dir:/run/issue-pilot:Z" \
      --volume "$pi_launcher:/usr/local/bin/pi:ro,Z" \
      --volume "$code_server_user:/home/coder/.local/share/code-server/User:Z" \
      --env "PATH=/home/coder/project/.issue-pilot/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games"
    for git_file in "$workspace_real"/*/.git; do
      [ -f "$git_file" ] || continue
      git_dir="$(sed -n 's/^gitdir: //p' "$git_file")"
      case "$git_dir" in
        "$state_root"/repositories/*/.git/worktrees/*)
          cache_path="${git_dir%%/.git/worktrees/*}"
          [ -d "$cache_path" ] || { printf 'Git cache not found: %s\n' "$cache_path" >&2; exit 1; }
          set -- "$@" --volume "$cache_path:$cache_path:Z"
          ;;
        *) printf 'Unmanaged Git worktree path: %s\n' "$git_dir" >&2; exit 1 ;;
      esac
    done
    set -- "$@" \
      --publish "127.0.0.1:${port}:8080" \
      --secret "$secret,type=env,target=PASSWORD" \
      "${CODE_SERVER_IMAGE:-ghcr.io/coder/code-server:4.99.4}" \
      --bind-addr 0.0.0.0:8080 --auth password --disable-telemetry --disable-workspace-trust "$workspace_entry"
    "$@"
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
