#!/usr/bin/env bash
# Cron-friendly health probe for a host-native Issue Pilot installation.
# It reads /health, free disk on the state filesystem, available memory, the number of log
# launches in the last 24 hours and the current log size. It prints exactly one line and exits
# non-zero when any threshold is breached. It never starts, stops, restarts or deletes anything.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host/health-probe.sh [options]

  --url <url>               Health base URL (default: read from the root configuration).
  --state-root <dir>        State directory for the disk check (default: root configuration).
  --min-free-mb <n>         Minimum free disk in MiB (default 2048 or $MIN_FREE_MB).
  --min-available-mb <n>    Minimum available memory in MiB (default 128 or $MIN_AVAILABLE_MB).
  --max-restarts-24h <n>    Maximum launch attempts in 24h, 0–999 (default 8 or $MAX_RESTARTS_24H).
  --max-log-mb <n>          Maximum current application log size in MiB (default 256 or $MAX_LOG_MB).
  --root <dir>              Application checkout (default: the repository containing this script).
  -h, --help                Show this help.

Node and Python default to /usr/local/node/bin/node and /usr/bin/python3; override with NODE and PYTHON.
EOF
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
url=
state_root=
min_free_mb=${MIN_FREE_MB:-2048}
min_available_mb=${MIN_AVAILABLE_MB:-128}
max_restarts=${MAX_RESTARTS_24H:-8}
max_log_mb=${MAX_LOG_MB:-256}
while (($#)); do
  case $1 in
    --url) url=${2:?}; shift 2 ;;
    --state-root) state_root=${2:?}; shift 2 ;;
    --min-free-mb) min_free_mb=${2:?}; shift 2 ;;
    --min-available-mb) min_available_mb=${2:?}; shift 2 ;;
    --max-restarts-24h) max_restarts=${2:?}; shift 2 ;;
    --max-log-mb) max_log_mb=${2:?}; shift 2 ;;
    --root) root=${2:?}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

node_bin=${NODE:-/usr/local/node/bin/node}
python_bin=${PYTHON:-/usr/bin/python3}
for value in "$min_free_mb" "$min_available_mb" "$max_restarts" "$max_log_mb"; do
  [[ $value =~ ^(0|[1-9][0-9]{0,8})$ ]] || { echo "Invalid non-negative integer threshold: $value" >&2; exit 2; }
done
((max_restarts < 1000)) || { echo "Restart threshold must be below 1000." >&2; exit 2; }
runner="$root/scripts/host/runner.py"
state_home=${XDG_STATE_HOME:-$HOME/.local/state}
control="$state_home/issue-pilot-host"

breach() {
  printf 'issue-pilot health=unknown status=breach failed=%s\n' "$1"
  exit 1
}

[[ -f $runner ]] || breach runner_missing

# The root configuration owns the listener and data location; no port is hard-coded here.
if ! config=$($python_bin "$runner" --root "$root" --node "$node_bin" config); then
  breach config_unreadable
fi
mapfile -t config_values < <($python_bin -c '
import json, sys
c = json.loads(sys.stdin.readline())
for key in ("baseUrl", "stateRoot", "launches24h"):
    print(c[key])
' <<<"$config")
((${#config_values[@]} == 3)) || breach config_malformed
url=${url:-${config_values[0]}}
state_root=${state_root:-${config_values[1]}}

health=ok
if ! body=$(curl -fsS --max-time 5 "$url/health" 2>/dev/null); then
  health=failed
elif ! $python_bin -c 'import json, sys; raise SystemExit(0 if json.load(sys.stdin) == {"ok": True} else 1)' <<<"$body" 2>/dev/null; then
  health=failed
fi

disk_free_mb=$(df -Pm "$state_root" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)
[[ $disk_free_mb =~ ^[0-9]+$ ]] || disk_free_mb=0

available_mb=$(LC_ALL=C free -m 2>/dev/null | awk '$1 == "Mem:" { print $7 }' || true)
[[ $available_mb =~ ^[0-9]+$ ]] || available_mb=0

restarts_24h=${config_values[2]}
[[ $restarts_24h =~ ^[0-9]+$ ]] || breach config_malformed

log_bytes=0
if [[ -f $control/application.log ]]; then
  log_bytes=$(stat -c %s "$control/application.log" 2>/dev/null || echo 0)
fi
[[ $log_bytes =~ ^[0-9]+$ ]] || log_bytes=0
log_mb=$(((log_bytes + 1048575) / 1048576))

failures=()
[[ $health == ok ]] || failures+=("health")
((disk_free_mb >= min_free_mb)) || failures+=("disk_free")
((available_mb >= min_available_mb)) || failures+=("memory_available")
((restarts_24h <= max_restarts)) || failures+=("restarts_24h")
((log_mb <= max_log_mb)) || failures+=("log_size")

if ((${#failures[@]})); then
  printf 'issue-pilot health=%s disk_free_mb=%s memory_available_mb=%s restarts_24h=%s log_mb=%s status=breach failed=%s\n' \
    "$health" "$disk_free_mb" "$available_mb" "$restarts_24h" "$log_mb" "${failures[*]}"
  exit 1
fi
printf 'issue-pilot health=%s disk_free_mb=%s memory_available_mb=%s restarts_24h=%s log_mb=%s status=ok\n' \
  "$health" "$disk_free_mb" "$available_mb" "$restarts_24h" "$log_mb"
