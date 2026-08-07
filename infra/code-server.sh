#!/bin/sh
set -eu

state_root=$(realpath -m "${ISSUE_PILOT_STATE_ROOT:-.issue-pilot}")
workspace_root=$(realpath -m "${ISSUE_PILOT_WORKSPACE_ROOT:-$state_root/workspaces}")
repositories_root=$(realpath -m "${ISSUE_PILOT_REPOSITORIES_ROOT:-$state_root/repositories}")
data_root=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_DATA:-$state_root/code-server/data}")
pi_data_root=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_PI_DATA:-$state_root/code-server/pi}")
node_runtime=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_NODE_RUNTIME:-/usr/local/node}")
git_binary=$(realpath -e "${ISSUE_PILOT_CODE_SERVER_GIT_BINARY:-/usr/bin/git}")
git_exec_path=$(realpath -e "${ISSUE_PILOT_CODE_SERVER_GIT_EXEC_PATH:-/usr/libexec/git-core}")
git_share_path=$(realpath -e "${ISSUE_PILOT_CODE_SERVER_GIT_SHARE_PATH:-/usr/share/git-core}")
git_pcre=$(realpath -e "${ISSUE_PILOT_CODE_SERVER_GIT_PCRE:-/lib64/libpcre2-8.so.0}")
git_zlib=$(realpath -e "${ISSUE_PILOT_CODE_SERVER_GIT_ZLIB:-/lib64/libz.so.1}")
password_file=$(realpath -m "${ISSUE_PILOT_CODE_SERVER_PASSWORD_FILE:-$state_root/code-server/password}")
image=${ISSUE_PILOT_CODE_SERVER_IMAGE:-ghcr.io/coder/code-server:4.131.0-39}
port=${ISSUE_PILOT_CODE_SERVER_PORT:-18080}
name=code-server
runtime_version=keep-id-v10-code-server-4.131.0-mounted-pi-0.84.0-trusted-workspaces

status() {
  podman inspect "$name"
}

ensure() {
  mkdir -p "$workspace_root" "$repositories_root" "$data_root/User" "$pi_data_root"
  chmod 0700 "$data_root" "$data_root/User" "$pi_data_root" "$(dirname "$password_file")"
  [ -x "$node_runtime/bin/node" ] && [ -x "$node_runtime/bin/pi" ] || { printf 'Node/Pi runtime not found at %s\n' "$node_runtime" >&2; return 1; }
  settings_file="$data_root/User/settings.json"
  "$node_runtime/bin/node" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    Object.assign(settings, { "security.workspace.trust.enabled": false, "git.path": "/opt/git/bin/git", "git.autoRepositoryDetection": "subFolders", "git.repositoryScanMaxDepth": 2 });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  ' "$settings_file"
  [ -x "$git_binary" ] && [ -d "$git_exec_path" ] && [ -d "$git_share_path" ] || { printf 'Git runtime is incomplete\n' >&2; return 1; }
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
    --env "PATH=/opt/git/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    --env "GIT_EXEC_PATH=/opt/git/libexec/git-core" \
    --env "GIT_TEMPLATE_DIR=/opt/git/share/git-core/templates" \
    --env "LD_LIBRARY_PATH=/opt/git/lib" \
    --volume "$workspace_root:/home/coder/state/workspaces:Z" \
    --volume "$repositories_root:/home/coder/state/repositories:Z" \
    --volume "$data_root:/home/coder/.local/share/code-server:Z" \
    --volume "$pi_data_root:/home/coder/.pi/agent:Z" \
    --volume "$node_runtime:/opt/node:ro" \
    --volume "$git_binary:/opt/git/bin/git:ro" \
    --volume "$git_exec_path:/opt/git/libexec/git-core:ro" \
    --volume "$git_share_path:/opt/git/share/git-core:ro" \
    --volume "$git_pcre:/opt/git/lib/libpcre2-8.so.0:ro" \
    --volume "$git_zlib:/opt/git/lib/libz.so.1:ro" \
    "$image" --bind-addr 0.0.0.0:8080 /home/coder/state/workspaces >/dev/null
}

case "${1:-}" in
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  ensure) [ "$#" -eq 1 ] || exit 2; ensure ;;
  stop) [ "$#" -eq 1 ] || exit 2; podman stop "$name" >/dev/null ;;
  *) printf 'Usage: %s status|ensure|stop\n' "$0" >&2; exit 2 ;;
esac
