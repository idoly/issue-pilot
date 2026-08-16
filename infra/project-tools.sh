#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
node=/usr/local/node/bin/node
config_reader="$root/infra/config-value.mjs"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

configuration_value() {
  "$node" --experimental-strip-types "$config_reader" "$1"
}

home_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    ../*|*/../*|*/..) fail "Invalid project tool path: $1" ;;
    *) printf '%s/%s\n' "$HOME" "$1" ;;
  esac
}

load_configuration() {
  [ -x "$node" ] || fail "Executable not found: $node"
  [ -f "$config_reader" ] || fail "File not found: $config_reader"
  command -v podman >/dev/null 2>&1 || fail "Executable not found: podman"
  node_image=$(configuration_value runtime.projectTools.node.image)
  maven_image=$(configuration_value runtime.projectTools.maven.image)
  npm_config=$(home_path "$(configuration_value runtime.projectTools.node.npmConfig)")
  npm_cache=$(home_path "$(configuration_value runtime.projectTools.node.npmCache)")
  maven_settings=$(home_path "$(configuration_value runtime.projectTools.maven.settings)")
  maven_repository=$(home_path "$(configuration_value runtime.projectTools.maven.repository)")
  [ -f "$npm_config" ] || fail "File not found: $npm_config"
  [ -d "$npm_cache" ] || fail "Directory not found: $npm_cache"
  [ -f "$maven_settings" ] || fail "File not found: $maven_settings"
  [ -d "$maven_repository" ] || fail "Directory not found: $maven_repository"
}

prepare() {
  load_configuration
  podman pull "$node_image" >/dev/null
  podman pull "$maven_image" >/dev/null
}

status() {
  load_configuration
  podman image exists "$node_image" || fail "Image not found: $node_image"
  podman image exists "$maven_image" || fail "Image not found: $maven_image"
  node_version=$(podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL "$node_image" node --version)
  maven_version=$(podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL --env HOME=/tmp/home --env MAVEN_CONFIG=/tmp/home/.m2 --tmpfs /tmp:rw,nosuid,nodev,size=64m "$maven_image" mvn --version | sed -n '1p')
  running=$(podman ps --filter label=io.issue-pilot.component=pi-tool --format '{{.Names}}')
  [ -z "$running" ] || fail "Unexpected persistent tool containers: $running"
  printf 'image ready %s %s\n' "$node_image" "$node_version"
  printf 'image ready %s %s\n' "$maven_image" "$maven_version"
}

clean() {
  load_configuration
  podman image exists "$node_image" && podman image rm "$node_image" || true
  podman image exists "$maven_image" && podman image rm "$maven_image" || true
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
