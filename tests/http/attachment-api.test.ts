import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fsPromises, { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { parse as parseDisposition } from "content-disposition";
import type { FastifyReply, FastifyRequest } from "fastify";

import { openDatabase } from "../../src/db/client.ts";
import { registerAttachmentRoutes } from "../../src/http/attachment-routes.ts";
import type { ApiRouteContext } from "../../src/http/route-context.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { issueEditVersion, createApiFixture, createIssue, createService, issueMetadataPayload, issuePayload, json } from "./fixture.ts";

function issueMultipart(boundary: string, issue: Record<string, unknown>, fileName: string, content: string): Buffer {
  return Buffer.from(
    [
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
    ].join("\r\n"),
  );
}

test("inactive subjects are rejected before multipart staging on create and edit", async (context) => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Identity staging");
    const existing = await createIssue(fixture.app, "identity-staging");
    let staged = 0;
    context.mock.method(fsPromises, "mkdtemp", async () => {
      staged++;
      throw new Error("fixture-staging-must-not-run");
    });
    syncBuiltinESMExports();
    for (const [method, url, input] of [
      ["POST", "/api/issues", issuePayload("identity-staging")],
      ["PATCH", `/api/issues/${existing.id}`, issueMetadataPayload("Unauthorized edit")],
    ] as const) {
      const boundary = "invalid-subject-upload";
      const response = await fixture.app.inject({
        method,
        url,
        headers: { "x-issue-pilot-subject": "inactive", "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: issueMultipart(boundary, input, "evidence.txt", "private evidence"),
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, "invalid_current_subject");
    }
    assert.equal(staged, 0);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fixture.cleanup();
  }
});

for (const state of ["missing", "symlink"] as const)
  test(`attachment edits refuse a ${state} Issue root without writing or adopting another directory`, async () => {
    const fixture = await createApiFixture();
    try {
      await createService(fixture.app, "AttachmentRoot");
      const issue = await createIssue(fixture.app, "attachmentroot", "test", "Original metadata");
      fixture.engine.running.clear();
      const root = issueRoot(fixture.root, String(issue.id));
      const preserved = path.join(fixture.root, "preserved-issue-root");
      await fsPromises.rename(root, preserved);
      await fsPromises.chmod(preserved, 0o750);
      await writeFile(path.join(preserved, "evidence.txt"), "preserved evidence");
      if (state === "symlink") await fsPromises.symlink(preserved, root);
      const queued = fixture.engine.enqueued.length;
      const boundary = "invalid-attachment-root";
      const response = await fixture.app.inject({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: issueMultipart(boundary, { ...issueMetadataPayload("Must not persist"), expectedEditVersion: await issueEditVersion(fixture.app, issue.id) }, "new.txt", "new evidence"),
      });
      assert.equal(response.statusCode, 500, response.body);
      const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json<{ title: string; attachments: unknown[] }>();
      assert.equal(detail.title, "Original metadata");
      assert.deepEqual(detail.attachments, []);
      assert.equal(fixture.engine.enqueued.length, queued);
      assert.deepEqual(await readdir(preserved), ["evidence.txt"]);
      assert.equal((await fsPromises.lstat(preserved)).mode & 0o777, 0o750);
      assert.equal(await readFile(path.join(preserved, "evidence.txt"), "utf8"), "preserved evidence");
      if (state === "missing") await assert.rejects(fsPromises.lstat(root), { code: "ENOENT" });
      else {
        assert.equal(await fsPromises.readlink(root), preserved);
        await fsPromises.unlink(root);
      }
      // An operator restoring the original directory permits a normal retry.
      await fsPromises.rename(preserved, root);
      const retry = await fixture.app.inject({
        method: "PATCH",
        url: `/api/issues/${issue.id}`,
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: issueMultipart(boundary, { ...issueMetadataPayload("Saved after restoration"), expectedEditVersion: await issueEditVersion(fixture.app, issue.id) }, "new.txt", "new evidence"),
      });
      assert.equal(retry.statusCode, 200, retry.body);
      const saved = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json<{ attachments: Array<{ id: string }> }>();
      assert.equal(saved.attachments.length, 1);
      const download = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/${saved.attachments[0]!.id}` });
      assert.equal(download.statusCode, 200, download.body);
      assert.equal(download.body, "new evidence");
    } finally {
      await fixture.cleanup();
    }
  });

for (const closeFails of [false, true])
  test(`cancelled attachment downloads retain cleanup diagnostics without sending a response (close fails: ${closeFails})`, async (context) => {
    const fixture = await createApiFixture();
    const database = openDatabase(fixture.databaseFile);
    const open = fsPromises.open;
    const logs: unknown[][] = [];
    let closed = false,
      hijacked = false;
    try {
      await createService(fixture.app, "CancelledDownload");
      const boundary = "cancelled-download";
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/issues",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: issueMultipart(boundary, issuePayload("cancelleddownload"), "evidence.txt", "private evidence"),
      });
      assert.equal(created.statusCode, 201, created.body);
      const issue = created.json<{ id: string }>();
      const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
      const attachment = detail.json<{ attachments: Array<{ id: string; storedFileName: string }> }>().attachments[0]!;
      const file = path.join(issueRoot(fixture.root, issue.id), attachment.storedFileName);
      type DownloadRequest = FastifyRequest<{ Params: { key: string; attachmentId: string } }>;
      let download!: (request: DownloadRequest, reply: FastifyReply) => Promise<unknown>;
      registerAttachmentRoutes({
        app: {
          get(_url: string, handler: typeof download) {
            download = handler;
          },
        },
        database,
        stateRoot: fixture.root,
      } as unknown as ApiRouteContext);
      const raw = Object.assign(new EventEmitter(), { aborted: false });
      const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
      const request = {
        params: { key: issue.id, attachmentId: attachment.id },
        raw,
        log: {
          error(...args: unknown[]) {
            logs.push(args);
          },
        },
      } as unknown as DownloadRequest;
      const reply = {
        raw: response,
        hijack() {
          hijacked = true;
          return this;
        },
        send() {
          assert.fail("a cancelled download must not write a response");
        },
      } as unknown as FastifyReply;
      context.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await open(...args);
        if (args[0] === file) {
          const read = handle.read.bind(handle),
            close = handle.close.bind(handle);
          context.mock.method(handle, "read", async (...args: Parameters<typeof handle.read>) => {
            const value = await read(...args);
            raw.aborted = true;
            raw.emit("aborted");
            return value;
          });
          context.mock.method(handle, "close", async () => {
            await close();
            closed = true;
            if (closeFails) throw Object.assign(new Error(`private close diagnostic: ${file}`), { code: "EIO" });
          });
        }
        return handle;
      });
      syncBuiltinESMExports();
      assert.equal(await download(request, reply), reply);
      assert.equal(closed, true);
      assert.equal(hijacked, true);
      assert.equal(raw.listenerCount("aborted"), 0);
      assert.equal(response.listenerCount("close"), 0);
      if (closeFails) {
        assert.equal(logs.length, 1);
        const diagnostic = JSON.stringify(logs);
        assert.match(diagnostic, /attachment_read_cleanup_failed/);
        assert.match(diagnostic, /EIO/);
        assert.ok(!diagnostic.includes(file));
        assert.ok(!diagnostic.includes("private close diagnostic"));
      } else assert.deepEqual(logs, []);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      database.close();
      await fixture.cleanup();
    }
  });

for (const fileName of ["a".repeat(251) + ".txt", "界".repeat(80) + ".txt", "预算 '()*%.txt"])
  test(`preserves attachment names, filesystem limits and valid disposition (${Buffer.byteLength(fileName)} UTF-8 bytes)`, async () => {
    const fixture = await createApiFixture();
    try {
      await createService(fixture.app, "Long names");
      const boundary = "long-attachment-name",
        content = "long filename evidence";
      const created = await fixture.app.inject({
        method: "POST",
        url: "/api/issues",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: issueMultipart(boundary, issuePayload("long-names"), fileName, content),
      });
      assert.equal(created.statusCode, 201, created.body);
      const issue = await json(created);
      const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => response.json<{ attachments: Array<{ id: string; fileName: string }> }>());
      assert.equal(detail.attachments[0]!.fileName, fileName);
      const root = issueRoot(fixture.root, String(issue.id)),
        files = await readdir(root);
      assert.equal(files.length, 1);
      assert.ok(Buffer.byteLength(files[0]!) <= 255);
      assert.equal(path.extname(files[0]!), ".txt");
      assert.ok(!files[0]!.includes("\ufffd"));
      const download = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/${detail.attachments[0]!.id}` });
      assert.equal(download.statusCode, 200, download.body);
      assert.equal(download.body, content);
      const header = String(download.headers["content-disposition"]);
      assert.equal(parseDisposition(header).type, "inline");
      assert.equal(parseDisposition(header).parameters.filename, fileName);
      const encoded = /filename\*=UTF-8''([^;]+)/.exec(header);
      if (encoded) assert.match(encoded[1]!, /^(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9a-f]{2})*$/i);
    } finally {
      await fixture.cleanup();
    }
  });

test("creates initial attachments atomically and rolls back the claimed Issue root", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const boundary = "create-attachment";
    const payload = issuePayload("alpha", "test", "Issue with evidence");
    const body = issueMultipart(boundary, payload, "initial.txt", "initial evidence");
    const beforeDirectories = await readdir(path.join(fixture.root, "workspaces")).catch(() => []);
    const database = openDatabase(fixture.databaseFile);
    await database.client.execute("CREATE TRIGGER fail_initial_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_initial_attachment_failure'); END");
    const failed = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(failed.statusCode, 500);
    await database.client.execute("DROP TRIGGER fail_initial_attachment_insert");
    await database.close();
    assert.deepEqual((await readdir(path.join(fixture.root, "workspaces"))).sort(), beforeDirectories.sort());
    assert.equal(fixture.engine.enqueued.length, 0);

    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(created.statusCode, 201, created.body);
    const issue = await json(created);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as {
      attachments: Array<{ id: string; fileName: string; sha256: string }>;
    };
    assert.deepEqual(
      detail.attachments.map(({ fileName }) => fileName),
      ["initial.txt"],
    );
    assert.equal(detail.attachments[0]!.sha256, createHash("sha256").update("initial evidence").digest("hex"));
    assert.equal("workingFileName" in detail.attachments[0]!, false);
    const saved = openDatabase(fixture.databaseFile);
    try {
      const result = await saved.client.execute("SELECT working_file_name FROM issue_attachments");
      assert.deepEqual(
        result.rows.map((row) => row.working_file_name),
        [null],
      );
    } finally {
      await saved.close();
    }
    const files = await readdir(issueRoot(fixture.root, String(issue.id)));
    assert.equal(files.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("edits metadata and attachment replacement as one rollback-safe transaction", async (context) => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const createBoundary = "create-attachment";
    const create = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${createBoundary}` },
      payload: issueMultipart(createBoundary, issuePayload("alpha"), "initial.txt", "initial evidence"),
    });
    const issue = await json(create);
    const issueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.delete(issueId);
    const created = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as { attachments: Array<{ id: string }> };
    const edit = {
      expectedEditVersion: await issueEditVersion(fixture.app, issue.id),
      title: "Updated",
      description: "Atomic edit",
      priority: "p2",
      assigneeSubject: null,
      ccSubjects: [],
      removedAttachmentIds: [created.attachments[0]!.id],
    };
    const boundary = "replace-attachment";
    const link = fsPromises.link;
    const initialDownloadUrl = `/api/issues/${issue.id}/attachments/${created.attachments[0]!.id}`;
    let preCommitDownloads = 0;
    context.mock.method(fsPromises, "link", async (...args: Parameters<typeof link>) => {
      const read = await fixture.app.inject(initialDownloadUrl);
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.body, "initial evidence");
      preCommitDownloads++;
      await link(...args);
    });
    syncBuiltinESMExports();
    const updated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: issueMultipart(boundary, edit, "replacement.txt", "replacement evidence"),
    });
    context.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(preCommitDownloads, 1);
    assert.equal((await fixture.app.inject(initialDownloadUrl)).statusCode, 404);
    assert.match(fixture.engine.messages.at(-1) ?? "", /replacement\.txt/);
    assert.doesNotMatch(fixture.engine.messages.at(-1) ?? "", /initial\.txt/);
    fixture.engine.running.delete(issueId);

    const current = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as {
      title: string;
      attachments: Array<{ id: string; fileName: string }>;
    };
    const failingDatabase = openDatabase(fixture.databaseFile);
    await failingDatabase.client.execute("CREATE TRIGGER fail_atomic_attachment_insert BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'simulated_atomic_edit_failure'); END");
    const failedBoundary = "failed-replacement";
    const failed = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${failedBoundary}` },
      payload: issueMultipart(
        failedBoundary,
        { ...edit, expectedEditVersion: await issueEditVersion(fixture.app, issue.id), title: "Must roll back", removedAttachmentIds: [current.attachments[0]!.id] },
        "must-not-persist.txt",
        "failed replacement",
      ),
    });
    assert.equal(failed.statusCode, 500);
    await failingDatabase.client.execute("DROP TRIGGER fail_atomic_attachment_insert");
    await failingDatabase.close();
    const after = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as {
      title: string;
      attachments: Array<{ fileName: string }>;
    };
    assert.equal(after.title, "Updated");
    assert.deepEqual(
      after.attachments.map(({ fileName }) => fileName),
      ["replacement.txt"],
    );
    const attachmentRoot = issueRoot(fixture.root, String(issue.id));
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
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: issueMultipart(boundary, issuePayload("alpha"), "evidence.txt", "evidence"),
    });
    const issue = await json(created);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as { attachments: Array<{ id: string }> };
    const attachmentId = detail.attachments[0]!.id;
    const download = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/${attachmentId}` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "evidence");
    assert.match(String(download.headers["content-disposition"]), /^inline;/);
    assert.equal(download.headers["cache-control"], "private, no-store");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/attachments/missing` })).statusCode, 404);

    const root = issueRoot(fixture.root, String(issue.id));
    const file = path.join(root, (await readdir(root))[0]!);
    await chmod(file, 0o600);
    await writeFile(file, "evidencf", "utf8");
    await chmod(file, 0o400);
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
    const edit = { expectedEditVersion: await issueEditVersion(fixture.app, issue.id), title: "Updated", description: "", priority: "p2", assigneeSubject: null, ccSubjects: [] };
    const response = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="issue"\r\n\r\n${JSON.stringify(edit)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="oversized.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.alloc(20 * 1024 * 1024 + 1),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(response.statusCode, 200, response.body);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((current) => JSON.parse(current.body))) as {
      attachments: Array<{ fileName: string; size: number }>;
    };
    assert.deepEqual(
      detail.attachments.map(({ fileName, size }) => ({ fileName, size })),
      [{ fileName: "oversized.bin", size: 20 * 1024 * 1024 + 1 }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("a committed edit retains and retries only recorded attachment cleanup failures", async (context) => {
  const fixture = await createApiFixture();
  const database = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Alpha");
    const createBoundary = "create-attachment";
    const create = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${createBoundary}` },
      payload: issueMultipart(createBoundary, issuePayload("alpha"), "initial.txt", "initial evidence"),
    });
    const issue = await json(create);
    fixture.engine.running.delete(fixture.engine.enqueued.at(-1)!);
    const created = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json<{ attachments: Array<{ id: string; storedFileName: string }> }>();
    const original = path.join(issueRoot(fixture.root, String(issue.id)), created.attachments[0]!.storedFileName);
    const unlink = fsPromises.unlink;
    context.mock.method(fsPromises, "unlink", async (target: string) => {
      if (target === original) throw Object.assign(new Error("simulated_remove_failure"), { code: "EIO" });
      return unlink(target);
    });
    syncBuiltinESMExports();
    const messages = fixture.engine.messages.length;
    const updated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      payload: {
        expectedEditVersion: await issueEditVersion(fixture.app, issue.id),
        title: "Updated",
        description: "",
        priority: "p2",
        assigneeSubject: null,
        ccSubjects: [],
        removedAttachmentIds: [created.attachments[0]!.id],
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(fixture.engine.messages.length, messages + 1);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as { title: string; attachments: unknown[] };
    assert.equal(detail.title, "Updated");
    assert.deepEqual(detail.attachments, []);
    assert.equal((await fixture.app.inject(`/api/issues/${issue.id}/attachments/${created.attachments[0]!.id}`)).statusCode, 404);
    assert.equal(await readFile(original, "utf8"), "initial evidence");
    assert.deepEqual((await database.client.execute("select id, object_key from retired_issue_attachments")).rows, [{ id: created.attachments[0]!.id, object_key: original }]);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.engine.running.clear();
    const unrelated = path.join(path.dirname(original), ".attachment-unknown.txt");
    await writeFile(unrelated, "preserve unknown", { mode: 0o400 });
    const retry = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      payload: { ...issueMetadataPayload("Another edit"), expectedEditVersion: await issueEditVersion(fixture.app, issue.id) },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    await assert.rejects(fsPromises.stat(original), { code: "ENOENT" });
    assert.deepEqual((await database.client.execute("select id from retired_issue_attachments")).rows, []);
    assert.equal(await readFile(unrelated, "utf8"), "preserve unknown");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    database.close();
    await fixture.cleanup();
  }
});

test("publishes the staged attachment inode before the Issue write transaction without making a copy", async (context) => {
  const fixture = await createApiFixture();
  const other = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Alpha");
    const link = fsPromises.link;
    let concurrentWrite: Promise<unknown> | undefined;
    let inode: number | undefined;
    context.mock.method(fsPromises, "link", async (...args: Parameters<typeof link>) => {
      // A writer on another connection must complete before the staged file is published.
      concurrentWrite ??= other.client.execute({ sql: "UPDATE subjects SET display_name = display_name WHERE subject = ?", args: ["nobody"] });
      await concurrentWrite;
      inode = (await fsPromises.stat(args[0])).ino;
      await link(...args);
    });
    syncBuiltinESMExports();
    const boundary = "concurrent-copy";
    const create = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: issueMultipart(boundary, issuePayload("alpha"), "evidence.txt", "copied evidence"),
    });
    assert.equal(create.statusCode, 201, create.body);
    assert.ok(concurrentWrite);
    await concurrentWrite;
    const root = issueRoot(fixture.root, create.json().id);
    const stored = await fsPromises.stat(path.join(root, (await readdir(root))[0]!));
    assert.equal(stored.ino, inode);
    assert.equal(stored.nlink, 1);
    assert.ok(!(await readdir(path.join(fixture.root, "control"))).some((name) => name.startsWith("attachment-upload-")));
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await other.close();
    await fixture.cleanup();
  }
});

test("a committed Issue stays created when removing its upload staging directory fails", async (context) => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    // Keep the deliberately unremoved upload inside the fixture so its final cleanup owns it.
    const createDirectory = fsPromises.mkdtemp;
    context.mock.method(fsPromises, "mkdtemp", () => createDirectory(path.join(fixture.root, "issue-pilot-attachment-")));
    const remove = fsPromises.rm;
    context.mock.method(fsPromises, "rm", async (target: string, options?: Parameters<typeof remove>[1]) => {
      if (path.basename(String(target)).startsWith("issue-pilot-attachment-")) throw Object.assign(new Error("simulated_staging_remove_failure"), { code: "EBUSY" });
      return remove(target, options);
    });
    syncBuiltinESMExports();
    const boundary = "staging-cleanup";
    const create = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: issueMultipart(boundary, issuePayload("alpha"), "evidence.txt", "staged evidence"),
    });
    assert.equal(create.statusCode, 201, create.body);
    const listed = (await fixture.app.inject({ method: "GET", url: "/api/issues" })).json() as unknown[];
    assert.equal(listed.length, 1);
    assert.equal((await readdir(fixture.root)).filter((name) => name.startsWith("issue-pilot-attachment-")).length, 1);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fixture.cleanup();
  }
});

test("an attachment edit closes the Issue session before any original is written into the sandbox-writable root", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const create = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha") });
    const issue = await json(create);
    const issueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.delete(issueId);
    const root = issueRoot(fixture.root, String(issue.id));
    let originalsAtClose: string[] | undefined;
    // Sandbox deny lists are built when a session starts; files written while one is alive would stay writable to it.
    fixture.engine.closeSessionHook = async () => {
      originalsAtClose = (await readdir(root).catch(() => [])).filter((name) => name.startsWith(".attachment-"));
    };
    const boundary = "close-before-write";
    const updated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: issueMultipart(
        boundary,
        { expectedEditVersion: await issueEditVersion(fixture.app, issue.id), title: "Updated", description: "", priority: "p2", assigneeSubject: null, ccSubjects: [] },
        "late.txt",
        "late evidence",
      ),
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(originalsAtClose, []);
    assert.equal((await readdir(root)).filter((name) => name.startsWith(".attachment-")).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("malformed multipart bodies and a file part without a filename are client errors", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const noBoundary = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": "multipart/form-data" }, payload: "x" });
    assert.equal(noBoundary.statusCode, 400, noBoundary.body);
    assert.equal(JSON.parse(noBoundary.body).error, "invalid_multipart");
    const truncated = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      payload: '--abc\r\nContent-Disposition: form-data; name="issue"\r\n\r\n{}\r\n',
    });
    assert.equal(truncated.statusCode, 400, truncated.body);
    assert.equal(JSON.parse(truncated.body).error, "invalid_multipart");
    const boundary = "no-filename";
    const withoutName = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="issue"',
        "",
        JSON.stringify(issuePayload("alpha")),
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"',
        "Content-Type: application/octet-stream",
        "",
        "bytes",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const unnamed = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: withoutName });
    assert.equal(unnamed.statusCode, 400, unnamed.body);
    assert.equal(JSON.parse(unnamed.body).error, "invalid_attachment_name");
  } finally {
    await fixture.cleanup();
  }
});
