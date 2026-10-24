import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { legacyIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import { prepareIssueWorkDirectory } from "../../src/workspace/work-files.ts";
import { applyIssueWorkMigration, planIssueWorkMigration } from "../../src/workspace/work-directory-migration.ts";

const key = "ISSUE-20261021-001";

test("explicitly migrates legacy working files, rolls back a failed commit, then retries without changing repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-migration-"));
  try {
    const legacy = path.join(legacyIssueRoot(root, key), "work");
    const target = issueRoot(root, key);
    await mkdir(legacy, { recursive: true });
    await mkdir(path.join(target, "repository"), { recursive: true });
    await writeFile(path.join(target, "repository", "dirty.txt"), "uncommitted code");
    await writeFile(path.join(legacy, "checkpoint.json"), '{"remaining":10}');
    await assert.rejects(prepareIssueWorkDirectory(root, key), /issue_layout_migration_required/);
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
    await rm(legacy, { recursive: true });
    assert.equal(await prepareIssueWorkDirectory(root, key), target);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses migration collisions and symlinks while preserving all evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-collision-"));
  try {
    const legacy = path.join(legacyIssueRoot(root, key), "work");
    const target = issueRoot(root, key);
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
