import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issues, subjects } from "../../src/db/schema.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { registerSourceBrowserRoutes } from "../../src/http/source-browser-routes.ts";
import { createApiFixture, createIssue, createService, issueEditVersion, issueMetadataPayload, issuePayload } from "./fixture.ts";

const owner = issuePilotConfig.bootstrapUser.subject;

for (const explicit of [false, true])
  test(`a ${explicit ? "header-selected" : "default"} product user cannot mutate source or run a dev Issue's Agent`, async () => {
    const f = await createApiFixture();
    const database = openDatabase(f.databaseFile);
    const authors: unknown[] = [];
    let sourceMutations = 0;
    const app = Fastify();
    registerSourceBrowserRoutes({
      app,
      database,
      engine: f.engine,
      sourceBrowser: {
        async writeFile() {
          sourceMutations++;
          return {};
        },
        async createCommit(_issue: unknown, _repository: unknown, _message: unknown, author: unknown) {
          sourceMutations++;
          authors.push(author);
          return { commit: "fixture" };
        },
      } as never,
    });
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
    try {
      await createService(f.app, "CodeRoleDev", ["dev"]);
      await createService(f.app, "CodeRoleTest", ["test"]);
      const dev = await createIssue(f.app, "coderoledev", "dev");
      f.engine.running.clear();
      const testIssue = await createIssue(f.app, "coderoleTest".toLowerCase(), "test");
      f.engine.running.clear();
      const testIssueId = f.engine.enqueued.at(-1)!;
      f.engine.messages.length = 0;
      f.engine.enqueued.length = 0;
      const product = await f.app.inject({
        method: "POST",
        url: "/api/users",
        headers: { "x-issue-pilot-subject": owner },
        payload: { subject: "product@example.test", name: "Product", email: "product@example.test", role: "product" },
      });
      assert.equal(product.statusCode, 201, product.body);
      // Default selection is the oldest active user, not necessarily the lexically first subject created this second.
      if (!explicit)
        await database.db
          .update(subjects)
          .set({ createdAt: new Date(0) })
          .where(eq(subjects.subject, "product@example.test"));
      const headers = explicit ? { "x-issue-pilot-subject": "product@example.test" } : {};
      const base = `/api/issues/${dev.id}`;
      for (const request of [
        { method: "PUT" as const, url: `${base}/source/file`, payload: "changed", headers: { "content-type": "text/plain", "x-issue-pilot-path": "a.txt", "x-issue-pilot-sha256": "a".repeat(64) } },
        { method: "POST" as const, url: `${base}/source/file`, payload: "created", headers: { "content-type": "text/plain", "x-issue-pilot-path": "b.txt" } },
        { method: "POST" as const, url: `${base}/source/directory`, headers: { "x-issue-pilot-path": "c" } },
        { method: "DELETE" as const, url: `${base}/source/path`, headers: { "x-issue-pilot-path": "c" } },
        { method: "POST" as const, url: `${base}/source/rename`, headers: { "x-issue-pilot-path": "a.txt", "x-issue-pilot-destination": "d.txt" } },
        ...["stage", "unstage", "discard"].map((action) => ({ method: "POST" as const, url: `${base}/source/${action}`, payload: { paths: ["a.txt"] }, headers: {} })),
        { method: "POST" as const, url: `${base}/source/commit`, payload: { message: "change" }, headers: { "x-issue-pilot-repository": "coderoledev-1" } },
      ]) {
        const response = await app.inject({ ...request, headers: { ...request.headers, ...headers } });
        assert.equal(response.statusCode, 403, `${request.method} ${request.url}: ${response.body}`);
        assert.equal(response.json().error, "developer_role_required");
      }
      assert.equal(sourceMutations, 0);
      assert.deepEqual(authors, []);

      const denied = await f.app.inject({ method: "POST", url: `/api/issues/${dev.id}/agent-messages`, headers, payload: { message: "implement it" } });
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().error, "developer_role_required");
      assert.deepEqual(f.engine.messages, []);

      const retried = await f.app.inject({ method: "POST", url: `/api/issues/${dev.id}/retry`, headers });
      assert.equal(retried.statusCode, 403, retried.body);
      assert.deepEqual(f.engine.enqueued, []);

      // Prod/test Issues keep running analysis for every role: the gate follows the Issue's environment.
      const accepted = await f.app.inject({ method: "POST", url: `/api/issues/${testIssue.id}/agent-messages`, headers, payload: { message: "investigate" } });
      assert.equal(accepted.statusCode, 202, accepted.body);
      assert.deepEqual(f.engine.messages, ["investigate"]);
      const retriedTest = await f.app.inject({ method: "POST", url: `/api/issues/${testIssue.id}/retry`, headers });
      assert.equal(retriedTest.statusCode, 202, retriedTest.body);
      // The message and the retry each enqueue the test Issue; no dev Issue was ever started.
      assert.deepEqual(f.engine.enqueued, [testIssueId, testIssueId]);
    } finally {
      await app.close();
      database.close();
      await f.cleanup();
    }
  });

test("developers keep source mutations and dev Agent admission, and resolved Issues stay read-only", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const authors: unknown[] = [];
  let sourceMutations = 0;
  const app = Fastify();
  registerSourceBrowserRoutes({
    app,
    database,
    engine: f.engine,
    sourceBrowser: {
      async createCommit(_issue: unknown, _repository: unknown, _message: unknown, author: unknown) {
        sourceMutations++;
        authors.push(author);
        return { commit: "fixture" };
      },
    } as never,
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
  try {
    await createService(f.app, "CodeRoleOwner", ["dev"]);
    const dev = await createIssue(f.app, "coderoleowner", "dev");
    f.engine.running.clear();
    f.engine.messages.length = 0;
    f.engine.enqueued.length = 0;
    const headers = { "x-issue-pilot-subject": owner, "x-issue-pilot-repository": "coderoleowner-1" };
    const accepted = await app.inject({ method: "POST", url: `/api/issues/${dev.id}/source/commit`, headers, payload: { message: "change" } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(sourceMutations, 1);
    assert.deepEqual(authors, [{ name: issuePilotConfig.bootstrapUser.name, email: issuePilotConfig.bootstrapUser.email }]);
    const messaged = await f.app.inject({ method: "POST", url: `/api/issues/${dev.id}/agent-messages`, headers: { "x-issue-pilot-subject": owner }, payload: { message: "continue" } });
    assert.equal(messaged.statusCode, 202, messaged.body);

    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(issues.key, String(dev.id)));
    const readOnly = await app.inject({ method: "POST", url: `/api/issues/${dev.id}/source/commit`, headers, payload: { message: "change" } });
    assert.equal(readOnly.statusCode, 403, readOnly.body);
    assert.equal(readOnly.json().error, "source_read_only");
    assert.equal(sourceMutations, 1);

    // An administrator without the developer role is still refused.
    await database.db.update(subjects).set({ role: "test", isAdmin: true }).where(eq(subjects.subject, owner));
    const adminOnly = await app.inject({ method: "POST", url: `/api/issues/${dev.id}/source/commit`, headers, payload: { message: "change" } });
    assert.equal(adminOnly.statusCode, 403, adminOnly.body);
    assert.equal(adminOnly.json().error, "developer_role_required");
  } finally {
    await app.close();
    database.close();
    await f.cleanup();
  }
});

test("a product user can edit a dev Issue and detach evidence without starting its Agent", async () => {
  const f = await createApiFixture();
  try {
    const developer = { "x-issue-pilot-subject": owner };
    await createService(f.app, "EditRole", ["test", "dev"]);
    const evidence = await createIssue(f.app, "editrole", "test");
    f.engine.running.clear();
    const created = await f.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: developer,
      payload: { ...issuePayload("editrole", "dev"), relatedIssueKeys: [evidence.id] },
    });
    assert.equal(created.statusCode, 201, created.body);
    const { id: key } = created.json<{ id: string }>();
    const id = f.engine.enqueued.at(-1);
    f.engine.running.clear();
    f.engine.enqueued.length = 0;
    const subject = "edit-product@example.test";
    const person = await f.app.inject({
      method: "POST",
      url: "/api/users",
      headers: developer,
      payload: { subject, name: "Product", email: subject, role: "product" },
    });
    assert.equal(person.statusCode, 201, person.body);
    const url = `/api/issues/${key}`;
    const product = { "x-issue-pilot-subject": subject };
    const edit = async (headers: typeof product, title: string) =>
      f.app.inject({ method: "PATCH", url, headers, payload: { ...issueMetadataPayload(title), expectedEditVersion: await issueEditVersion(f.app, key) } });

    assert.equal((await edit(product, "Edited by product")).statusCode, 200);
    const detached = await f.app.inject({ method: "PUT", url: `${url}/related-issues`, headers: product, payload: { relatedIssueKeys: [] } });
    assert.equal(detached.statusCode, 204, detached.body);
    assert.deepEqual(f.engine.enqueued, []);
    const detail = (await f.app.inject({ url })).json();
    assert.equal(detail.title, "Edited by product");
    assert.deepEqual(detail.relatedIssues, []);
    assert.equal((await edit(developer, "Edited by developer")).statusCode, 200);
    assert.deepEqual(f.engine.enqueued, [id]);
  } finally {
    await f.cleanup();
  }
});
