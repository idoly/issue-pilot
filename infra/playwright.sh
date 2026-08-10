#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
node=/usr/local/node/bin/node
npm=/usr/local/node/bin/npm
config_reader="$root/infra/config-value.mjs"

configuration_value() {
  "$node" --experimental-strip-types "$config_reader" "$1"
}

require_tools() {
  [ -x "$node" ] || { printf 'Executable not found: %s\n' "$node" >&2; exit 1; }
  [ -x "$npm" ] || { printf 'Executable not found: %s\n' "$npm" >&2; exit 1; }
  [ -f "$config_reader" ] || { printf 'File not found: %s\n' "$config_reader" >&2; exit 1; }
  command -v podman >/dev/null 2>&1 || { printf 'Executable not found: podman\n' >&2; exit 1; }
  playwright_version=$(configuration_value runtime.playwright.version)
  playwright_core_root=$(configuration_value runtime.playwright.playwrightCoreRoot)
  playwright_image=$(configuration_value runtime.playwright.image)
}

installed_version() {
  "$node" -p "require('$playwright_core_root/package.json').version" 2>/dev/null || true
}

prepare() {
  require_tools
  if [ "$(installed_version)" != "$playwright_version" ]; then
    "$npm" install --global --omit=dev "playwright-core@$playwright_version" >/dev/null
  fi
  podman image exists "$playwright_image" || podman pull "$playwright_image" >/dev/null
}

status() {
  require_tools
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
  require_tools
  "$npm" uninstall --global playwright-core >/dev/null
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|status|clean\n' "$0" >&2; exit 2 ;;
esac
