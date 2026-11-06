import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/db/client.ts";
import { issueComments, issuePins, issueRelations, issues, issueWorkspaces, repositories, subjects } from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { issueRoot, pathExists } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

for (const mode of ["success", "rollback", "referenced", "symlink"] as const) {
  test(`Issue deletion: ${mode}`, async () => {
    const f = await createApiFixture();
    const db = openDatabase(f.databaseFile);
    try {
      await createService(f.app, "Delete");
      const created = await createIssue(f.app, "delete", "test");
      const [issue] = await db.db
        .select()
        .from(issues)
        .where(eq(issues.key, String(created.id)));
      const root = issueRoot(f.root, issue!.key);
      await writeFile(path.join(root, "evidence.txt"), "durable work");
      const [admin] = await db.db.select().from(subjects);
      const headers = { "x-issue-pilot-subject": admin!.subject };
      await db.db.insert(issueComments).values({ issueId: issue!.id, authorSubject: admin!.subject, body: "comment" });
      await db.db.insert(issuePins).values({ issueId: issue!.id, subject: admin!.subject });
      await db.db.insert(subjects).values({ subject: "ordinary", role: "product" });
      const forbidden = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}`, headers: { "x-issue-pilot-subject": "ordinary" } });
      assert.equal(forbidden.statusCode, 403, forbidden.body);
      const busy = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}`, headers });
      assert.equal(busy.statusCode, 409, busy.body);
      f.engine.running.clear();
      if (mode === "rollback") await db.client.execute("CREATE TRIGGER refuse_delete BEFORE DELETE ON issues BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
      if (mode === "referenced") {
        const other = await createIssue(f.app, "delete", "test");
        const [row] = await db.db
          .select()
          .from(issues)
          .where(eq(issues.key, String(other.id)));
        await db.db.insert(issueRelations).values({ issueId: row!.id, relatedIssueId: issue!.id });
        f.engine.running.clear();
      }
      if (mode === "symlink") {
        await rename(root, `${root}-preserved`);
        const outside = path.join(f.root, "outside");
        await mkdir(outside);
        await writeFile(path.join(outside, "evidence.txt"), "outside");
        await symlink(outside, root);
      }
      const deleted = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}`, headers });
      assert.equal(deleted.statusCode, mode === "success" ? 204 : mode === "rollback" ? 500 : 409, deleted.body);
      const remaining = await db.db.select().from(issues).where(eq(issues.id, issue!.id));
      if (mode === "success") {
        assert.deepEqual(remaining, []);
        assert.equal(await pathExists(root), false);
        for (const table of [issueComments, issuePins, issueWorkspaces]) assert.deepEqual(await db.db.select().from(table), []);
        assert.deepEqual(await readdir(path.join(f.root, "control", "deletions")), []);
        assert.equal((await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}`, headers })).statusCode, 404);
        assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
      } else {
        assert.equal(remaining.length, 1);
        assert.equal(await readFile(path.join(root, "evidence.txt"), "utf8"), mode === "symlink" ? "outside" : "durable work");
        if (mode === "rollback") {
          assert.deepEqual(await readdir(path.join(f.root, "control", "deletions")), []);
          await db.client.execute("DROP TRIGGER refuse_delete");
          assert.equal((await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}`, headers })).statusCode, 204);
        }
        if (mode === "symlink") {
          await unlink(root);
          await rename(`${root}-preserved`, root);
        }
      }
    } finally {
      db.close();
      await f.cleanup();
    }
  });
}

test("deletion refuses dirty development worktrees and removes clean registered worktrees without touching the remote", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec("git", args)).stdout.trim();
  try {
    const source = path.join(f.root, "remote");
    await git("init", "-b", "main", source);
    await writeFile(path.join(source, "README.md"), "original\n");
    await git("-C", source, "add", ".");
    await git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
    await createService(f.app, "Devdelete", ["dev"]);
    // API deliberately permits only HTTPS/SSH; this isolated fixture uses a local Git source.
    await db.client.execute("PRAGMA foreign_keys = ON");
    await db.db.update(repositories).set({ url: source });
    const created = await createIssue(f.app, "devdelete", "dev");
    f.engine.running.clear();
    const [issue] = await db.db
      .select()
      .from(issues)
      .where(eq(issues.key, String(created.id)));
    const project = await new IssueProjectManager(db.db, f.root).prepare(issue!, "dev");
    const file = path.join(project.repositories[0]!.workspacePath, "README.md");
    await writeFile(file, "dirty\n");
    const refused = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}` });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(await readFile(file, "utf8"), "dirty\n");
    await writeFile(file, "original\n");
    await db.client.execute("CREATE TRIGGER refuse_development_delete BEFORE DELETE ON issues BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    const failed = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}` });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(await readFile(file, "utf8"), "original\n");
    assert.equal(await git("-C", project.repositories[0]!.workspacePath, "branch", "--show-current"), project.repositories[0]!.workingBranch);
    await db.client.execute("DROP TRIGGER refuse_development_delete");
    const deleted = await f.app.inject({ method: "DELETE", url: `/api/issues/${issue!.key}` });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal(await pathExists(issueRoot(f.root, issue!.key)), false);
    assert.equal(await readFile(path.join(source, "README.md"), "utf8"), "original\n");
    assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally {
    db.close();
    await f.cleanup();
  }
});

test("post-commit cleanup failure reports failure and preserves staged evidence, not a fictitious DB rollback", { skip: process.getuid?.() === 0 }, async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  let protectedPath: string | undefined;
  try {
    await createService(f.app, "Cleanup");
    const created = await createIssue(f.app, "cleanup", "test");
    f.engine.running.clear();
    const root = issueRoot(f.root, String(created.id));
    protectedPath = path.join(root, "protected");
    await mkdir(protectedPath);
    await writeFile(path.join(protectedPath, "evidence.txt"), "retained");
    await chmod(protectedPath, 0o000);
    const response = await f.app.inject({ method: "DELETE", url: `/api/issues/${created.id}` });
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(await db.db.select().from(issues), []);
    assert.equal(await pathExists(root), false);
    const stagingRoot = path.join(f.root, "control", "deletions");
    const staged = await readdir(stagingRoot);
    assert.equal(staged.length, 1);
    protectedPath = path.join(stagingRoot, staged[0]!, "protected");
    await chmod(protectedPath, 0o700);
    assert.equal(await readFile(path.join(protectedPath, "evidence.txt"), "utf8"), "retained");
    assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally {
    if (protectedPath && (await pathExists(protectedPath))) await chmod(protectedPath, 0o700);
    db.close();
    await f.cleanup();
  }
});

test("abort API requires an active identity and keeps the Issue", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Abort");
    const issue = await createIssue(f.app, "abort", "test");
    const rejected = await f.app.inject({ method: "POST", url: `/api/issues/${issue.id}/abort`, headers: { "x-issue-pilot-subject": "missing" } });
    assert.equal(rejected.statusCode, 400);
    const response = await f.app.inject({ method: "POST", url: `/api/issues/${issue.id}/abort` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.engine.running.size, 0);
    assert.equal(f.engine.closedSessions.length, 0);
    assert.equal((await f.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).statusCode, 200);
  } finally {
    await f.cleanup();
  }
});
