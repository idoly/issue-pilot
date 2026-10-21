import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issueRoot, issueWorkDirectory } from "../../src/workspace/state.ts";

test("offline migration refuses a live API, preserves a plan-only run and supports repeated application", async () => {
  const fixture = await createApiFixture();
  const run = promisify(execFile);
  try {
    await createService(fixture.app, "Migration", ["test"]);
    const issue = await createIssue(fixture.app, "migration", "test", "Legacy work");
    fixture.engine.running.clear();
    const key = String(issue.id), oldRoot = path.join(issueRoot(fixture.root, key), "work");
    await mkdir(oldRoot, { recursive: true });
    await writeFile(path.join(oldRoot, "checkpoint.json"), "{}");
    const args = ["--experimental-strip-types", "scripts/migrate-issue-work.ts", "--state-root", fixture.root];
    const plan = await run(process.execPath, args);
    assert.equal(JSON.parse(plan.stdout.trim()).entries, 1);
    await assert.rejects(run(process.execPath, [...args, "--apply"]), error => error instanceof Error && /EADDRINUSE/.test(String((error as { stderr?: string }).stderr)));
    assert.equal(await readFile(path.join(oldRoot, "checkpoint.json"), "utf8"), "{}");
    await fixture.stop();
    await run(process.execPath, [...args, "--apply"]);
    assert.equal(await readFile(path.join(issueWorkDirectory(fixture.root, key), "checkpoint.json"), "utf8"), "{}");
    const repeated = await run(process.execPath, [...args, "--apply"]);
    assert.equal(JSON.parse(repeated.stdout.trim().split("\n")[0]!).entries, 0);
  } finally { await fixture.cleanup(); }
});

test("serves working files separately from attachments and published deliveries", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["test"]);
    const issue = await createIssue(fixture.app, "files", "test", "Working files");
    const key = String(issue.id), root = issueWorkDirectory(fixture.root, key);
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
    assert.match(String(download.headers["content-disposition"]), /attachment; filename\*=UTF-8''/);
    for (const selected of ["../secret", "escape", ".git/config"]) {
      const result = await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent(selected)}` });
      assert.equal(result.statusCode, 400);
      assert.doesNotMatch(result.body, /private/);
    }
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${key}` })).json();
    assert.equal(detail.workingDirectory, root);
    assert.deepEqual(detail.outputs, []);
    assert.deepEqual(detail.attachments, []);
    await rm(path.join(root, "结果 #1.xlsx"));
    assert.equal((await fixture.app.inject({ method: "GET", url: `${base}/download?path=${encodeURIComponent("结果 #1.xlsx")}` })).statusCode, 404);
  } finally { await fixture.cleanup(); }
});
