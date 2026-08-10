#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
state_root="$root/.issue-pilot"
workspace_root="$state_root/workspaces"
git_root="$state_root/git"
repositories_root="$git_root/repositories"
issues_root="$state_root/issues"
checkouts_root="$git_root/checkouts"
code_server_root="$state_root/code-server"
data_root="$code_server_root/data"
legacy_password_file="$code_server_root/password"
container_env_file="$code_server_root/container.env"
name=code-server
image=ghcr.io/coder/code-server:4.131.0-39
runtime_version=keep-id-v23-code-server-4.131.0-consolidated-git-auth-none

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_executable() {
  [ -x "$1" ] || fail "Executable not found: $1"
}

require_file() {
  [ -f "$1" ] || fail "File not found: $1"
}

require_directory() {
  [ -d "$1" ] || fail "Directory not found: $1"
}

require_host() {
  require_executable /usr/local/node/bin/node
  require_executable /usr/local/node/bin/npm
  require_executable /usr/local/node/bin/corepack
  require_executable /usr/local/node/bin/pi
  require_executable /usr/local/java/bin/java
  require_executable /usr/local/maven/bin/mvn
  require_executable /usr/bin/git
  require_directory /usr/libexec/git-core
  require_directory /usr/share/git-core
  require_file /lib64/libpcre2-8.so.0
  require_file /lib64/libz.so.1
  require_file "$HOME/.m2/settings.xml"
  require_directory "$HOME/.m2/repository"
  require_file "$HOME/.npmrc"
  require_directory "$HOME/.npm"
  for file in auth.json models.json models-store.json settings.json; do
    require_file "$HOME/.pi/agent/$file"
  done
  require_executable "$HOME/.pi/agent/bin/rg"
  require_executable "$HOME/.pi/agent/bin/fd"
}

configure_editor() {
  settings_file="$data_root/User/settings.json"
  /usr/local/node/bin/node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    delete settings["npm.packageManager"];
    Object.assign(settings, {
      "security.workspace.trust.enabled": false,
      "git.path": "/opt/host/git/bin/git",
      "git.autoRepositoryDetection": "subFolders",
      "git.repositoryScanMaxDepth": 2,
      "java.jdt.ls.java.home": "/opt/host/java",
      "java.configuration.runtimes": [{ name: "JavaSE-25", path: "/opt/host/java", default: true }],
      "java.configuration.maven.userSettings": "/home/coder/.m2/settings.xml",
      "maven.settingsFile": "/home/coder/.m2/settings.xml",
      "maven.executable.path": "/opt/host/maven/bin/mvn"
    });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  ' "$settings_file"
}

write_container_environment() {
  umask 077
  {
    printf '%s\n' 'JAVA_HOME=/opt/host/java'
    printf '%s\n' 'PATH=/home/coder/.pi/agent/bin:/opt/host/git/bin:/opt/host/node/bin:/opt/host/java/bin:/opt/host/maven/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin'
    printf '%s\n' 'GIT_EXEC_PATH=/opt/host/git/libexec/git-core'
    printf '%s\n' 'GIT_TEMPLATE_DIR=/opt/host/git/share/git-core/templates'
    printf '%s\n' 'LD_LIBRARY_PATH=/opt/host/git/lib'
  } > "$container_env_file"
  chmod 0600 "$container_env_file"
}

migrate_legacy_pi() {
  legacy_pi="$code_server_root/pi"
  [ -e "$legacy_pi" ] || return 0
  require_directory "$legacy_pi"
  for entry in "$legacy_pi"/*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in auth.json|models.json|models-store.json|settings.json|bin|sessions|themes) ;; *) fail "Unexpected legacy code-server Pi entry: $entry" ;; esac
  done
  if [ -d "$legacy_pi/sessions" ]; then
    if find "$legacy_pi/sessions" ! -type d ! -type f | grep -q .; then fail "Unexpected legacy code-server Pi session entry"; fi
    find "$legacy_pi/sessions" -type f | while IFS= read -r source; do
      case "$source" in *.jsonl) ;; *) fail "Unexpected legacy code-server Pi session file: $source" ;; esac
      relative=${source#"$legacy_pi/sessions/"}
      destination="$HOME/.pi/agent/sessions/$relative"
      mkdir -p "$(dirname "$destination")"
      chmod 0700 "$(dirname "$destination")"
      if [ -e "$destination" ]; then
        cmp -s "$source" "$destination" || fail "Legacy code-server Pi session conflict: $relative"
      else
        cp "$source" "$destination"
      fi
      chmod 0600 "$destination"
    done
  fi
  if [ -d "$legacy_pi/themes" ]; then
    if find "$legacy_pi/themes" ! -type d ! -type f | grep -q .; then fail "Unexpected legacy code-server Pi theme entry"; fi
    find "$legacy_pi/themes" -type f | while IFS= read -r source; do
      relative=${source#"$legacy_pi/themes/"}
      destination="$HOME/.pi/agent/themes/$relative"
      mkdir -p "$(dirname "$destination")"
      if [ -e "$destination" ]; then
        cmp -s "$source" "$destination" || fail "Legacy code-server Pi theme conflict: $relative"
      else
        cp "$source" "$destination"
      fi
    done
  fi
  if [ -d "$legacy_pi/bin" ]; then
    bin_entries=$(find "$legacy_pi/bin" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
    [ "$bin_entries" = "fd
rg" ] || fail "Unexpected legacy code-server Pi bin entry"
    cmp -s "$legacy_pi/bin/rg" "$HOME/.pi/agent/bin/rg" || fail "Legacy code-server rg differs from host"
    cmp -s "$legacy_pi/bin/fd" "$HOME/.pi/agent/bin/fd" || fail "Legacy code-server fd differs from host"
  fi
  rm -rf "$legacy_pi"
}

ensure() {
  require_host
  migrate_legacy_pi
  mkdir -p "$workspace_root" "$repositories_root" "$issues_root" "$checkouts_root" "$data_root/User"
  chmod 0700 "$code_server_root" "$data_root" "$data_root/User"
  configure_editor
  rm -f "$legacy_password_file"
  write_container_environment
  podman image exists "$image" || podman pull "$image" >/dev/null

  if podman inspect "$name" >/dev/null 2>&1; then
    current_version=$(podman inspect --format '{{index .Config.Labels "io.issue-pilot.code-server-runtime"}}' "$name")
    if [ "$current_version" = "$runtime_version" ]; then
      podman start "$name" >/dev/null
      return
    fi
    podman rm --force "$name" >/dev/null
  fi

  podman run --detach --name "$name" --replace \
    --label io.issue-pilot.component=code-server \
    --label "io.issue-pilot.code-server-runtime=$runtime_version" \
    --security-opt no-new-privileges --cap-drop ALL --userns=keep-id \
    --workdir /home/coder/state/workspaces \
    --publish 127.0.0.1:18080:8080 \
    --env-file "$container_env_file" \
    --volume "$workspace_root:/home/coder/state/workspaces:Z" \
    --volume "$repositories_root:/home/coder/state/git/repositories:Z" \
    --volume "$issues_root:/home/coder/state/issues:ro" \
    --volume "$checkouts_root:/home/coder/state/git/checkouts:ro" \
    --volume "$data_root:/home/coder/.local/share/code-server:Z" \
    --volume /usr/local/node:/opt/host/node:ro \
    --volume /usr/local/java:/opt/host/java:ro \
    --volume /usr/local/maven:/opt/host/maven:ro \
    --volume "$HOME/.m2:/home/coder/.m2" \
    --volume "$HOME/.npm:/home/coder/.npm" \
    --volume "$HOME/.npmrc:/home/coder/.npmrc:ro" \
    --volume "$HOME/.pi/agent:/home/coder/.pi/agent" \
    --volume /usr/bin/git:/opt/host/git/bin/git:ro \
    --volume /usr/libexec/git-core:/opt/host/git/libexec/git-core:ro \
    --volume /usr/share/git-core:/opt/host/git/share/git-core:ro \
    --volume /lib64/libpcre2-8.so.0:/opt/host/git/lib/libpcre2-8.so.0:ro \
    --volume /lib64/libz.so.1:/opt/host/git/lib/libz.so.1:ro \
    "$image" --auth none >/dev/null
}

status() {
  podman inspect --format 'status={{.State.Status}} image={{.Config.Image}} runtime={{index .Config.Labels "io.issue-pilot.code-server-runtime"}}' "$name"
}

stop() {
  if podman inspect "$name" >/dev/null 2>&1; then
    podman stop "$name" >/dev/null
  fi
}

case "${1:-}" in
  ensure) [ "$#" -eq 1 ] || exit 2; ensure ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  stop) [ "$#" -eq 1 ] || exit 2; stop ;;
  *) printf 'Usage: %s ensure|status|stop\n' "$0" >&2; exit 2 ;;
esac
