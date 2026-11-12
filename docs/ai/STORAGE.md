# Storage, Transactions and Recovery

AI reference. [Index](README.md) · [Architecture](ARCHITECTURE.md) · [Human runbook](../RUNBOOK.md)

## Sources of truth and state classes

| Data | Authority | Classification |
| --- | --- | --- |
| Users, configuration, Issue relations, parameters, paths and session bindings | SQLite / [schema.ts](../../src/db/schema.ts) | Durable |
| Conversation, tool results and session branches | Pi JSONL | Durable |
| Attachment originals | Files plus DB size/hash metadata | Durable |
| Scripts, reports and query exports | Ordinary work files | Durable |
| Issue branches, private objects and indexes | Git | Durable |
| Modified/untracked/ignored development working files | Recorded checkout | Conditionally durable until safe release |
| Runtime manifests/wrappers, clean shared snapshots, reproducible dependency caches | Owning subsystem | Generated, but unknown/abnormal contents still require inspection |

Human comments and Pi conversations are separate. A SQLite rollback cannot restore files/Git. Secret projection is not encryption. A cache/tmp/legacy name alone never proves deletability.

## Relations and identifiers

Keys use ISSUE-YYYYMMDD-NNN... in the configured time zone; internal issueId is UUID. The HTTP Issue DTO's id is the business key, not that UUID.

Each Issue matches a valid Service/Environment Deployment and owns exactly one Workspace. resolved iff resolved_at is non-null. Repository records, session binding, attachments, comments, relations, CC, pins and scope transitions have separate persisted relations.

Owners: [contracts.ts](../../src/domain/contracts.ts), [schema.ts](../../src/db/schema.ts), [bootstrap.ts](../../src/db/bootstrap.ts), [drizzle](../../drizzle). Published migration SQL/journal entries are immutable. Normal startup does not infer, adopt or repair legacy directories.

## Layout and modes

The current root configuration selects data. [state.ts](../../src/workspace/state.ts) owns paths:

```text
data/
├── issues.db{,-wal,-shm}
├── vectors.db                   # optional, generated vector index
├── git/                         # shared objects and read-only snapshots
├── workspaces/<lowercase-key>/
│   ├── <repository>/            # dev worktree or read-only code entry
│   ├── .issue-git/              # Issue-private Git
│   ├── .session-*.jsonl         # current and prior conversations
│   ├── .attachment-*            # original attachments
│   ├── .issue-runtime.json
│   └── ordinary work files and caches
└── control/                     # lease and transaction/recovery material
```

State is 0700, DB/JSONL 0600, originals exact 0400 regular files. Managed files may be listed but not downloaded as ordinary files. Host tools, application dependencies and Web builds stay outside state; there is no application project .venv.

The optional search index is private (0600), outside the authoritative Issue database. It stores Issue IDs, chunk positions, full-text fingerprints and vectors for the fixed Qwen3 model. Only the current chunked table is supported; runtime refresh does not migrate older index formats. Unchanged vectors covering the full text are reusable, and changed documents do not match until refreshed. Credential changes can reuse vectors; a model change requires a rebuild. The index is excluded from business database checkpoints. The search settings and Token stay in issues.db. Startup does not inspect the index. The first refresh publishes the file after the schema and first page commit; later pages update the published index transactionally. Follow the [search API contract](HTTP.md#issue-vector-search) to refresh it; preserve unknown or redirected paths.

No old .issue-pilot compatibility directory, symlink or mount is maintained. Textual old paths in durable JSONL do not drive current file resolution. Execute with the current cwd override; do not rewrite conversation content to normalize paths.

## Missing or redirected Issue roots

Only claimIssueRoot may exclusively claim an empty root during creation. Code preparation, admission and export require the original root to exist. Reject redirected roots or invalid types rather than creating empty state or changing bindings.

Missing roots yield issue_root_missing; invalid roots yield invalid_issue_root. Preserve permission/I/O error meaning. Existing roots may rebuild generated manifests/read-only entries. Missing roots require inspection of DB, Git, remaining files and known recovery sources; shared or remote branches are not substitutes for recorded history.

Work-file access checks the durable Issue root before resolving repository read roots, then validates the path again when opening it. A root listing does not treat a missing Issue root as an empty directory.

Tests: [state.test.ts](../../tests/workspace/state.test.ts), [message-admission.test.ts](../../tests/agent/message-admission.test.ts), [work-files.test.ts](../../tests/workspace/work-files.test.ts), [work-files HTTP test](../../tests/http/work-files.test.ts).

## Issue state audit

Ordinary startup does not compare all Issue records with filesystem entries. Creation still refuses a target occupied in the current or legacy layout. Root validation and lifecycle mutations refuse legacy contents for the selected Issue. No operation adopts or removes unowned directories as a result of the audit.

[check-issue-state.ts](../../scripts/check-issue-state.ts) opens SQLite read-only and checks required Workspace rows, resolution state and directory ownership. Use the [runbook](../RUNBOOK.md#工单状态审计) command when investigating storage drift, with writers stopped for a consistent comparison. Add `--shared-git` to also audit every shared snapshot. `--development-git` selects a separate audit of recorded development branches, private stores and reciprocal worktree bindings. It reports mirror differences and exits nonzero for unresolved bindings. A released shared ref without a private store or worktree does not establish the authoritative source. The audit does not publish refs, switch bindings or recover missing data. Operations that use a root or Git binding also check it on access. The migration that adds indexed recovery validates existing Issue relations before applying it; this migration can take time proportional to the database size once.

## Attachments

[attachment-store.ts](../../src/http/attachment-store.ts) stages uploads, computes size/SHA-256 and coordinates files/metadata with Issue transactions. Reads verify direct root ownership, regular-file type, exact 0400, size and hash. Recheck the opened descriptor's real location and send from that descriptor, avoiding check/reopen races.

Mutation reserves the Issue and closes the old session before applying files; it does not repair abnormal roots. Removal quarantines first, restores on rollback and finalizes after commit. Preserve primary and cleanup failures; cleanup failure is not ordinary cancellation.

Preparation reads originals without automatic editable copies. Explicit editing creates work files. Pasted images stay in Pi messages. Regression: [attachment-api.test.ts](../../tests/http/attachment-api.test.ts).

## Work files and source writes

[work-files.ts](../../src/workspace/work-files.ts) atomically replaces query exports only after same-directory temporary writing and protocol close both succeed. Earlier failure retains old content, never automatically reruns SQL. Serialize same-path operations and permit cancellation while waiting.

File/source APIs check paths, managed names, Git controls and actual opened locations, not arbitrary host paths. Clean only temporaries owned by the current operation. Retired publication/snapshot/download layers stay retired. Real outputs/work/attachments directories are ordinary paths, not legacy aliases.

[source-browser.ts](../../src/workspace/source-browser.ts) creates files through exclusive temporaries and no-clobber publication. Competing creation cannot overwrite another result. source_create_cleanup_failed may leave a complete published target: reread before retrying. Saves require the previously read SHA-256; never remove conflict checking.

Preview, source, diff and MCP inline limits are separate from ordinary downloads and total durable history. Regression: [source-pagination.test.ts](../../tests/workspace/source-pagination.test.ts).

## Git and workspaces

Shared bare stores retain baseline objects/refs; shared snapshots are detached. Dev Issues retain private branches, objects, indexes and worktrees while reusing shared objects read-only. Never share writable cross-Issue hardlinks.

| Repository-set classification | local_path | working_branch |
| --- | --- | --- |
| read_only | All null | All null |
| development_workspace | All non-null | All non-null |
| development_snapshot | All null | All non-null |
| invalid | Empty, mixed or other combination | Refuse and preserve |

Code reads validate the selected binding against its recorded prod/test commit or local dev working branch. Before exposing a shared snapshot to the code browser, work-file reader or Agent, check reciprocal Git pointers, detached HEAD and cleanliness, including ignored files. Preserve a changed snapshot and refuse access to it; unrelated snapshots do not block startup or other reads. Read-only recovery checks related context before starting Git work. Recovery checks HEAD, common directory, pointers and branch. Resolve baselines using full refs. Restore dev only from valid recorded local branches: no reset, remote fallback or guessed rebinding. Ref publication uses compare-and-swap and rejects unexpected external changes.

Released development records its exact local branch tip and links to the corresponding shared checkout path without creating a new checkout. Shared checkout eviction is disabled by default. The Git owner may remove an existing checkout only after verifying its reciprocal binding, cleanliness, local objects and that every path and file byte agrees with the commit tree. Preserve extra paths even if Git status omits them. Retain the exact commit under `refs/issue-pilot/snapshots/` before recording or evicting a checkout; never prune these refs or shared objects as part of cache eviction. A missing directory is a cache miss only when the recorded Issue link and retained ref agree. The code browser reads regular text, directory trees and history from local Git for this case; readers needing filesystem semantics request the exact detached checkout. Requests and Agent sessions hold leases while using these paths. This does not reconstruct a missing Issue root, switch a branch, or use the remote.

The private store is the sole runtime authority for recorded development branches. A missing store fails even if a shared mirror exists. The [offline migration](../RUNBOOK.md#开发工单-git-迁移) isolates only explicitly reviewed shared worktrees or independently evidenced released refs. It keeps staged and uncommitted data, packs Issue-specific objects in the private store, retains read-only baseline alternates, and does not change SQLite or publish a ref. Refuse ambiguous ownership, mismatched HEAD and changed tips. Keep original registrations as recovery evidence.

Release requires resolved, idle, correctly bound and clean state, including staged/untracked/ignored content. Remove only registered code; retain Issue root, conversations, originals, work files and private branches. Missing roots cannot be released/reopened.

Owners: [git.ts](../../src/workspace/git.ts), [issue-git.ts](../../src/workspace/issue-git.ts), [lifecycle.ts](../../src/workspace/lifecycle.ts).

## Deletion and cross-medium failure

Admin DELETE /api/issues/:key permanently deletes an Issue; it is not workspace release. Refuse active work, inbound relations, abnormal roots and dirty registered worktrees; there is no force option.

Use the Git owner to remove eligible worktrees, stage the root at control/deletions/<key>-<uuid>, then delete DB relations transactionally. On DB failure restore root and worktree; after commit delete staged content. Originals, JSONL, work files and private Git are permanently deleted; unrelated Issues, shared caches and published branches are outside scope.

Files and SQLite cannot commit atomically. A 500/disconnection does not prove no deletion occurred. Post-commit cleanup failure does not restore partially removed contents. Inspect DB presence, the exact staging path, Git registrations and relevant constraints before retrying. Never broadly clean or recreate empty records/roots.

## Capacity sampling

Issue totalBytes includes originals, JSONL, work files, caches and private Git. sharedGitBytes is separate. Neither is whole-disk usage or an atomic filesystem snapshot.

Concurrent readers share in-flight sampling. Cache results for one maintenance cycle, root default 15 minutes; when the cycle is zero, cache for five seconds. GET /api/workspaces/stats?refresh=true bypasses cached and ordinary samples, but overlapping refreshes share one fresh sample unless a lifecycle write or policy change intervenes. sampledAt marks batch completion; candidate bytes are not guaranteed reclaimable bytes.

The background pass measures Issue roots for high water and updates the sample after release. High water excludes shared Git and is not a filesystem quota. Retention and quota release only eligible development worktrees; a recorded, ready snapshot still counts toward capacity but has no worktree to release. A recorded release with an unfinished snapshot view can be retried even below high water. The first scheduled pass waits one configured interval after listening; zero disables automatic passes. Each scheduled pass finishes before the next delay starts; release, reopen and statistics can wait behind it in the lifecycle queue. Actual removal still rechecks state and measures bytes under the Issue reservation.

The optional shared checkout budget is separate: when enabled in root configuration, an over-budget pass visits least recently used checkouts in a bounded batch and skips leased or invalid paths. It runs after the Issue lifecycle pass and serializes each removal with that repository's own operations. After retaining the commit, move the checkout out of its public path before removal; preserve any failed cleanup under control for inspection.

## Database checkpoints

Current policy is database-only recovery checkpoints, not new full Issue-file backups. Routine inspection/restart creates none. Before a migration or high-risk DB mutation, create/validate a consistent checkpoint; retain only the latest and previous valid checkpoints after success. Inspect unknown failed materials before rotation.

Obtain operation authorization, verify the target, block admission, drain work, stop all writers and release the lease first. Copying only a live WAL main file is invalid. Checkpoints do not restore originals, sessions, work files or Git. If that recovery scope is insufficient, stop instead of silently creating full file backups.

The example requires explicit absolute paths. Its parent directory must exist outside state, be non-symlink and private 0700. The script does not stop the application; do not use default live paths for experiments.

```bash
DATABASE_FILE='/absolute/path/to/state/issues.db' \
CHECKPOINT_ROOT='/absolute/path/to/private-checkpoints' \
python3 - <<'PY'
import contextlib
import os
import pathlib
import sqlite3
import tempfile

source = pathlib.Path(os.environ['DATABASE_FILE'])
root = pathlib.Path(os.environ['CHECKPOINT_ROOT'])
if not source.is_absolute() or not source.is_file() or source.is_symlink():
    raise SystemExit('database must be an existing regular file at an absolute path')
if not root.is_absolute() or not root.is_dir() or root.is_symlink() or root.stat().st_mode & 0o7777 != 0o700:
    raise SystemExit('checkpoint root must be an existing private 0700 directory')
checkpoint = pathlib.Path(tempfile.mkdtemp(prefix='db-checkpoint-', dir=root))
partial = checkpoint / 'database.sqlite.partial'
partial.touch(mode=0o600, exist_ok=False)
with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live:
    with contextlib.closing(sqlite3.connect(partial)) as saved:
        live.backup(saved)
        if saved.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise SystemExit('checkpoint integrity check failed; preserve partial for inspection')
        if saved.execute('PRAGMA foreign_key_check').fetchall():
            raise SystemExit('checkpoint foreign key check failed; preserve partial for inspection')
partial.rename(checkpoint / 'database.sqlite')
print(checkpoint)
PY
```

Only database.sqlite signifies completion of this example's copy and checks; preserve .partial for inspection. Record source revision, root configuration, source DB path and time without secrets. Passing SQLite checks does not validate file/Git alignment or old-code compatibility.

## Retention and cleanup

After migration, live storage/Git repair or abnormal recovery, verify relevant integrity/FK, modes/hashes, session bindings, refs/worktrees and unmanaged paths. Routine Web/backend releases use health, artifacts and focused behavior checks instead of full state scans.

Preserve unknown/unrepresented directories, quarantine, failed staging and changed worktrees. Existing recovery archives need provenance and cross-medium consistency; a DB or branch alone is not a complete recovery point. This does not authorize accumulating new full-state snapshots.

Documentation archives are not required. Their removal does not authorize deleting durable business history, immutable migration SQL, fixtures or operational recovery evidence.

## Offline layout migration

[scripts/migrate-flat-issue-layout.ts](../../scripts/migrate-flat-issue-layout.ts) remains an offline tool for explicitly identified old state. It is not part of normal startup, release or cleanup. Do not delete the implementation merely because current documentation drops historical archives.

Only after authorization, stopping writers, verifying source/modes/hashes/bindings and rehearsing the operation in isolation, generate a plan with an explicit --state-root. --apply performs preflight, immutable schema upgrades and owned file/binding changes under the state lease. Never delete a lease socket to proceed.

File rollback cannot undo schema upgrades. Preserve plan/quarantine on failure; flat_layout_committed_finalize_failed means bindings committed but cleanup failed. Do not blindly repeat. The tool does not rewrite JSONL or create runtime path aliases. Verify relevant DB/file/Git consistency before restarting. Tests: [flat-layout-cli.test.ts](../../tests/workspace/flat-layout-cli.test.ts).
