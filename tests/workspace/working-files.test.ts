import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claimIssueRoot, issueRoot, issueWorkDirectory } from "../../src/workspace/state.ts";
import { listIssueWorkFiles, openIssueWorkFile, prepareIssueWorkDirectory } from "../../src/workspace/working-files.ts";
import { applyIssueWorkMigration, planIssueWorkMigration } from "../../src/workspace/work-directory-migration.ts";

const key = "ISSUE-20261021-001";
test("Issue creation claims an empty working directory and preserves an unknown existing directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-claim-"));
  try {
    const target = issueWorkDirectory(root, key);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "evidence.txt"), "preserve");
    await assert.rejects(claimIssueRoot(root, key), /unmanaged_issue_state:workspaces/);
    assert.equal(await readFile(path.join(target, "evidence.txt"), "utf8"), "preserve");
    await assert.rejects(readFile(path.join(issueRoot(root, key), "anything")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lists and downloads working files without following paths outside the Issue or Git controls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-working-files-"));
  try {
    const work = await prepareIssueWorkDirectory(root, key);
    assert.equal(work, issueWorkDirectory(root, key));
    await mkdir(path.join(work, "nested"));
    await writeFile(path.join(work, "nested", "库存 #1.xlsx"), "workbook");
    await mkdir(path.join(work, ".git"));
    await writeFile(path.join(work, ".git", "config"), "private git data");
    await writeFile(path.join(root, "secret"), "private");
    await symlink(path.join(root, "secret"), path.join(work, "escape"));
    await symlink(path.join(work, ".git"), path.join(work, "git-alias"));
    const listing = await listIssueWorkFiles(root, key);
    assert.equal(listing.some(row => row.name === ".git"), false);
    assert.equal(listing.find(row => row.name === "escape")?.kind, "link");
    const file = await openIssueWorkFile(root, key, "nested/库存 #1.xlsx");
    try { assert.equal((await file.handle.readFile()).toString(), "workbook"); }
    finally { await file.handle.close(); }
    for (const selected of ["../secret", "/etc/passwd", "escape", ".git/config", "git-alias/config"]) {
      await assert.rejects(openIssueWorkFile(root, key, selected), /invalid_issue_file_path/);
    }
    await assert.rejects(openIssueWorkFile(root, key, "nested"), /issue_file_not_regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicitly migrates legacy working files, rolls back a failed commit, then retries without changing repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-migration-"));
  try {
    const legacy = path.join(issueRoot(root, key), "work");
    const target = issueWorkDirectory(root, key);
    await mkdir(legacy, { recursive: true });
    await mkdir(path.join(target, "repository"), { recursive: true });
    await writeFile(path.join(target, "repository", "dirty.txt"), "uncommitted code");
    await writeFile(path.join(legacy, "checkpoint.json"), '{"remaining":10}');
    await assert.rejects(prepareIssueWorkDirectory(root, key), /issue_work_directory_migration_required/);
    const plan = await planIssueWorkMigration(root, [key]);
    assert.equal(plan.length, 1);
    await assert.rejects(applyIssueWorkMigration(plan, async () => { throw new Error("db_commit_failed"); }), /db_commit_failed/);
    assert.equal(await readFile(path.join(legacy, "checkpoint.json"), "utf8"), '{"remaining":10}');
    let commits = 0;
    await applyIssueWorkMigration(await planIssueWorkMigration(root, [key]), async () => { commits++; });
    assert.equal(commits, 1);
    assert.equal(await readFile(path.join(target, "checkpoint.json"), "utf8"), '{"remaining":10}');
    assert.equal(await readFile(path.join(target, "repository", "dirty.txt"), "utf8"), "uncommitted code");
    assert.deepEqual(await planIssueWorkMigration(root, [key]), []);
    assert.equal(await prepareIssueWorkDirectory(root, key), target);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses migration collisions and symlinks while preserving all evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-collision-"));
  try {
    const legacy = path.join(issueRoot(root, key), "work");
    const target = issueWorkDirectory(root, key);
    await mkdir(legacy, { recursive: true }); await mkdir(target, { recursive: true });
    await writeFile(path.join(legacy, "result.txt"), "old");
    await writeFile(path.join(target, "result.txt"), "new");
    await assert.rejects(planIssueWorkMigration(root, [key]), /issue_work_migration_collision/);
    assert.equal(await readFile(path.join(target, "result.txt"), "utf8"), "new");
    await rm(path.join(target, "result.txt"));
    await symlink("result.txt", path.join(legacy, "link"));
    await assert.rejects(planIssueWorkMigration(root, [key]), /issue_work_migration_requires_inspection/);
    assert.equal(await readFile(path.join(legacy, "result.txt"), "utf8"), "old");
  } finally { await rm(root, { recursive: true, force: true }); }
});
