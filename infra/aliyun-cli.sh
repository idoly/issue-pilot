#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
node=/usr/local/node/bin/node
config_reader="$root/infra/config-value.mjs"
dockerfile="$root/infra/images/aliyun-cli/Dockerfile"
context=$(dirname "$dockerfile")

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

configuration_value() {
  "$node" --experimental-strip-types "$config_reader" "$1"
}

load_configuration() {
  [ -x "$node" ] || fail "Executable not found: $node"
  [ -f "$config_reader" ] || fail "File not found: $config_reader"
  [ -f "$dockerfile" ] || fail "File not found: $dockerfile"
  command -v podman >/dev/null 2>&1 || fail "Executable not found: podman"
  image=$(configuration_value runtime.aliyunCli.image)
  version=$(configuration_value runtime.aliyunCli.version)
  case "$(uname -m)" in
    x86_64) architecture=amd64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac
}

prepare() {
  load_configuration
  podman build --pull=always --tag "$image" \
    --build-arg "TARGETARCH=$architecture" \
    --build-arg "ALIYUN_CLI_VERSION=$version" \
    --file "$dockerfile" "$context"
}

status() {
  load_configuration
  podman image exists "$image" || fail "Image not found: $image"
  actual=$(podman run --rm --read-only --security-opt no-new-privileges --cap-drop ALL "$image" version)
  [ "$actual" = "$version" ] || fail "Aliyun CLI version mismatch: expected $version, got $actual"
  running=$(podman ps --filter label=io.issue-pilot.component=pi-tool --format '{{.Names}}')
  [ -z "$running" ] || fail "Unexpected persistent tool containers: $running"
  printf 'image ready %s aliyun-cli@%s\n' "$image" "$actual"
}

clean() {
  load_configuration
  podman image exists "$image" || return 0
  podman image rm "$image"
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
