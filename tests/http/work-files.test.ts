import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { parse as parseDisposition } from "content-disposition";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { IssueWorkFileStore } from "../../src/workspace/work-files.ts";

test("serves current work files with exact names and traversal checks", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["test"]);
    const issue = await createIssue(fixture.app, "files", "test", "Working files");
    const key = String(issue.id), root = issueRoot(fixture.root, key);
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
  } finally { await fixture.cleanup(); }
});

test("work file APIs distinguish missing paths, non-directory ancestors and symlink loops without leaking paths", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Paths", ["test"]);
    const issue = await createIssue(fixture.app, "paths", "test", "Path errors");
    const root = issueRoot(fixture.root, String(issue.id)), base = `/api/issues/${issue.id}/files`;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "regular.txt"), "fixture");
    await symlink("loop", path.join(root, "loop"));
    for (const [selected, status] of [["missing", 404], ["regular.txt/child", 404], ["loop", 400]] as const) {
      for (const resource of [base, `${base}/download`]) {
        const response = await fixture.app.inject({ method: "GET", url: `${resource}?path=${encodeURIComponent(selected)}` });
        assert.equal(response.statusCode, status, response.body);
        assert.equal(response.body.includes(fixture.root), false);
      }
    }
  } finally { await fixture.cleanup(); }
});

test("current downloads ignore migration indexes and expose updated working bytes", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Files", ["prod"]);
    const issue = await createIssue(fixture.app, "files", "prod", "Current download");
    const key = String(issue.id), root = issueRoot(fixture.root, key);
    const workFiles = new IssueWorkFileStore(fixture.root, key);
    await workFiles.generate("orders.csv", async append => { await append("count\n3\n"); });
    await writeFile(path.join(root, ".legacy-output-links.json"), "invalid historical index");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${key}` })).statusCode, 200);
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${key}/outputs/orders.csv` })).statusCode, 404);
    const download = `/api/issues/${key}/files/download?path=orders.csv`;
    const first = await fixture.app.inject({ method: "GET", url: download });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["cache-control"], "private, no-store");
    assert.equal(first.body, "count\n3\n");
    await workFiles.generate("orders.csv", async append => { await append("count\n4\n"); });
    assert.equal((await fixture.app.inject({ method: "GET", url: download })).body, "count\n4\n");
  } finally { await fixture.cleanup(); }
});
