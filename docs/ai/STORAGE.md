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

Human Issue comments and their rows were removed by [migration 0081](../../drizzle/0081_drop_issue_comments.sql); Pi conversations stay in JSONL. [Migration 0082](../../drizzle/0082_retire_private_secrets.sql) removed the retired `user_credentials.model_api_keys`, `application_settings.mysql_stdio` and `application_settings.max_concurrent_issues` columns and the retired `nacos`, `db`, `redis`, `mq`, `es` and `mcpServices` deployment keys after an offline export from a verified checkpoint; [migration 0083](../../drizzle/0083_redundant_trigger_cleanup.sql) removed redundant retired triggers and closed the scope-transition work-mode set. A SQLite rollback cannot restore files/Git. Secret projection is not encryption. A cache/tmp/legacy name alone never proves deletability.

## Relations and identifiers

Keys use ISSUE-YYYYMMDD-NNN... in the configured time zone; internal issueId is UUID. The HTTP Issue DTO's id is the business key, not that UUID. SQLite reserves the next number for that day before the root is claimed. Failed creation can leave a gap; deletion never returns an allocated number. Migration seeds the counter from existing Issues; numbers already deleted before migration cannot be recovered from those rows.

Each Issue matches a valid Service/Environment Deployment and owns exactly one Workspace. resolved iff resolved_at is non-null. Repository records, session binding, attachments, relations, CC, pins and scope transitions have separate persisted relations.

[Migration 0078](../../drizzle/0078_issue_detail_revision.sql) adds an internal `issues.detail_revision` counter. SQLite advances it in the same transaction as a description change, scope-history append, attachment/related-Issue/included-service membership change, or repository/session binding change. These triggers follow the current write contracts and add no route-level invalidation work. Existing rows start at zero without backfilling details. Migration 0081 dropped the comment trigger with the comment table. The counter tracks Issue-owned database writes; filesystem availability and changes to separately managed display names can still be sampled independently.

[Migration 0080](../../drizzle/0080_closed_domain_guards.sql) guards the closed sets that startup recovery and lifecycle SQL match literally: Issue status/priority, Workspace status and Environment kind abort with `invalid_issue_status`, `invalid_issue_priority`, `invalid_workspace_status` or `invalid_environment_kind` (internal failures, not client conflicts). Like 0070 it refuses to upgrade when existing rows fall outside these sets instead of rewriting them. It also mirrors the 0035 deployment guard for included services: a deployment used through an Issue's included service scope in that Issue's environment cannot be deleted or moved (`deployment_is_used_by_issues`). Keep the trigger lists in step with [contracts.ts](../../src/domain/contracts.ts) through a new migration.

[Migration 0083](../../drizzle/0083_redundant_trigger_cleanup.sql) keeps the 0070 Issue type triggers, drops the redundant `issues_retired_type_*` pair, and replaces `scope_transitions_retired_mode_*` with `issue_scope_transitions_work_mode_valid_*`. The new triggers refuse any `from_work_mode`/`to_work_mode` outside the closed set with `invalid_issue_work_mode`, after the same refuse-if-existing-rows check as 0070/0080.

Migrations run with foreign keys disabled and commit before returning. Every database open (server startup and the migrate script) then runs `PRAGMA foreign_key_check` and fails with `database_foreign_key_violation` before the API listens, instead of only after a migration ran, because the advanced journal would let the next start skip the check. [schema-drift.test.ts](../../tests/db/schema-drift.test.ts) compares a freshly migrated database with schema.ts; its explicit exception list records the known differences.

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

Missing roots yield issue_root_missing; invalid roots yield invalid_issue_root. Preserve permission/I/O error meaning. Existing roots may rebuild generated manifests/read-only entries. Generated runtime links are not write-protected in the sandbox, so an absent manifest link is rebuilt on the next preparation; a replaced link (other target or a non-link) and an absent or changed generated file are refused. Missing roots require inspection of DB, Git, remaining files and known recovery sources; shared or remote branches are not substitutes for recorded history.

Runtime preparation validates the entire previous manifest, then changes only entries whose content, target or mode differs, plus missing generated links. Unchanged entries stay at their public paths with the same inodes and never participate in rollback. The manifest still publishes last; failure restores changed entries, and post-publication cleanup failures retain their diagnostics.

Source resolution preserves structured system errors and classified owner failures, including cold-snapshot checks. They must not become source_git_binding_invalid conflicts; HTTP reports internal failures without publishing filesystem paths. Regression: [source failure tests](../../tests/http/source-failures.test.ts).

Work-file access checks the durable Issue root before resolving repository read roots, then validates the path again when opening it. A root listing does not treat a missing Issue root as an empty directory.

Tests: [state.test.ts](../../tests/workspace/state.test.ts), [message-admission.test.ts](../../tests/agent/message-admission.test.ts), [work-files.test.ts](../../tests/workspace/work-files.test.ts), [work-files HTTP test](../../tests/http/work-files.test.ts).

## Issue state audit

Ordinary startup does not compare all Issue records with filesystem entries. Creation still refuses a target occupied in `workspaces/`, and root validation and lifecycle mutations refuse unrepresented contents for the selected Issue. No operation adopts or removes unowned directories as a result of the audit.

[check-issue-state.ts](../../scripts/check-issue-state.ts) opens SQLite read-only and checks required Workspace rows, resolution state, release-marker/repository agreement and directory ownership. Use the [runbook](../RUNBOOK.md#工单状态审计) command when investigating storage drift, with writers stopped for a consistent comparison. Add `--shared-git` to also audit every shared snapshot. `--development-git` selects a separate audit of recorded development branches, private stores and reciprocal worktree bindings. It reports mirror differences and exits nonzero for unresolved bindings. A released shared ref without a private store or worktree does not establish the authoritative source. The audit does not publish refs, switch bindings or recover missing data. Operations that use a root or Git binding also check it on access. The migration that adds indexed recovery validates existing Issue relations before applying it; this migration can take time proportional to the database size once.

## Attachments

[attachments.ts](../../src/workspace/attachments.ts) streams uploads once into private staging under `control`, calculates size/SHA-256 and syncs the sealed 0400 file. On the same filesystem, publish that inode under a new no-clobber name in the Issue root, remove the staging name, and sync the root before committing metadata. There is no attachment copy or backup. Reads verify direct root ownership, regular-file type, exact 0400, size and hash. Recheck the opened descriptor's real location and send from that descriptor, avoiding check/reopen races.

Mutation reserves the Issue and closes the old session before applying files; it does not repair abnormal roots. Keep the old original addressable until the transaction replaces its active record with an exact retirement record. After commit, verify and unlink only those recorded originals. A failed unlink leaves the record and evidence for the next successful edit; no directory sweep claims unrepresented files. Preserve primary and cleanup failures; cleanup failure does not undo a committed edit.

Preparation reads originals without automatic editable copies. Explicit editing creates work files. Pasted images stay in Pi messages. Regression: [attachment-api.test.ts](../../tests/http/attachment-api.test.ts).

## Work files and source writes

[work-files.ts](../../src/workspace/work-files.ts) atomically replaces query exports only after same-directory temporary writing and protocol close both succeed. Earlier failure retains old content, never automatically reruns SQL. Serialize same-path operations and permit cancellation while waiting: a cancelled waiter settles immediately and never runs its producer; once started, the producer owns cancellation and cleanup.

File/source APIs check paths, managed names, Git controls and actual opened locations, not arbitrary host paths. Work-file listings read incrementally through the pinned directory and reject on the first entry beyond the budget; virtual repository entries count toward the same limit. Clean only temporaries owned by the current operation. Retired publication/snapshot/download layers stay retired. Real outputs/work/attachments directories are ordinary paths, not legacy aliases.

[source-browser.ts](../../src/workspace/source-browser.ts) creates files through exclusive temporaries and no-clobber publication. Competing creation cannot overwrite another result. source_create_cleanup_failed may leave a complete published target: reread before retrying. Saves require the previously read SHA-256; never remove conflict checking.

Source previews and save preconditions share one bounded descriptor reader. Enforce the byte limit during reading, even when a file grows after stat; returned size and hash describe the actual bytes read. This is a read budget, not a filesystem snapshot.

Preview, source, diff and MCP inline limits are separate from ordinary downloads and total durable history. Regression: [source-pagination.test.ts](../../tests/workspace/source-pagination.test.ts).

## Git and workspaces

Shared bare stores retain baseline objects/refs; shared snapshots are detached. Dev Issues retain private branches, objects, indexes and worktrees while reusing shared objects read-only. Never share writable cross-Issue hardlinks.

Trusted Git runs outside the sandbox against model-writable worktrees, so every application invocation goes through [git-command.ts](../../src/workspace/git-command.ts): it prepends `core.fsmonitor=false`, `core.untrackedCache=false`, `diff.ignoreSubmodules=all`, `submodule.recurse=false` and `core.hooksPath=/dev/null`, sets `GIT_CONFIG_NOSYSTEM=1`, and every `status`/`diff`/`diff-index` call also passes `--ignore-submodules=all`. Repository-controlled configuration, including configuration of a nested repository Git might inspect, therefore never selects a program. Submodules are never recursed into. A staged gitlink that HEAD does not already contain is an embedded repository: the shared Git owner unstages only those literal paths and refuses staging/committing with `embedded_repository_not_allowed`. Web and Agent use the same rule. If this cleanup throws, times out or exits unsuccessfully, report `workspace_git_index_cleanup_failed` with outcome `unknown`, preserving the rejection and cleanup diagnostics instead of claiming the index was restored. Submodules already recorded in HEAD remain inspectable as plain gitlinks.

Git index paths must decode losslessly as UTF-8. Invalid bytes refuse inspection before any cleanup reset and preserve the entire index; replacement decoding must never turn one path into another. Literal path handling still permits valid Unicode names and Git pathspec punctuation.

| Repository-set classification | local_path | working_branch |
| --- | --- | --- |
| read_only | All null | All null |
| development_workspace | All non-null | All non-null |
| development_snapshot | All null | All non-null |
| invalid | Empty, mixed or other combination | Refuse and preserve |

Code reads validate the selected binding against its recorded prod/test commit or local dev working branch. Before exposing a shared snapshot to the code browser, work-file reader or Agent, check reciprocal Git pointers, detached HEAD and cleanliness, including ignored files. Preserve a changed snapshot and refuse access to it; unrelated snapshots do not block startup or other reads. Read-only recovery checks related context before starting Git work. Recovery checks HEAD, common directory, pointers and branch. Resolve baselines using full refs. Restore dev only from valid recorded local branches: no reset, remote fallback or guessed rebinding. Ref publication uses compare-and-swap and rejects unexpected external changes.

Before removing a development worktree, publish and retain its exact private branch tip under `refs/issue-pilot/snapshots/`. A released Issue derives its repository entries from the recorded branch and publication commit; release does not write repository links or rebuild its runtime manifest. Previously generated links, if present, must still match the recorded commit. If an older release has no retained ref, the exact shared mirror can establish local reachability only after validating the private branch and publication marker. The code browser can read a cold snapshot directly from Git. Work-file access exposes a repository entry even without a link and requests the exact shared checkout only for filesystem reads. A related Agent round links the checkout from its own runtime and grants read access for that session. No read fetches from the remote or reconstructs a missing Issue root.

Shared checkout eviction is disabled by default. Before eviction the Git owner verifies the binding, cleanliness, local objects and every path and file byte against the commit. Preserve extra paths even if Git status omits them. The retained ref protects the commit; cache eviction never prunes retained refs or shared objects. Requests and Agent sessions hold leases while using materialized paths.

The private store is the sole runtime authority for recorded development branches. A missing store fails even if a shared mirror exists. Normal preparation validates an existing worktree without rewriting its Git registration. Git preparation and restoration validate the creation-owned Issue root before touching repositories; they never create or remove that root. New Issue branches are created directly in the private store at the configured baseline, without upstream tracking or a shared worktree registration. A retained ref protects the borrowed baseline objects, both at creation and when a removed repository is included again with a refreshed baseline. The first publication compares the shared ref against absence; later publications compare against the previous published commit and refuse external changes. The [offline migration](../RUNBOOK.md#开发工单-git-迁移) isolates only explicitly reviewed shared worktrees or independently evidenced released refs. It keeps staged and uncommitted data, packs Issue-specific objects in the private store, retains read-only baseline alternates, and does not change SQLite or publish a ref. Refuse ambiguous ownership, mismatched HEAD and changed tips. Keep original registrations as recovery evidence.

Release requires resolved, idle, correctly bound and clean state, including staged/untracked/ignored content. Worktree removal also refuses indexes with `assume-unchanged` or `skip-worktree` entries because Git status can omit local edits. Remove only registered code; retain Issue root, conversations, originals, work files and private branches. Missing roots cannot be released/reopened. `issue_workspaces.released_at` is the sole release marker: it is committed in the same transaction as the snapshot repository rows, survives runtime rehydration, and is cleared by reopen, conversion or scope migration. Maintenance selects and completes releases from that marker instead of inferring them from status, `runtime_ready` and repository rows separately.

Owners: [git.ts](../../src/workspace/git.ts), [issue-git.ts](../../src/workspace/issue-git.ts), [lifecycle.ts](../../src/workspace/lifecycle.ts).

Read-only to development conversion validates and captures the recorded local snapshot before replacing runtime links. If Git or the database finalize fails, restore those captured links without fetching upstream or rewriting repository rows; an advancing or unavailable remote must not change the analyzed version.

## Deletion and cross-medium failure

Admin DELETE /api/issues/:key permanently deletes an Issue; it is not workspace release. Refuse active work, inbound relations, abnormal roots and dirty registered worktrees; there is no force option.

Close the session before the final root, layout and Git cleanliness checks, because shutdown hooks may still write files. Private Git and its registered worktrees already belong to the same Issue root: stage that entire root intact at control/deletions/<key>-<uuid>, then delete DB relations transactionally. On DB failure move the same root back; never remove and reconstruct its worktrees. This retains file identities, permissions, indexes and Git registration exactly. Deletion performs no Git publication, retention or worktree mutation, and runs no Git command at the staged location. After commit delete staged content. Originals, JSONL, work files and private Git are permanently deleted; unrelated Issues, shared caches and published branches are outside scope.

Files and SQLite cannot commit atomically. A 500/disconnection does not prove no deletion occurred. Post-commit cleanup failure does not restore partially removed contents. Inspect DB presence, the exact staging path, Git registrations and relevant constraints before retrying. Never broadly clean or recreate empty records/roots.

## Capacity sampling

Issue totalBytes includes originals, JSONL, work files, caches and private Git. sharedGitBytes is separate. Neither is whole-disk usage or an atomic filesystem snapshot.

GET /api/workspaces/stats returns { snapshot, sampling, error } immediately. snapshot is the last complete sample or null before the first sample; ordinary reads never wait for the lifecycle queue or rescan an existing snapshot. A cold read starts one background sample. ?refresh=true requests a background sample and overlapping requests join the active work. Polls do not automatically retry a failed sample. The next scheduled pass or explicit refresh retries; failures retain the last successful snapshot and expose only a stable error code. Lifecycle/policy changes supersede in-flight publication without discarding the previous display. sampledAt marks batch completion; candidate bytes are not guaranteed reclaimable bytes. This response envelope requires the Web and API to be deployed together.

The background pass measures Issue roots for high water, updates their sizes after release, and publishes complete statistics using those measurements, plus Git eligibility and shared Git usage. A failed size command may print a lower bound; the affected Issue is skipped, other candidates continue, and the last complete snapshot remains visible. High water excludes shared Git and is not a filesystem quota. Retention and quota release only eligible development worktrees; a recorded release still counts toward capacity but has no worktree to release. Capacity sampling does not rebuild or inspect its generated view; explicit inspection, reads and reopen verify their recorded bindings. The first scheduled pass waits one configured interval after listening (root default 15 minutes); zero disables automatic passes but permits explicit sampling. Each scheduled pass finishes before the next delay starts.

Whole background jobs serialize on their own queue. Each measurement/inspection batch contains at most taskConcurrency Issues and joins the lifecycle queue separately; each automatic release and the shared Git measurement also join it separately. A foreground reopen, release or other lifecycle mutation can run between batches, after reauthorization, instead of waiting for the whole fleet scan. A single batch, Git measurement or release may still take time. A queued foreground mutation or policy update supersedes the pass's measurements: remaining automatic releases are skipped and the old pass cannot replace the displayed snapshot. Actual removal still rechecks state and measures bytes under the Issue reservation, with lifecycle queue → Issue reservation acquisition preserved. HTTP snapshot reads do not join either queue. Shutdown refuses new work, drains all batches of admitted background jobs, then drains remaining lifecycle work.

The Web resource tab reads snapshots every 10 seconds while visible, and on returning to the tab. It never overlaps read requests, cancels them on hiding/navigation/disposal, preserves displayed results through errors, and exposes an explicit background resample button. Display the full sample timestamp and the retention due date derived from resolvedAt, not the Issue key's creation date. Released code still retains private Git, originals, JSONL and ordinary work files; ignored paths alone do not prove safe deletion.

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

The retired secrets removed by migration 0082 survive only in the private pre-release export recorded in the [runbook](../RUNBOOK.md#退役密钥留证). Keep it like a credential; the one-off export tool was removed after the release.

### Restoring a checkpoint

Only after authorization for the write loss. Stop every writer first: the application and every offline tool that uses the same state lease. Keep the broken configured database plus its `-wal`/`-shm` sidecars aside as evidence; do not delete or overwrite them. Copy the checkpoint's `database.sqlite` to the configured database path as a 0600 regular file owned by the runtime user, with no sidecars from the broken copy. Then start the code revision that matches the checkpoint; do not start a newer revision and expect it to downgrade the schema.

Everything written after the checkpoint is lost. JSONL conversations, attachments, work files and Git are not restored and may no longer match the restored rows; replaying them is not a supported reconstruction. Migrations 0079 and later cannot be rolled back by code alone. If the checkpoint predates them, restore the matching older revision and preserve the failed database for inspection. The release rollback rules are in [Deployment](../DEPLOYMENT.md#协调发布后端与-web); ordinary restarts create no checkpoint.

## Retention and cleanup

After migration, live storage/Git repair or abnormal recovery, verify relevant integrity/FK, modes/hashes, session bindings, refs/worktrees and unmanaged paths. Routine Web/backend releases use health, artifacts and focused behavior checks instead of full state scans.

Preserve unknown/unrepresented directories, quarantine, failed staging and changed worktrees. Existing recovery archives need provenance and cross-medium consistency; a DB or branch alone is not a complete recovery point. This does not authorize accumulating new full-state snapshots.

Documentation archives are not required. Their removal does not authorize deleting durable business history, immutable migration SQL, fixtures or operational recovery evidence.
