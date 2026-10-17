import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../src/db/client.ts";
import { createApiFixture, createIssue, createService, servicePayload } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("manages a shared repository catalog and cascades config URLs without rewriting Issue history", async () => {
  const f = await createApiFixture();
  try {
    const url = "git@git.example.test:team/shared.git";
    await createService(f.app, "Alpha", ["test"], [url]);
    await createService(f.app, "Beta", ["test"], [url]);
    const list = await f.app.inject({ method: "GET", url: "/api/repositories" });
    assert.equal(list.headers["cache-control"], "private, no-store");
    const rows = JSON.parse(list.body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].services.length, 2);
    const id = rows[0].id;
    const issue = await createIssue(f.app, "alpha", "test");
    const issueId = f.engine.enqueued.at(-1)!;
    const connection = openDatabase(f.databaseFile);
    await connection.client.execute({ sql: "insert into issue_repositories (id,issue_id,url,base_branch,created_at,updated_at) values (?,?,?,?,1,1)", args: ["historical", issueId, url, "main"] });
    connection.close();
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/repositories/${id}`, headers })).statusCode, 409);
    const next = "git@git.example.test:team/renamed.git";
    const blocked = await f.app.inject({ method: "PATCH", url: `/api/repositories/${id}`, headers, payload: { name: "Shared", url: next } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    f.engine.running.clear();
    const update = await f.app.inject({ method: "PATCH", url: `/api/repositories/${id}`, headers, payload: { name: "Shared", url: next } });
    assert.equal(update.statusCode, 200, update.body);
    const config = JSON.parse((await f.app.inject({ method: "GET", url: "/api/config" })).body);
    assert.deepEqual(config.services.map((service: { repositories: Array<{ url: string }> }) => service.repositories[0]!.url), [next, next]);
    const detail = JSON.parse((await f.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).body);
    assert.equal(detail.repositories[0].url, url);
    const db = openDatabase(f.databaseFile);
    assert.equal((await db.client.execute("pragma foreign_key_check")).rows.length, 0);
    db.close();
    assert.equal((await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Duplicate", url: next } })).statusCode, 409);
    const unused = await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Unused", url: "https://git.example.test/unused.git" } });
    assert.equal(unused.statusCode, 201);
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/repositories/${JSON.parse(unused.body).id}`, headers })).statusCode, 204);
    const invalidService = await f.app.inject({ method: "POST", url: "/api/services", payload: servicePayload("Unregistered") });
    assert.equal(invalidService.statusCode, 400);
    assert.equal(JSON.parse(invalidService.body).error, "repository_not_registered");
  } finally { await f.cleanup(); }
});

test("rejects embedded credentials, unsupported URLs, and nondeveloper repository mutations", async () => {
  const f = await createApiFixture();
  try {
    for (const url of ["https://user:secret@git.example.test/repo.git", "https://git.example.test/repo.git?token=secret", "/tmp/repo.git", "file:///tmp/repo", "http://git.example.test/repo.git"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Invalid", url } });
      assert.equal(response.statusCode, 400, response.body);
    }
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });
    const response = await f.app.inject({ method: "POST", url: "/api/repositories", headers: { "x-issue-pilot-subject": "product" }, payload: { name: "No", url: "git@git.example.test:no.git" } });
    assert.equal(response.statusCode, 403);
  } finally { await f.cleanup(); }
});
