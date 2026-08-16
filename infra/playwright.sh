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
  playwright_timeout=$(configuration_value runtime.playwright.executionSeconds)
  playwright_pids=$(configuration_value runtime.playwright.containerPids)
  playwright_memory=$(configuration_value runtime.playwright.containerMemory)
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
  running=$(podman ps --filter label=io.issue-pilot.component=application-test --format '{{.Names}}')
  [ -z "$running" ] || { printf 'unexpected persistent application test containers:\n%s\n' "$running"; return 1; }
}

run_test() {
  require_tools
  script=$(realpath -e -- "$1")
  output=$(realpath -e -- "$2")
  [ -f "$script" ] || { printf 'Test script not found: %s\n' "$script" >&2; exit 1; }
  [ -d "$output" ] || { printf 'Output directory not found: %s\n' "$output" >&2; exit 1; }
  case "$script$output$playwright_core_root" in *:*|*'
'*) printf 'Invalid Playwright test path\n' >&2; exit 1 ;; esac
  container="issue-pilot-application-test-$$"
  cleanup_container() {
    podman rm --force "$container" >/dev/null 2>&1 || true
  }
  trap cleanup_container EXIT HUP INT TERM
  podman run --rm --pull never \
    --name "$container" --timeout "$playwright_timeout" \
    --label io.issue-pilot.component=application-test \
    --security-opt no-new-privileges --cap-drop ALL \
    --network host \
    --pids-limit "$playwright_pids" --memory "$playwright_memory" \
    --read-only --userns keep-id --user "$(id -u):$(id -g)" \
    --env HOME=/tmp/home \
    --volume "$script:/work/test.cjs:ro,Z" \
    --volume "$playwright_core_root:/tool/node_modules/playwright-core:ro,Z" \
    --volume "$output:/out:rw,z" \
    --tmpfs /tmp:rw,nosuid,nodev,size=512m \
    --workdir /work \
    "$playwright_image" node /work/test.cjs
  trap - EXIT HUP INT TERM
  cleanup_container
}

clean() {
  require_tools
  "$npm" uninstall --global playwright-core >/dev/null
}

case "${1:-}" in
  prepare) [ "$#" -eq 1 ] || exit 2; prepare ;;
  status) [ "$#" -eq 1 ] || exit 2; status ;;
  run) [ "$#" -eq 3 ] || exit 2; run_test "$2" "$3" ;;
  clean) [ "$#" -eq 1 ] || exit 2; clean ;;
  *) printf 'Usage: %s prepare|status|run <script> <output-directory>|clean\n' "$0" >&2; exit 2 ;;
esac
