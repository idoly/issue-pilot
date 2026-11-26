#!/usr/bin/env bash
# Coordinated backend + Web release for an Issue Pilot checkout.
#
# Validate an independent candidate, stop the old process, then fast-forward the live checkout and
# publish the verified Web generation. Reuse matching dependencies. Never force-kill or reset Git.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/host/release.sh --root <live-checkout> --candidate <verified-checkout> --revision <sha> [options]

  --candidate <dir>          Independent checkout with verified dependencies and Web build.
  --revision <sha>           Expected HEAD of the candidate checkout.
  --checkpoint <dir>         Existing private 0700 checkpoint parent; required when this release
                             will apply database migrations. A verified checkpoint is created there
                             after workers stop.
  --root <dir>               Live application checkout. Its current HEAD is the previous revision.
  -h, --help                 Show this help.

Node and Python default to /usr/local/node/bin/node and /usr/bin/python3; override with NODE and
PYTHON. Port, data paths and the Web root are read from the checkout's root configuration.
EOF
}

root=
candidate=
revision=
checkpoint_root=
while (($#)); do
  case $1 in
    --candidate) candidate=${2:?--candidate needs a directory}; shift 2 ;;
    --revision) revision=${2:?--revision needs a revision}; shift 2 ;;
    --checkpoint) checkpoint_root=${2:?--checkpoint needs a directory}; shift 2 ;;
    --root) root=${2:?--root needs a directory}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
if [[ -z $root || -z $candidate || -z $revision ]]; then
  echo "--root, --candidate and --revision are required." >&2
  usage >&2
  exit 2
fi

node_bin=${NODE:-/usr/local/node/bin/node}
python_bin=${PYTHON:-/usr/bin/python3}
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

root=$(cd "$root" && pwd -P)
candidate=$(cd "$candidate" && pwd -P)
[[ $root != "$candidate" && $candidate != "$root/"* && $root != "$candidate/"* ]] ||
  fail "Use a separate checkout outside the live application directory."
# The live checkout's runner verifies the old argv until the fast-forward; afterwards it owns the new argv.
runner="$root/scripts/host/runner.py"
web_check="$candidate/scripts/prune-web-assets.ts"
[[ -f $runner && -f $candidate/scripts/host/runner.py && -f $web_check ]] || fail "Missing live runner or candidate release tools."

# Verify both checkouts without changing files the running process may still load.
previous=$(git -C "$root" rev-parse HEAD)
head=$(git -C "$candidate" rev-parse HEAD)
expected=$(git -C "$candidate" rev-parse --verify --end-of-options "$revision^{commit}") ||
  fail "Unknown candidate revision: $revision"
[[ $head == "$expected" ]] || fail "Candidate HEAD is $head, not $expected."
for checkout in "$root" "$candidate"; do
  status=$(git -C "$checkout" status --porcelain)
  [[ -z $status ]] || fail "Checkout has uncommitted changes: $checkout"
done
git -C "$root" merge-base --is-ancestor "$previous" "$head" ||
  fail "Candidate must be available in the live repository and fast-forward its HEAD."
# A dependency change needs a separately prepared coordinated install, not a live npm install.
git -C "$root" diff --quiet "$previous" "$head" -- package.json package-lock.json patches/ scripts/apply-pi-sdk-patch.mjs ||
  fail "Install inputs changed; prepare a coordinated dependency release before stopping the service."
[[ -d $root/node_modules && -d $candidate/node_modules ]] || fail "The live checkout or candidate lacks dependencies."
(
  cd "$candidate"
  "$node_bin" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    import { verifyRuntimeDependencyPatches } from "./src/http/dependency-patches.ts";
    await verifyRuntimeDependencyPatches(pathToFileURL(process.argv[1] + "/"));
  ' "$root"
) || fail "The installed live dependencies failed patch verification."

# Config paths are checkout-relative unless explicitly absolute. This path does not move live state or ports.
config=$("$python_bin" "$runner" --root "$root" --node "$node_bin" config)
candidate_config=$("$python_bin" "$candidate/scripts/host/runner.py" --root "$candidate" --node "$node_bin" config)
mapfile -t config_values < <("$python_bin" - "$root" "$candidate" "$config" "$candidate_config" <<'PYCODE'
import json, pathlib, sys

live, candidate = map(pathlib.Path, sys.argv[1:3])
old, new = map(json.loads, sys.argv[3:5])
for key in ("stateRoot", "databaseFile", "webRoot"):
    path = pathlib.Path(new[key])
    projected = live / path.relative_to(candidate) if path.is_relative_to(candidate) else path
    if projected != pathlib.Path(old[key]):
        raise SystemExit(f"Candidate changes {key}; coordinate this change separately.")
if old["operationLock"] != new["operationLock"]:
    raise SystemExit("Candidate changes the host operation lock; coordinate this change separately.")
if old["baseUrl"] != new["baseUrl"] or old["host"] != new["host"]:
    raise SystemExit("Candidate changes the listener; coordinate this change separately.")
for value in (old["baseUrl"], old["webRoot"], old["stateRoot"], old["databaseFile"], new["webRoot"], old["operationLock"]):
    print(value)
PYCODE
)
((${#config_values[@]} == 6)) || fail "Cannot verify the candidate root configuration."
base_url=${config_values[0]}
web_root=${config_values[1]}
state_root=${config_values[2]}
database_file=${config_values[3]}
build=${config_values[4]}
[[ $build == "$candidate/"* && -d $build/assets ]] || fail "Missing independent candidate Web build."
[[ -d $state_root && ! -L $state_root && -f $database_file && ! -L $database_file ]] ||
  fail "The configured state root or database is missing; refusing to stop the service."

"$node_bin" "$web_check" "$build" --check-current
"$node_bin" "$web_check" "$web_root" --check-current

# Hold the runner's lock across stop, checkout/Web switch and start.
exec {release_lock}>>"${config_values[5]}"
flock -n "$release_lock" || fail "Another start, stop or release operation is still running."
running_revision=$("$python_bin" "$runner" --root "$root" --node "$node_bin" status |
  "$python_bin" -c 'import json,sys; print(json.load(sys.stdin).get("revision") or "")')
[[ -z $running_revision || $running_revision == "$previous" ]] || fail "Live HEAD differs from the running revision; inspect before release."
work=$(mktemp -d "${TMPDIR:-/tmp}/issue-pilot-release.XXXXXXXX")
# 4. Read the live journal; only pending migrations need a database copy.
preflight_state="$work/preflight-state"
mkdir -m 700 "$preflight_state"
preflight_database="$preflight_state/database.sqlite"
$python_bin - "$database_file" "$preflight_database" "$candidate/drizzle/meta/_journal.json" "$work/migrations.json" <<'PY'
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
entries = json.loads(journal.read_text())["entries"]
with contextlib.closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as live:
    applied = [row[0] for row in live.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")]
    if applied != [entry["when"] for entry in entries[:len(applied)]]:
        raise SystemExit("Live migration journal is not a prefix of the candidate journal.")
    pending = [entry["tag"] for entry in entries[len(applied):]]
    if pending:
        target.touch(mode=0o600, exist_ok=False)
        with contextlib.closing(sqlite3.connect(target)) as saved:
            live.backup(saved)
            if saved.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise SystemExit("preflight database copy failed its integrity check")
output.write_text(json.dumps({"applied": len(applied), "journal": [entry["when"] for entry in entries], "pending": pending}) + "\n")
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
    cd "$candidate"
    env -i HOME="$HOME" PATH=/usr/bin:/bin NODE_ENV=production "$node_bin" --input-type=module -e '
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
    applied = [row[0] for row in saved.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")]
    state = json.loads(open(journal).read())
    if applied != state["journal"]:
        raise SystemExit("preflight migrations did not apply the whole journal")
print("Migration preflight passed on the database copy.")
PY
fi

# 5. Do not touch the live sources or assets unless the old process has drained and exited.
"$python_bin" "$runner" --root "$root" --node "$node_bin" --lock-fd "$release_lock" stop

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

# 7. Switch the checkout and Web after shutdown. Publish assets before their entry points.
[[ $(git -C "$root" rev-parse HEAD) == "$previous" ]] || fail "Live HEAD changed during release."
[[ -z $(git -C "$root" status --porcelain) ]] || fail "Live checkout changed during release."
git -C "$root" merge --ff-only "$head"
[[ $(git -C "$root" rev-parse HEAD) == "$head" ]] || fail "Live HEAD did not reach the candidate."
if cmp -s "$build/index.html" "$web_root/index.html" && cmp -s "$build/.vite/manifest.json" "$web_root/.vite/manifest.json"; then
  echo "Web entry and manifest already match the build."
else
  mkdir -p "$web_root/assets"
  cp -rp "$build/assets/." "$web_root/assets/"
  cp -p "$build/.vite/manifest.json" "$web_root/.vite/manifest.json.tmp"
  mv -f "$web_root/.vite/manifest.json.tmp" "$web_root/.vite/manifest.json"
  cp -p "$build/index.html" "$web_root/index.html.tmp"
  mv -f "$web_root/index.html.tmp" "$web_root/index.html"
fi

# 8. Keep the checkout and Web generation coherent on failure. Refuse a partial rollback.
if ! "$python_bin" "$runner" --root "$root" --node "$node_bin" --lock-fd "$release_lock" start --revision "$head"; then
  if ! "$python_bin" "$runner" --root "$root" --node "$node_bin" --lock-fd "$release_lock" stop; then
    fail "The failed process did not stop. Sources and Web retained; inspect the runner and logs before recovery."
  fi
  echo "Start failed. Sources and Web are still paired at $head; previous revision: $previous." >&2
  if [[ -n $checkpoint ]]; then
    echo "A migration may have run. Preserve the database and $checkpoint; verify the journal before any rollback." >&2
  fi
  fail "Use the documented coordinated rollback after inspecting the failure."
fi

curl -fsS --max-time 10 "$base_url/health" || fail "Health endpoint did not confirm the new process."
echo
"$python_bin" "$runner" --root "$root" --node "$node_bin" status

# 9. Prune retired outputs only after health succeeds; never pipe output (EPIPE aborts deletion).
"$node_bin" "$root/scripts/prune-web-assets.ts" "$web_root" >"$work/prune-dry-run.txt"
sed -n '1p' "$work/prune-dry-run.txt"
"$node_bin" "$root/scripts/prune-web-assets.ts" "$web_root" --apply >"$work/prune-applied.txt"
sed -n '1p' "$work/prune-applied.txt"
echo "Current Web build verified; release complete at revision $head."
success=1
