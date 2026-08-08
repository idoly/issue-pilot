#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cache_root=$(realpath -m "${PI_TOOL_CACHE_ROOT:-$root/.issue-pilot/tools}")
node_image=${PI_NODE_CLI_IMAGE:-docker.io/library/node:26.5.1-bookworm-slim}
maven_image=${PI_MAVEN_CLI_IMAGE:-docker.io/library/maven:3.9.16-eclipse-temurin-8}
playwright_image=${PI_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-noble}
base_images="$node_image $maven_image"
images="$base_images $playwright_image"

prepare() {
  mkdir -p "$cache_root/playwright"
  for image in $base_images; do podman image exists "$image" || podman pull "$image" >/dev/null; done

  test "$(node -p "require('$cache_root/playwright/node_modules/playwright-core/package.json').version" 2>/dev/null || true)" = 1.62.1 || \
    podman run --rm --user 0 --volume "$cache_root/playwright:/tool:Z" --entrypoint npm "$node_image" \
      install --prefix /tool --omit=dev --ignore-scripts playwright-core@1.62.1 >/dev/null

  podman image exists "$playwright_image" || podman pull "$playwright_image" >/dev/null
}

status() {
  for image in $images; do
    if podman image exists "$image"; then printf 'image ready %s\n' "$image"; else printf 'image missing %s\n' "$image"; fi
  done
  if test "$(node -p "require('$cache_root/playwright/node_modules/playwright-core/package.json').version" 2>/dev/null || true)" = 1.62.1; then
    printf 'tool ready playwright-core@1.62.1\n'
  else
    printf 'tool missing playwright-core@1.62.1\n'
  fi
  running=$(podman ps --filter label=io.issue-pilot.component=pi-tool --format '{{.Names}}')
  [ -z "$running" ] || { printf 'unexpected persistent tool containers:\n%s\n' "$running"; return 1; }
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; rm -rf "$cache_root" ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
