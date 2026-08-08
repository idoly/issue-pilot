#!/bin/sh
set -eu

playwright_version=1.62.1
playwright_image=${PI_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-noble}
playwright_core_root=${PI_PLAYWRIGHT_CORE_ROOT:-/usr/local/node/lib/node_modules/playwright-core}

installed_version() {
  node -p "require('$playwright_core_root/package.json').version" 2>/dev/null || true
}

prepare() {
  if [ "$(installed_version)" != "$playwright_version" ]; then
    npm install --global --omit=dev "playwright-core@$playwright_version" >/dev/null
  fi
  podman image exists "$playwright_image" || podman pull "$playwright_image" >/dev/null
}

status() {
  if [ "$(installed_version)" = "$playwright_version" ]; then
    printf 'tool ready playwright-core@%s\n' "$playwright_version"
  else
    printf 'tool missing playwright-core@%s\n' "$playwright_version"
  fi
  if podman image exists "$playwright_image"; then
    printf 'image ready %s\n' "$playwright_image"
  else
    printf 'image missing %s\n' "$playwright_image"
  fi
  running=$(podman ps --filter label=io.issue-pilot.component=pi-tool --format '{{.Names}}')
  [ -z "$running" ] || { printf 'unexpected persistent tool containers:\n%s\n' "$running"; return 1; }
}

clean() {
  npm uninstall --global playwright-core >/dev/null
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
