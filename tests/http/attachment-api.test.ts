import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { openDatabase } from "../../src/db/client.ts";
import { issueAttachmentRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createService, issuePayload, json } from "./fixture.ts";

function issueMultipart(boundary: string, issue: Record<string, unknown>, fileName: string, content: string): Buffer {
  return Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="issue"',
    "",
    JSON.stringify(issue),
    `--${boundary}`,
    `Content-Disposition: form-data; name="files"; filename="${fileName}"`,
    "Content-Type: text/plain",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n"));
}

test("creates initial attachments atomically and rolls back the claimed Issue root", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const boundary = "create-attachment";
    const payload = issuePayload("alpha", "test", "Issue with evidence");
    const body = issueMultipart(boundary, payload, "initial.txt", "initial evidence");
    const beforeDirectories = await readdir(path.join(fixture.root, "issues")).catch(() => []);
    const database = openDatabase(fixture.databaseFile);
    await database.client.execute("CREATE TRIGGER fail_initial_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_initial_attachment_failure'); END");
    const failed = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(failed.statusCode, 500);
    await database.client.execute("DROP TRIGGER fail_initial_attachment_insert");
    await database.close();
    assert.deepEqual((await readdir(path.join(fixture.root, "issues"))).sort(), beforeDirectories.sort());
    assert.equal(fixture.engine.enqueued.length, 0);

    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(created.statusCode, 201, created.body);
    const issue = await json(created);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ id: string; fileName: string; sha256: string }> };
    assert.deepEqual(detail.attachments.map(({ fileName }) => fileName), ["initial.txt"]);
    assert.equal(detail.attachments[0]!.sha256, createHash("sha256").update("initial evidence").digest("hex"));
    const files = await readdir(issueAttachmentRoot(fixture.root, String(issue.id)));
    assert.equal(files.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("edits metadata and attachment replacement as one rollback-safe transaction", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const createBoundary = "create-attachment";
    const create = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${createBoundary}` }, payload: issueMultipart(createBoundary, issuePayload("alpha"), "initial.txt", "initial evidence") });
    const issue = await json(create);
    const issueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.delete(issueId);
    const created = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ id: string }> };
    const edit = { title: "Updated", description: "Atomic edit", priority: "p2", assigneeSubject: null, ccSubjects: [], removedAttachmentIds: [created.attachments[0]!.id] };
    const boundary = "replace-attachment";
    const updated = await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: issueMultipart(boundary, edit, "replacement.txt", "replacement evidence") });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.match(fixture.engine.messages.at(-1) ?? "", /replacement\.txt/);
    assert.doesNotMatch(fixture.engine.messages.at(-1) ?? "", /initial\.txt/);
    fixture.engine.running.delete(issueId);

    const current = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { title: string; attachments: Array<{ id: string; fileName: string }> };
    const failingDatabase = openDatabase(fixture.databaseFile);
    await failingDatabase.client.execute("CREATE TRIGGER fail_atomic_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_atomic_edit_failure'); END");
    const failedBoundary = "failed-replacement";
    const failed = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${failedBoundary}` },
      payload: issueMultipart(failedBoundary, { ...edit, title: "Must roll back", removedAttachmentIds: [current.attachments[0]!.id] }, "must-not-persist.txt", "failed replacement"),
    });
    assert.equal(failed.statusCode, 500);
    await failingDatabase.client.execute("DROP TRIGGER fail_atomic_attachment_insert");
    await failingDatabase.close();
    const after = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { title: string; attachments: Array<{ fileName: string }> };
    assert.equal(after.title, "Updated");
    assert.deepEqual(after.attachments.map(({ fileName }) => fileName), ["replacement.txt"]);
    const attachmentRoot = issueAttachmentRoot(fixture.root, String(issue.id));
    const files = await readdir(attachmentRoot);
    assert.equal(files.length, 1);
    assert.equal(await readFile(path.join(attachmentRoot, files[0]!), "utf8"), "replacement evidence");
  } finally {
    await fixture.cleanup();
  }
});

test("serves only verified attachment files and exposes no independent write routes", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const boundary = "download-attachment";
    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: issueMultipart(boundary, issuePayload("alpha"), "evidence.txt", "evidence") });
    const issue = await json(created);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { attachments: Array<{ id: string }> };
    const attachmentId = detail.attachments[0]!.id;
    const download = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/${attachmentId}` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "evidence");
    assert.match(String(download.headers["content-disposition"]), /^inline;/);
    assert.equal(download.headers["cache-control"], "private, no-store");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/missing` })).statusCode, 404);

    const root = issueAttachmentRoot(fixture.root, String(issue.id));
    const file = path.join(root, (await readdir(root))[0]!);
    await chmod(file, 0o600);
    await writeFile(file, "evidencf", "utf8");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/${attachmentId}` })).statusCode, 500);
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/sync` })).statusCode, 404);
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/attachments` })).statusCode, 404);
    assert.equal((await fixture.app.inject({ method: "DELETE", url: `/api/issues/${issue.id}/attachments`, payload: { attachmentIds: [attachmentId] } })).statusCode, 404);
  } finally {
    await fixture.cleanup();
  }
});

test("streams Issue attachments larger than the former application limit", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha") });
    const issue = await json(created);
    fixture.engine.running.clear();
    const boundary = "oversized-attachment";
    const edit = { title: "Updated", description: "", priority: "p2", assigneeSubject: null, ccSubjects: [] };
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="issue"\r\n\r\n${JSON.stringify(edit)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="oversized.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        Buffer.alloc(20 * 1024 * 1024 + 1),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(response.statusCode, 200, response.body);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((current) => JSON.parse(current.body)) as { attachments: Array<{ fileName: string; size: number }> };
    assert.deepEqual(detail.attachments.map(({ fileName, size }) => ({ fileName, size })), [{ fileName: "oversized.bin", size: 20 * 1024 * 1024 + 1 }]);
  } finally {
    await fixture.cleanup();
  }
});
