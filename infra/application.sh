#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
node=/usr/local/node/bin/node
config_reader="$root/infra/config-value.mjs"
compose_generator="$root/infra/application-compose.mjs"
containerfile="$root/infra/images/application/Containerfile"
compose_manifest=

cleanup() {
  [ -z "$compose_manifest" ] || rm -f "$compose_manifest"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

configuration_value() {
  "$node" --experimental-strip-types "$config_reader" "$1"
}

safe_path() {
  case "$1" in
    /*) ;;
    *) fail "Path must be absolute: $1" ;;
  esac
  case "$1" in *:*|*'
'*) fail "Invalid container path: $1" ;; esac
}

load_configuration() {
  [ -x "$node" ] || fail "Executable not found: $node"
  [ -f "$config_reader" ] || fail "File not found: $config_reader"
  [ -f "$compose_generator" ] || fail "File not found: $compose_generator"
  [ -f "$containerfile" ] || fail "File not found: $containerfile"
  command -v podman >/dev/null 2>&1 || fail "Executable not found: podman"
  podman compose version >/dev/null 2>&1 || fail "Podman Compose provider not found"
  name=$(configuration_value runtime.application.name)
  image=$(configuration_value runtime.application.image)
  stop_timeout=$(configuration_value runtime.application.stopTimeoutSeconds)
  configured_uid=$(configuration_value runtime.containerUser.uid)
  configured_gid=$(configuration_value runtime.containerUser.gid)
  state_directory=$(configuration_value state.directory)
  npm_config="$HOME/$(configuration_value runtime.projectTools.node.npmConfig)"
  npm_cache="$HOME/$(configuration_value runtime.projectTools.node.npmCache)"
  maven_settings="$HOME/$(configuration_value runtime.projectTools.maven.settings)"
  maven_repository="$HOME/$(configuration_value runtime.projectTools.maven.repository)"
  pi_root="$HOME/.pi/agent"
  case "$state_directory" in /*) state_root=$state_directory ;; *) state_root="$root/$state_directory" ;; esac
  [ "$(id -u)" = "$configured_uid" ] || fail "Runtime UID mismatch: expected $configured_uid"
  [ "$(id -g)" = "$configured_gid" ] || fail "Runtime GID mismatch: expected $configured_gid"
  for candidate in "$root" "$state_root" "$HOME" "$npm_config" "$npm_cache" "$maven_settings" "$maven_repository" "$pi_root"; do safe_path "$candidate"; done
}

ensure_compose_file() {
  if [ -z "$compose_manifest" ]; then
    compose_manifest=$(mktemp "/tmp/issue-pilot-compose.XXXXXX.json")
    "$node" --experimental-strip-types "$compose_generator" > "$compose_manifest"
  fi
}

compose() {
  ensure_compose_file
  podman compose --in-pod false --no-ansi --project-name "$name" --file "$compose_manifest" "$@"
}

image_root() {
  podman image inspect "$image" --format '{{ index .Config.Labels "io.issue-pilot.root" }}'
}

image_healthcheck() {
  podman image inspect "$image" --format '{{if .Config.Healthcheck}}configured{{else}}missing{{end}}'
}

require_image() {
  podman image exists "$image" || fail "Application image not found: $image"
  actual_root=$(image_root)
  [ "$actual_root" = "$root" ] || fail "Application image root mismatch: expected $root, got $actual_root"
  [ "$(image_healthcheck)" = configured ] || fail "Application image healthcheck missing: $image"
}

prepare() {
  load_configuration
  compose --podman-build-args=--format=docker build --pull=always application
  require_image
}

prepare_kubernetes() {
  target_image=$1
  case "$target_image" in ""|-*|*' '*|*'
'*) fail "Invalid image reference: $target_image" ;; esac
  load_configuration
  case $("$node" -p 'process.arch') in
    x64) architecture=amd64 ;;
    arm64) architecture=arm64 ;;
    *) fail "Unsupported architecture" ;;
  esac
  podman build --pull=always --format=docker --file "$containerfile" --tag "$target_image" \
    --build-arg APP_ROOT=/opt/issue-pilot \
    --build-arg "TARGETARCH=$architecture" \
    "$root"
  [ "$(podman image inspect "$target_image" --format '{{ index .Config.Labels "io.issue-pilot.root" }}')" = /opt/issue-pilot ] || fail "Portable application image root mismatch"
  [ "$(podman image inspect "$target_image" --format '{{if .Config.Healthcheck}}configured{{else}}missing{{end}}')" = configured ] || fail "Portable application image healthcheck missing"
}

config() {
  load_configuration
  compose config
}

status() {
  load_configuration
  require_image
  if podman container exists "$name"; then
    running=$(podman container inspect "$name" --format '{{.State.Running}}')
    health=$(podman container inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
    printf 'container %s running=%s health=%s\n' "$name" "$running" "$health"
  else
    printf 'container %s absent\n' "$name"
  fi
  printf 'image ready %s root=%s\n' "$image" "$root"
}

start() {
  load_configuration
  require_image
  podman container exists "$name" && fail "Application container already exists: $name"
  [ -d "$state_root" ] || fail "State root not found: $state_root"
  [ -d "$pi_root" ] || fail "Pi configuration not found: $pi_root"
  [ -f "$npm_config" ] || fail "npm configuration not found: $npm_config"
  [ -d "$npm_cache" ] || fail "npm cache not found: $npm_cache"
  [ -f "$maven_settings" ] || fail "Maven settings not found: $maven_settings"
  [ -d "$maven_repository" ] || fail "Maven repository not found: $maven_repository"

  compose up --detach --no-build application
}

stop() {
  load_configuration
  podman container exists "$name" || return 0
  compose stop --timeout "$stop_timeout" application
}

remove() {
  load_configuration
  podman container exists "$name" || return 0
  running=$(podman container inspect "$name" --format '{{.State.Running}}')
  [ "$running" = false ] || fail "Application container is running: $name"
  compose down
}

logs() {
  load_configuration
  podman container exists "$name" || fail "Application container not found: $name"
  compose logs --tail 200 application
}

clean() {
  load_configuration
  podman container exists "$name" && fail "Application container still exists: $name"
  podman image exists "$image" || return 0
  podman image rm "$image"
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  prepare-kubernetes) [ "$#" -eq 2 ] || exit 2; prepare_kubernetes "$2" ;;
  config) [ "$#" -eq 1 ] || exit 2; config ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  start) [ "$#" -eq 1 ] || exit 2; start ;;
  stop) [ "$#" -eq 1 ] || exit 2; stop ;;
  remove) [ "$#" -eq 1 ] || exit 2; remove ;;
  logs) [ "$#" -eq 1 ] || exit 2; logs ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|prepare-kubernetes <image>|config|status|start|stop|remove|logs|clean\n' "$0" >&2; exit 2 ;;
esac
