#!/usr/bin/env bash
# Coordinated backend + Web release for an Issue Pilot checkout.
#
# Source, dependencies and root configuration must already be in place. Build the Web bundle in a
# separate worktree, never in this checkout. This script verifies the candidate revision, preflights
# migrations on a consistent database copy, stops the old process, checkpoints only when migrations
# will run, switches the Web generation, starts the new process, checks health and prunes old assets.
# It never builds, never force-kills, never resets Git and never writes to the application data root.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host/release.sh --build <web-dist> --revision <sha> [options]

  --build <dir>              Verified src/web/dist from an independent build worktree (required).
  --revision <sha>           Revision of this checkout; must equal git rev-parse HEAD (required).
  --previous-revision <sha>  Revision that was running before this release; used to explain or
                             perform a rollback after a failed start.
  --checkpoint <dir>         Existing private 0700 checkpoint parent; required when this release
                             will apply database migrations. A verified checkpoint is created there
                             after workers stop.
  --root <dir>               Application checkout (default: the repository containing this script).
  -h, --help                 Show this help.

Node and Python default to /usr/local/node/bin/node and /usr/bin/python3; override with NODE and
PYTHON. Port, data paths and the Web root are read from the checkout's root configuration.
EOF
}

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
build=
revision=
previous_revision=
checkpoint_root=
while (($#)); do
  case $1 in
    --build) build=${2:?--build needs a directory}; shift 2 ;;
    --revision) revision=${2:?--revision needs a revision}; shift 2 ;;
    --previous-revision) previous_revision=${2:?--previous-revision needs a revision}; shift 2 ;;
    --checkpoint) checkpoint_root=${2:?--checkpoint needs a directory}; shift 2 ;;
    --root) root=${2:?--root needs a directory}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ -z $build || -z $revision ]]; then
  echo "--build and --revision are required." >&2
  usage >&2
  exit 2
fi

node_bin=${NODE:-/usr/local/node/bin/node}
python_bin=${PYTHON:-/usr/bin/python3}
runner="$root/scripts/host/runner.py"
fail() { echo "$*" >&2; exit 1; }

success=0
work=
cleanup() {
  if [[ -n $work ]]; then
    if ((success)); then
      rm -rf "$work"
    else
      echo "Release evidence preserved at $work" >&2
    fi
  fi
}
trap cleanup EXIT

[[ -f $runner ]] || fail "Missing $runner; use the repository checkout as --root."
[[ -d $build ]] || fail "Build directory does not exist: $build"
build=$(cd "$build" && pwd -P)
[[ -f $build/index.html && -f $build/.vite/manifest.json && -d $build/assets ]] ||
  fail "Incomplete Web build: expected index.html, .vite/manifest.json and assets/ in $build"

# 1. Revision preflight: the candidate build may only be installed on the checkout it was built from.
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || fail "$root is not a Git checkout."
head=$(git -C "$root" rev-parse HEAD)
expected=$(git -C "$root" rev-parse --verify --end-of-options "$revision^{commit}") ||
  fail "Unknown revision: $revision"
[[ $head == "$expected" ]] || fail "Checkout HEAD is $head, not the requested revision $expected."
if [[ -n $(git -C "$root" status --porcelain) ]]; then
  fail "Checkout has uncommitted changes; commit or remove them before releasing."
fi
if [[ -n $previous_revision ]]; then
  previous=$(git -C "$root" rev-parse --verify --end-of-options "$previous_revision^{commit}") ||
    fail "Unknown --previous-revision: $previous_revision"
fi

# 2. Root configuration: no hard-coded port or data paths.
config=$($python_bin "$runner" --root "$root" --node "$node_bin" config)
mapfile -t config_values < <($python_bin -c '
import json, sys
c = json.loads(sys.stdin.readline())
for key in ("baseUrl", "webRoot", "stateRoot", "databaseFile"):
    print(c[key])
' <<<"$config")
((${#config_values[@]} == 4)) || fail "Cannot read the root configuration from $root."
base_url=${config_values[0]}
web_root=${config_values[1]}
state_root=${config_values[2]}
database_file=${config_values[3]}
[[ -f $web_root/index.html && -f $web_root/.vite/manifest.json ]] ||
  fail "The live Web generation is incomplete under $web_root; inspect it before releasing."
[[ -d $state_root && ! -L $state_root && -f $database_file && ! -L $database_file ]] ||
  fail "The configured state root or database is missing; refusing to stop the service."
[[ -d $root/node_modules ]] || fail "Production dependencies are missing under $root."

# 3. Build pairing helpers: prune must never see a page and manifest from different generations.
work=$(mktemp -d "${TMPDIR:-/tmp}/issue-pilot-release.XXXXXXXX")
cat >"$work/web-check.py" <<'PY'
import json
import pathlib
import re
import sys

hashed = re.compile(r"-(?=[a-z_-]*[A-Z0-9])[A-Za-z0-9_-]{8}\.[a-z0-9]+$")


def manifest_files(root, name):
    path = root / name
    try:
        manifest = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(f"Cannot read {name}: {error}")
    files = set()
    for chunk in manifest.values():
        for file in [chunk.get("file"), *(chunk.get("css") or []), *(chunk.get("assets") or [])]:
            if not file:
                continue
            if not re.fullmatch(r"assets/[^/]+", file):
                raise SystemExit(f"{name} contains an unexpected path: {file}")
            if not (root / file).is_file():
                raise SystemExit(f"{name} references a missing file: {file}")
            files.add(file)
    return files


def check(root, page_name, manifest_name):
    root = pathlib.Path(root)
    files = manifest_files(root, manifest_name)
    page = (root / page_name).read_text()
    for reference in re.findall(r'(?:src|href)="/(assets/[^"?#]+)"', page):
        if hashed.fullmatch(reference) and reference not in files:
            raise SystemExit(f"{page_name} references {reference}, which {manifest_name} does not list")


if len(sys.argv) != 4:
    raise SystemExit("usage: web-check.py <root> <page> <manifest>")
check(sys.argv[1], sys.argv[2], sys.argv[3])
PY
$python_bin "$work/web-check.py" "$build" index.html .vite/manifest.json ||
  fail "The candidate build is inconsistent; do not release it."

# 4. Migration preflight on a consistent copy of the live database.
preflight_state="$work/preflight-state"
mkdir -m 700 "$preflight_state"
preflight_database="$preflight_state/database.sqlite"
$python_bin - "$database_file" "$preflight_database" "$root/drizzle/meta/_journal.json" "$work/migrations.json" <<'PY'
import contextlib
import json
import pathlib
import sqlite3
import sys

source = pathlib.Path(sys.argv[1])
target = pathlib.Path(sys.argv[2])
journal = pathlib.Path(sys.argv[3])
output = pathlib.Path(sys.argv[4])
if not source.is_absolute() or not source.is_file() or source.is_symlink():
    raise SystemExit("database must be an existing regular file at an absolute path")
target.touch(mode=0o600, exist_ok=False)
with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as live:
    with contextlib.closing(sqlite3.connect(target)) as saved:
        live.backup(saved)
        if saved.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit("preflight database copy failed its integrity check")
        try:
            applied = saved.execute("SELECT max(created_at) FROM __drizzle_migrations").fetchone()[0] or 0
            count = saved.execute("SELECT count(*) FROM __drizzle_migrations").fetchone()[0]
        except sqlite3.OperationalError:
            applied, count = 0, 0
entries = json.loads(journal.read_text())["entries"]
pending = [entry["tag"] for entry in entries if entry["when"] > applied]
output.write_text(json.dumps({"applied": applied, "count": count, "journal": len(entries), "pending": pending}, indent=2) + "\n")
PY
pending_count=$($python_bin -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["pending"]))' "$work/migrations.json")
pending_tags=$($python_bin -c 'import json,sys; print(", ".join(json.load(open(sys.argv[1]))["pending"]) or "-")' "$work/migrations.json")
echo "Migrations pending: $pending_count (${pending_tags})"

if ((pending_count > 0)); then
  [[ -n $checkpoint_root ]] || fail "This release will apply migrations; pass --checkpoint <private 0700 directory>."
  [[ $checkpoint_root = /* && -d $checkpoint_root && ! -L $checkpoint_root ]] ||
    fail "Checkpoint parent must be an existing absolute, non-symlink directory."
  [[ $(stat -c %a "$checkpoint_root") == 700 ]] || fail "Checkpoint parent must be private mode 0700."
  # Prove the candidate migrations and their integrity checks on the copy before touching the service.
  if ! (
    cd "$root"
    env -i HOME="$HOME" PATH=/usr/bin:/bin NODE_ENV=production "$node_bin" --experimental-strip-types --input-type=module -e '
      import { migrateStateDatabase } from "./src/db/migrate.ts";
      await migrateStateDatabase(process.argv[1], process.argv[2]);
    ' "$preflight_state" "$preflight_database"
  ); then
    fail "Migration preflight failed on the database copy; the running service was not stopped."
  fi
  $python_bin - "$preflight_database" "$work/migrations.json" <<'PY'
import json
import sqlite3
import sys

database = sys.argv[1]
journal = sys.argv[2]
with sqlite3.connect(database) as saved:
    if saved.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise SystemExit("migrated preflight copy failed its integrity check")
    if saved.execute("PRAGMA foreign_key_check").fetchall():
        raise SystemExit("migrated preflight copy failed its foreign key check")
    rows, latest = saved.execute("SELECT count(*), max(created_at) FROM __drizzle_migrations").fetchone()
    state = json.loads(open(journal).read())
    if rows != state["journal"] or latest <= state["applied"]:
        raise SystemExit("preflight migrations did not apply the whole journal")
print("Migration preflight passed on the database copy.")
PY
fi

# 5. Stop the old process; the runner drains up to 1800 seconds and never force-kills.
$python_bin "$runner" --root "$root" --node "$node_bin" stop

# 6. Checkpoint only when this release will migrate, from the stopped consistent database.
checkpoint=
if ((pending_count > 0)); then
  checkpoint=$($python_bin - "$database_file" "$checkpoint_root" <<'PY'
import contextlib
import pathlib
import sqlite3
import sys
import tempfile

source = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
if not source.is_absolute() or not source.is_file() or source.is_symlink():
    raise SystemExit("database must be an existing regular file at an absolute path")
if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.stat().st_mode & 0o7777 != 0o700:
    raise SystemExit("checkpoint root must be an existing private 0700 directory")
checkpoint = pathlib.Path(tempfile.mkdtemp(prefix="db-checkpoint-", dir=root))
partial = checkpoint / "database.sqlite.partial"
partial.touch(mode=0o600, exist_ok=False)
with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as live:
    with contextlib.closing(sqlite3.connect(partial)) as saved:
        live.backup(saved)
        if saved.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise SystemExit("checkpoint integrity check failed; preserve partial for inspection")
        if saved.execute("PRAGMA foreign_key_check").fetchall():
            raise SystemExit("checkpoint foreign key check failed; preserve partial for inspection")
partial.rename(checkpoint / "database.sqlite")
print(checkpoint)
PY
)
  echo "Checkpoint: $checkpoint"
fi

# 7. Web generation switch. Rerunning with the same build must not rotate again.
if cmp -s "$build/index.html" "$web_root/index.html" && cmp -s "$build/.vite/manifest.json" "$web_root/.vite/manifest.json"; then
  echo "Web generation already matches the build; skipping rotation."
else
  $python_bin "$work/web-check.py" "$web_root" index.html .vite/manifest.json ||
    fail "The live page and manifest are inconsistent; refusing to rotate."
  cp -p "$web_root/index.html" "$web_root/index.previous.html"
  cp -p "$web_root/.vite/manifest.json" "$web_root/.vite/manifest.previous.json"
  mkdir -p "$web_root/assets"
  cp -rp "$build/assets/." "$web_root/assets/"
  cp -p "$build/.vite/manifest.json" "$web_root/.vite/manifest.json.tmp"
  mv -f "$web_root/.vite/manifest.json.tmp" "$web_root/.vite/manifest.json"
  cp -p "$build/index.html" "$web_root/index.html.tmp"
  mv -f "$web_root/index.html.tmp" "$web_root/index.html"
fi

# 8. Start and wait for health (the runner waits at most 600 seconds and returns on readiness).
if ! $python_bin "$runner" --root "$root" --node "$node_bin" start --revision "$head"; then
  migrated=0
  if ((pending_count > 0)); then
    # A failure before database open may still allow rollback. Refuse only when the journal advanced
    # or cannot be read; the checkpoint is the only recovery point after a migration.
    before_count=$($python_bin -c 'import json,sys; print(json.load(open(sys.argv[1]))["count"])' "$work/migrations.json")
    after_count=$($python_bin - "$database_file" <<'PY'
import sqlite3
import sys

try:
    with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=3) as saved:
        print(saved.execute("SELECT count(*) FROM __drizzle_migrations").fetchone()[0])
except Exception:
    raise SystemExit(1)
PY
) || after_count=""
    if [[ -z $after_count ]] || ((after_count != before_count)); then migrated=1; fi
  fi
  if ((migrated)); then
    cat >&2 <<EOF
Start failed after this release advanced the database journal; REFUSING automatic rollback.
New writes may already exist. Do not modify rows or rerun migrations.
1. Preserve the failed process, its log (application.log in the host state directory) and checkpoint $checkpoint.
2. Restore the checkpoint with the previous revision:
   see docs/ai/STORAGE.md#restoring-a-checkpoint.
3. Check the previous revision out explicitly, then run:
   $python_bin $runner --root $root --node $node_bin start --revision <previous-revision>
EOF
    exit 1
  fi
  echo "Start failed without migrations; rolling the Web generation back." >&2
  $python_bin "$runner" --root "$root" --node "$node_bin" stop || true
  if [[ -f $web_root/index.previous.html && -f $web_root/.vite/manifest.previous.json ]]; then
    cp -p "$web_root/.vite/manifest.previous.json" "$web_root/.vite/manifest.json.tmp"
    mv -f "$web_root/.vite/manifest.json.tmp" "$web_root/.vite/manifest.json"
    cp -p "$web_root/index.previous.html" "$web_root/index.html.tmp"
    mv -f "$web_root/index.html.tmp" "$web_root/index.html"
  else
    echo "No previous Web generation is available; keeping the current one." >&2
  fi
  if [[ -n $previous_revision ]] && [[ $(git -C "$root" rev-parse HEAD) != "$previous" ]]; then
    cat >&2 <<EOF
The Web generation rollback was attempted, but the checkout still points at the failed revision $(git -C "$root" rev-parse HEAD).
This script does not reset or rewrite your checkout. Check out $previous explicitly, then run:
  $python_bin $runner --root $root --node $node_bin start --revision $previous
EOF
    exit 1
  fi
  start_args=(start)
  if [[ -n $previous_revision ]]; then
    start_args+=(--revision "$previous")
  else
    echo "No --previous-revision was recorded; starting the current checkout after the Web rollback." >&2
  fi
  if ! $python_bin "$runner" --root "$root" --node "$node_bin" "${start_args[@]}"; then
    echo "The previous Web generation did not start either; preserve the log and inspect the checkout." >&2
  fi
  exit 1
fi

curl -fsS "$base_url/health" || fail "Health endpoint did not confirm the new process."
echo
$python_bin "$runner" --root "$root" --node "$node_bin" status

# 9. Prune bundles that neither generation references; never pipe output (EPIPE aborts deletion).
$node_bin --experimental-strip-types "$root/scripts/prune-web-assets.ts" "$web_root" >"$work/prune-dry-run.txt"
sed -n '1p' "$work/prune-dry-run.txt"
$node_bin --experimental-strip-types "$root/scripts/prune-web-assets.ts" "$web_root" --apply >"$work/prune-applied.txt"
sed -n '1p' "$work/prune-applied.txt"
$python_bin "$work/web-check.py" "$web_root" index.html .vite/manifest.json
$python_bin "$work/web-check.py" "$web_root" index.previous.html .vite/manifest.previous.json
echo "Both Web generations are intact; release complete at revision $head."
success=1
