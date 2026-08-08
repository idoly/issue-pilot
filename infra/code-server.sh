#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
state_root="$root/.issue-pilot"
workspace_root="$state_root/workspaces"
repositories_root="$state_root/repositories"
data_root="$state_root/code-server/data"
password_file="$state_root/code-server/password"
name=code-server
image=ghcr.io/coder/code-server:4.131.0-39
runtime_version=keep-id-v17-code-server-4.131.0-host-development-runtime

require_host() {
  [ -x /usr/local/node/bin/node ] && [ -x /usr/local/node/bin/pi ] || { echo "Node/Pi runtime not found" >&2; exit 1; }
  [ -x /usr/local/java/bin/java ] || { echo "Java runtime not found" >&2; exit 1; }
  [ -x /usr/local/maven/bin/mvn ] || { echo "Maven runtime not found" >&2; exit 1; }
  [ -x /usr/bin/git ] && [ -d /usr/libexec/git-core ] && [ -d /usr/share/git-core ] || { echo "Git runtime not found" >&2; exit 1; }
  [ -f "$HOME/.m2/settings.xml" ] && [ -d "$HOME/.m2/repository" ] || { echo "Maven configuration not found" >&2; exit 1; }
  [ -f "$HOME/.npmrc" ] && [ -d "$HOME/.npm" ] || { echo "npm configuration not found" >&2; exit 1; }
  for file in auth.json models.json models-store.json settings.json; do
    [ -f "$HOME/.pi/agent/$file" ] || { echo "Pi configuration not found: $file" >&2; exit 1; }
  done
}

configure_editor() {
  settings_file="$data_root/User/settings.json"
  /usr/local/node/bin/node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    Object.assign(settings, {
      "security.workspace.trust.enabled": false,
      "git.path": "/opt/host/git/bin/git",
      "git.autoRepositoryDetection": "subFolders",
      "git.repositoryScanMaxDepth": 2,
      "java.jdt.ls.java.home": "/opt/host/java",
      "java.configuration.runtimes": [{ name: "JavaSE-25", path: "/opt/host/java", default: true }],
      "java.configuration.maven.userSettings": "/home/coder/.m2/settings.xml",
      "maven.settingsFile": "/home/coder/.m2/settings.xml",
      "maven.executable.path": "/opt/host/maven/bin/mvn",
      "npm.packageManager": "yarn",
    });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  ' "$settings_file"
}

ensure() {
  require_host
  mkdir -p "$workspace_root" "$repositories_root" "$data_root/User"
  chmod 0700 "$data_root" "$data_root/User" "$(dirname "$password_file")"
  configure_editor
  if [ ! -s "$password_file" ]; then
    umask 077
    head -c 32 /dev/urandom | base64 > "$password_file"
  fi
  chmod 0600 "$password_file"
  podman image exists "$image" || podman pull "$image" >/dev/null

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
    --workdir /home/coder/state/workspaces \
    --publish 127.0.0.1:18080:8080 \
    --env "PASSWORD=$password" \
    --env JAVA_HOME=/opt/host/java \
    --env PATH=/opt/host/git/bin:/opt/host/node/bin:/opt/host/java/bin:/opt/host/maven/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin \
    --env GIT_EXEC_PATH=/opt/host/git/libexec/git-core \
    --env GIT_TEMPLATE_DIR=/opt/host/git/share/git-core/templates \
    --env LD_LIBRARY_PATH=/opt/host/git/lib \
    --volume "$workspace_root:/home/coder/state/workspaces:Z" \
    --volume "$repositories_root:/home/coder/state/repositories:Z" \
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
    "$image" >/dev/null
}

case "${1:-}" in
  ensure) [ "$#" -eq 1 ] || exit 2; ensure ;;
  status) [ "$#" -eq 1 ] || exit 2; podman inspect "$name" ;;
  stop) [ "$#" -eq 1 ] || exit 2; podman stop "$name" >/dev/null ;;
  *) echo "Usage: $0 ensure|status|stop" >&2; exit 2 ;;
esac
