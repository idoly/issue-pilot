import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse as parseDisposition } from "content-disposition";
import { eq } from "drizzle-orm";
import { createApiFixture, createIssue, createService, issuePayload } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issueRepositories, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { repositoryStorePath, retainedSnapshotRef, WorktreeManager } from "../../src/workspace/git.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { issueRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";
import { IssueWorkFileStore } from "../../src/workspace/work-files.ts";

test("serves current work files with exact names and traversal checks", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["test"]);
    const issue = await createIssue(fixture.app, "files", "test", "Working files");
    const key = String(issue.id),
      root = issueRoot(fixture.root, key);
    const base = `/api/issues/${key}/files`;
    assert.deepEqual((await fixture.app.inject({ method: "GET", url: base })).json(), []);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "结果 #1.xlsx"), Buffer.from([0, 255, 1]));
    await writeFile(path.join(root, " leading and trailing .txt "), "preserved spaces");
    await writeFile(path.join(fixture.root, "secret"), "private");
    await symlink(path.join(fixture.root, "secret"), path.join(root, "escape"));
    const listed = await fixture.app.inject({ method: "GET", url: base });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().find((file: { name: string }) => file.name === "结果 #1.xlsx").kind, "file");
    const download = await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent("结果 #1.xlsx")}` });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, Buffer.from([0, 255, 1]));
    const spaced = await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent(" leading and trailing .txt ")}` });
    assert.equal(spaced.statusCode, 200);
    assert.equal(spaced.body, "preserved spaces");
    assert.equal(parseDisposition(String(download.headers["content-disposition"])).parameters.filename, "结果 #1.xlsx");
    for (const fileName of ["预算 '()*%.txt", 'reader "quoted".txt', "line\r\nbreak.txt"]) {
      await writeFile(path.join(root, fileName), "exact filename bytes");
      const response = await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent(fileName)}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body, "exact filename bytes");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      const header = String(response.headers["content-disposition"]);
      assert.equal(parseDisposition(header).type, "attachment");
      assert.equal(parseDisposition(header).parameters.filename, fileName);
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(header);
      if (encoded) assert.match(encoded[1]!, /^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9a-f]{2})*$/i);
    }
    for (const selected of ["../secret", "escape", ".git/config"]) {
      const result = await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent(selected)}` });
      assert.equal(result.statusCode, 400);
      assert.doesNotMatch(result.body, /private/);
    }
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${key}` })).json();
    assert.equal(detail.workingDirectory, root);
    assert.equal("outputs" in detail, false);
    assert.deepEqual(detail.attachments, []);
    await rm(path.join(root, "结果 #1.xlsx"));
    assert.equal((await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent("结果 #1.xlsx")}` })).statusCode, 404);
  } finally {
    await fixture.cleanup();
  }
});

test("work file APIs distinguish missing paths, non-directory ancestors and symlink loops without leaking paths", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Paths", ["test"]);
    const issue = await createIssue(fixture.app, "paths", "test", "Path errors");
    const root = issueRoot(fixture.root, String(issue.id)),
      base = `/api/issues/${issue.id}/files`;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "regular.txt"), "fixture");
    await symlink("loop", path.join(root, "loop"));
    for (const [selected, status] of [
      ["missing", 404],
      ["regular.txt/child", 404],
      ["loop", 400],
    ] as const) {
      for (const resource of [base, `${base}/download`]) {
        const response = await fixture.app.inject({ method: "GET", url: `${resource}?path=${encodeURIComponent(selected)}` });
        assert.equal(response.statusCode, status, response.body);
        assert.equal(response.body.includes(fixture.root), false);
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

test("work file APIs report a missing or redirected durable Issue root", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Root loss", ["test"]);
    const issue = await createIssue(fixture.app, "root-loss", "test", "Missing working root");
    const root = issueRoot(fixture.root, String(issue.id));
    const base = `/api/issues/${issue.id}/files`;
    await rm(root, { recursive: true });
    for (const resource of [base, `${base}/download?path=evidence.txt`]) {
      const response = await fixture.app.inject({ method: "GET", url: resource });
      assert.equal(response.statusCode, 500, response.body);
      assert.deepEqual(response.json(), { error: "issue_root_missing" });
    }
    await symlink(fixture.root, root);
    const redirected = await fixture.app.inject({ method: "GET", url: base });
    assert.equal(redirected.statusCode, 500, redirected.body);
    assert.deepEqual(redirected.json(), { error: "invalid_issue_root" });
  } finally {
    await fixture.cleanup();
  }
});

test("ready work file APIs report root loss or redirection before resolving repository read roots", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Ready root loss", ["test"]);
    const issue = await createIssue(fixture.app, "ready-root-loss", "test", "Ready root loss");
    const database = openDatabase(fixture.databaseFile);
    try {
      const [record] = await database.db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.key, String(issue.id)));
      assert.ok(record);
      await database.db
        .insert(issueRepositories)
        .values({ id: randomUUID(), issueId: record.id, url: "https://example.test/ready-root-loss.git", baseBranch: "main", workspaceName: "ready-root-loss" });
      await database.db.update(issueWorkspaces).set({ runtimeReady: true }).where(eq(issueWorkspaces.issueId, record.id));
    } finally {
      await database.close();
    }
    const root = issueRoot(fixture.root, String(issue.id));
    await rm(root, { recursive: true });
    const base = `/api/issues/${issue.id}/files`;
    for (const resource of [base, `${base}/download?path=evidence.txt`]) {
      const response = await fixture.app.inject({ method: "GET", url: resource });
      assert.equal(response.statusCode, 500, response.body);
      assert.deepEqual(response.json(), { error: "issue_root_missing" });
    }
    await symlink(fixture.root, root);
    for (const resource of [base, `${base}/download?path=evidence.txt`]) {
      const response = await fixture.app.inject({ method: "GET", url: resource });
      assert.equal(response.statusCode, 500, response.body);
      assert.deepEqual(response.json(), { error: "invalid_issue_root" });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("current downloads ignore migration indexes and expose updated working bytes", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["prod"]);
    const issue = await createIssue(fixture.app, "files", "prod", "Current download");
    const key = String(issue.id),
      root = issueRoot(fixture.root, key);
    const workFiles = new IssueWorkFileStore(fixture.root, key);
    await workFiles.generate("orders.csv", async (append) => {
      await append("count\n3\n");
    });
    await writeFile(path.join(root, ".legacy-output-links.json"), "invalid historical index");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${key}` })).statusCode, 200);
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${key}/outputs/orders.csv` })).statusCode, 404);
    const download = `/api/issues/${key}/files/download?path=orders.csv`;
    const first = await fixture.app.inject({ method: "GET", url: download });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["cache-control"], "private, no-store");
    assert.equal(first.body, "count\n3\n");
    await workFiles.generate("orders.csv", async (append) => {
      await append("count\n4\n");
    });
    assert.equal((await fixture.app.inject({ method: "GET", url: download })).body, "count\n4\n");
  } finally {
    await fixture.cleanup();
  }
});

test("a related Issue whose checkouts cannot be resolved does not block the primary Issue's files", async (context) => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["test"]);
    const related = await createIssue(fixture.app, "files", "test", "Related evidence");
    fixture.engine.running.clear();
    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("files", "test", "Primary"), relatedIssueKeys: [related.id] } });
    assert.equal(created.statusCode, 201, created.body);
    const key = String(created.json().id);
    await mkdir(issueRoot(fixture.root, key), { recursive: true });
    await writeFile(path.join(issueRoot(fixture.root, key), "own.txt"), "primary evidence");
    const readRoots = SourceBrowser.prototype.workFileRepositories;
    context.mock.method(SourceBrowser.prototype, "workFileRepositories", async function (this: SourceBrowser, issue: { id: string; key: string }) {
      if (issue.key === related.id) throw new Error("source_git_binding_invalid");
      return readRoots.call(this, issue);
    });
    const listed = await fixture.app.inject({ method: "GET", url: `/api/issues/${key}/files` });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.ok(listed.json().some((file: { name: string }) => file.name === "own.txt"));
  } finally {
    await fixture.cleanup();
  }
});

test("released source and work file routes work without per-Issue checkout links", async () => {
  const fixture = await createApiFixture();
  try {
    const remote = path.join(fixture.root, "fixture-repo");
    const git = (...args: string[]) => execFileSync("git", args);
    git("init", "-b", "main", remote);
    await writeFile(path.join(remote, "source.txt"), "original code");
    git("-C", remote, "add", ".");
    git("-C", remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
    await createService(fixture.app, "Released files", ["prod", "dev"]);
    const issue = await createIssue(fixture.app, "released-files", "dev");
    fixture.engine.running.clear();
    const key = String(issue.id);
    const root = issueRoot(fixture.root, key);
    const base = `/api/issues/${key}`;
    const prepared = await new WorktreeManager(fixture.root).prepare({ issueKey: key, url: remote, baseBranch: "main", mode: "hotfix", workspaceName: "repo" });
    const db = openDatabase(fixture.databaseFile);
    try {
      const [record] = await db.db.select().from(issues).where(eq(issues.key, key));
      await db.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, record!.id));
      await db.db.insert(issueRepositories).values({
        issueId: record!.id,
        url: remote,
        baseBranch: "main",
        workingBranch: prepared.workingBranch,
        localPath: prepared.workspacePath,
        workspaceName: "repo",
        commitBefore: prepared.baseCommit,
      });
      await db.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, record!.id));
    } finally {
      await db.close();
    }
    await writeFile(path.join(root, "notes.txt"), "ordinary work file");
    const release = await fixture.app.inject({ method: "DELETE", url: `${base}/workspace` });
    assert.equal(release.statusCode, 200, release.body);
    assert.equal(release.json().alreadyReleased, false);
    await assert.rejects(lstat(prepared.workspacePath), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(root, ".issue-runtime.json")), { code: "ENOENT" });
    assert.equal((await fixture.app.inject({ url: base })).json().workspace.sourceAvailable, true);
    // A previous release may have committed its marker before retaining the checkout ref.
    const shared = repositoryStorePath(fixture.root, remote);
    git("-C", shared, "update-ref", "-d", retainedSnapshotRef(prepared.baseCommit));

    const source = await fixture.app.inject({ url: `${base}/source/file`, headers: { "x-issue-pilot-repository": "repo", "x-issue-pilot-path": "source.txt" } });
    assert.equal(source.statusCode, 200, source.body);
    assert.equal(source.json().content, "original code");
    const files = await fixture.app.inject({ url: `${base}/files` });
    assert.equal(files.statusCode, 200, files.body);
    assert.ok(files.json().some((entry: { path: string; kind: string }) => entry.path === "repo" && entry.kind === "directory"));
    const checkout = path.join(sharedCheckoutsRoot(fixture.root), path.basename(repositoryStorePath(fixture.root, remote)), prepared.baseCommit);
    await assert.rejects(lstat(checkout), { code: "ENOENT" });
    const download = await fixture.app.inject({ url: `${base}/files/download?path=repo/source.txt` });
    assert.equal(download.statusCode, 200, download.body);
    assert.equal(download.body, "original code");
    assert.ok((await lstat(checkout)).isDirectory());
    await assert.rejects(lstat(prepared.workspacePath), { code: "ENOENT" });
    const related = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("released-files", "prod"), relatedIssueKeys: [key] } });
    assert.equal(related.statusCode, 201, related.body);
    const prefix = `.related-${key.toLowerCase()}`;
    await symlink(root, path.join(issueRoot(fixture.root, related.json().id), prefix));
    const relatedRead = await fixture.app.inject({ url: `/api/issues/${related.json().id}/files/download?path=${prefix}/repo/source.txt` });
    assert.equal(relatedRead.statusCode, 200, relatedRead.body);
    assert.equal(relatedRead.body, "original code");

    const branchRef = `refs/heads/${prepared.workingBranch}`;
    git("-C", prepared.cachePath, "update-ref", "-d", branchRef);
    const missingBranch = await fixture.app.inject({ url: `${base}/source/file`, headers: { "x-issue-pilot-repository": "repo", "x-issue-pilot-path": "source.txt" } });
    assert.equal(missingBranch.statusCode, 409, missingBranch.body);
    assert.equal(missingBranch.json().error, "source_git_binding_invalid");
    git("-C", prepared.cachePath, "update-ref", branchRef, prepared.baseCommit);

    await writeFile(prepared.workspacePath, "unknown evidence");
    const blocked = await fixture.app.inject({ url: `${base}/files/download?path=repo/source.txt` });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal((await fixture.app.inject({ url: `${base}/files/download?path=notes.txt` })).body, "ordinary work file");
  } finally {
    await fixture.cleanup();
  }
});
