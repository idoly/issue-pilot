#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cache_root=$(realpath -m "${PI_TOOL_CACHE_ROOT:-$root/.issue-pilot/tool-cache}")
node_image=${PI_NODE_CLI_IMAGE:-docker.io/library/node:26.5.1-bookworm-slim}
maven_image=${PI_MAVEN_CLI_IMAGE:-docker.io/library/maven:3.9.16-eclipse-temurin-8}
mysql_image=${PI_MYSQL_CLI_IMAGE:-docker.io/library/mysql:26.7.0}
redis_image=${PI_REDIS_CLI_IMAGE:-docker.io/library/redis:8.10.0-alpine}
nacos_image=${PI_NACOS_CLI_IMAGE:-docker.io/library/node:26.5.1-bookworm-slim}
images="$mysql_image $redis_image $node_image $maven_image"

prepare() {
  mkdir -p "$cache_root/node" "$cache_root/maven"
  for image in $images; do podman image exists "$image" || podman pull "$image" >/dev/null; done

  podman volume exists nacos-cli-data || podman volume create nacos-cli-data >/dev/null
  podman run --rm --user 0 --volume nacos-cli-data:/tool --entrypoint sh "$nacos_image" \
    -c 'test "$(node -p "require(\"/tool/node_modules/@nacos-group/cli/package.json\").version" 2>/dev/null)" = 1.1.4 || npm install --prefix /tool --omit=dev @nacos-group/cli@1.1.4'
}

status() {
  for image in $images; do
    if podman image exists "$image"; then printf 'image ready %s\n' "$image"; else printf 'image missing %s\n' "$image"; fi
  done
  for volume in nacos-cli-data; do
    if podman volume exists "$volume"; then printf 'volume ready %s\n' "$volume"; else printf 'volume missing %s\n' "$volume"; fi
  done
  running=$(podman ps --filter label=io.issue-pilot.component=pi-tool --format '{{.Names}}')
  [ -z "$running" ] || { printf 'unexpected persistent tool containers:\n%s\n' "$running"; return 1; }
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; podman volume rm nacos-cli-data >/dev/null 2>&1 || true; rm -rf "$cache_root" ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
