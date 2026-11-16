import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/db/client.ts";
import { issueRepositories, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { repositoryStorePath, WorktreeManager } from "../../src/workspace/git.ts";
import { issueRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";
import { git } from "../helpers/git.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

for (const state of ["development_workspace", "development_snapshot", "read_only"] as const)
  test(`source reads preserve filesystem failures and recover after repair in ${state}`, async (context) => {
    const fixture = await createApiFixture();
    try {
      const remote = path.join(fixture.root, "fixture-repo");
      await git(["init", "-b", "main", remote]);
      await fs.writeFile(path.join(remote, "source.txt"), "original code");
      await git(["-C", remote, "add", "."]);
      await git(["-C", remote, "commit", "-m", "baseline"]);
      await createService(fixture.app, "Source failures", ["prod", "dev"]);
      const issue = await createIssue(fixture.app, "source-failures", state === "read_only" ? "prod" : "dev");
      const key = String(issue.id),
        root = issueRoot(fixture.root, key),
        base = `/api/issues/${key}`;
      assert.equal((await fixture.app.inject({ method: "POST", url: `${base}/abort` })).statusCode, 200);
      const manager = new WorktreeManager(fixture.root);
      const prepared =
        state === "read_only"
          ? await manager.prepareShared({ url: remote, baseBranch: "main" })
          : await manager.prepare({ issueKey: key, url: remote, baseBranch: "main", mode: "hotfix", workspaceName: "repo" });
      const shared = repositoryStorePath(fixture.root, remote);
      const checkout = path.join(sharedCheckoutsRoot(fixture.root), path.basename(shared), prepared.baseCommit);
      if (state === "read_only") {
        await fs.symlink(prepared.workspacePath, path.join(root, "repo"));
        assert.equal(await manager.evictSharedCheckout({ checkout, commit: prepared.baseCommit, commonDirectory: shared }), true);
      }
      const database = openDatabase(fixture.databaseFile);
      try {
        const [record] = await database.db.select().from(issues).where(eq(issues.key, key));
        await database.db.insert(issueRepositories).values({
          issueId: record!.id,
          url: remote,
          baseBranch: "main",
          workspaceName: "repo",
          commitBefore: prepared.baseCommit,
          workingBranch: prepared.workingBranch,
          localPath: state === "read_only" ? null : prepared.workspacePath,
        });
        await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, record!.id));
        if (state === "development_snapshot") await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, record!.id));
      } finally {
        database.close();
      }
      if (state === "development_snapshot") {
        const released = await fixture.app.inject({ method: "DELETE", url: `${base}/workspace` });
        assert.equal(released.statusCode, 200, released.body);
      }
      const read = (resource = "file") =>
        fixture.app.inject({
          url: `${base}/source/${resource}`,
          headers: {
            "x-issue-pilot-repository": "repo",
            ...(resource === "file" ? { "x-issue-pilot-path": "source.txt" } : {}),
          },
        });
      const targets = new Set(state === "development_workspace" ? [root, prepared.workspacePath, prepared.cachePath] : [root, prepared.cachePath, shared, checkout]);
      for (const code of ["EIO", "EACCES"] as const) {
        for (const target of targets) {
          const failure = Object.assign(new Error(`private fixture path: ${target}`), { code });
          const lstat = fs.lstat;
          context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
            if (args[0] === target) throw failure;
            return lstat(...args);
          });
          syncBuiltinESMExports();
          try {
            for (const resource of ["file", "tree"]) {
              const response = await read(resource);
              assert.equal(response.statusCode, 500, `${state}/${code}/${target}: ${response.body}`);
              assert.deepEqual(response.json(), { error: "internal_error" });
              assert.equal(response.body.includes(fixture.root), false);
            }
          } finally {
            context.mock.restoreAll();
            syncBuiltinESMExports();
          }
          const retry = await read();
          assert.equal(retry.statusCode, 200, retry.body);
          assert.equal(retry.json().content, "original code");
        }
        if (state !== "development_workspace") {
          context.mock.method(WorktreeManager.prototype, "assertSnapshotCommit", async () => {
            throw new Error("snapshot verification failed", { cause: Object.assign(new Error("private I/O detail"), { code }) });
          });
          try {
            const response = await read();
            assert.equal(response.statusCode, 500, response.body);
            assert.deepEqual(response.json(), { error: "internal_error" });
          } finally {
            context.mock.restoreAll();
          }
          assert.equal((await read()).statusCode, 200);
        }
      }
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fixture.cleanup();
    }
  });
