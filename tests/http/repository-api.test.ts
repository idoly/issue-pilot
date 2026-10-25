import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../src/db/client.ts";
import { createApiFixture, createIssue, createService, servicePayload } from "./fixture.ts";
import type { Configuration, ServiceConfigurationInput } from "../../src/configuration/contracts.ts";
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
    const revisions = (await f.app.inject({ method: "GET", url: "/api/config" })).json().services.map((service: { revision: number }) => service.revision);
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
    assert.deepEqual(config.services.map((service: { revision: number }) => service.revision), revisions.map((revision: number) => revision + 1));
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

test("repository display-name changes do not reserve or stop active Issue sessions", async () => {
  const f = await createApiFixture();
  try {
    const url = "git@git.example.test:team/metadata.git";
    await createService(f.app, "Metadata", ["test"], [url]);
    await createIssue(f.app, "metadata", "test");
    const issueId = f.engine.enqueued.at(-1)!;
    const rows = (await f.app.inject({ method: "GET", url: "/api/repositories" })).json();
    const revision = (await f.app.inject({ method: "GET", url: "/api/config" })).json().services[0].revision;
    const response = await f.app.inject({ method: "PATCH", url: `/api/repositories/${rows[0].id}`, headers, payload: { name: "Readable repository name", url } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.engine.running.has(issueId), true);
    assert.deepEqual(f.engine.closedSessions, []);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/repositories" })).json()[0].name, "Readable repository name");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config" })).json().services[0].revision, revision);
  } finally { await f.cleanup(); }
});

test("repository address changes reserve only entry and included services that use the repository", async () => {
  const f = await createApiFixture();
  try {
    const original = "git@git.example.test:team/scoped.git";
    await createService(f.app, "Scoped", ["test"], [original]);
    await createService(f.app, "Unrelated", ["test"]);
    await createIssue(f.app, "unrelated", "test");
    const unrelatedIssueId = f.engine.enqueued.at(-1)!;
    const catalog = (await f.app.inject({ method: "GET", url: "/api/repositories" })).json() as Array<{ id: string; url: string }>;
    const repository = catalog.find(row => row.url === original)!;
    const next = "git@git.example.test:team/scoped-next.git";
    const updated = await f.app.inject({ method: "PATCH", url: `/api/repositories/${repository.id}`, headers, payload: { name: "Scoped", url: next } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(f.engine.running.has(unrelatedIssueId), true);
    assert.deepEqual(f.engine.closedSessions, []);
    const database = openDatabase(f.databaseFile);
    try {
      const service = (await database.client.execute("SELECT id FROM services WHERE key='scoped'")).rows[0]!;
      await database.client.execute({ sql: "INSERT INTO issue_service_scopes(issue_id,service_id,created_at) VALUES(?,?,1)", args: [unrelatedIssueId, String(service.id)] });
    } finally { await database.close(); }
    const final = "git@git.example.test:team/scoped-final.git";
    const blocked = await f.app.inject({ method: "PATCH", url: `/api/repositories/${repository.id}`, headers, payload: { name: "Scoped", url: final } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    f.engine.running.clear();
    const applied = await f.app.inject({ method: "PATCH", url: `/api/repositories/${repository.id}`, headers, payload: { name: "Scoped", url: final } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.deepEqual(f.engine.closedSessions, [unrelatedIssueId]);
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

test("catalog URL changes invalidate service drafts even when the original URL is registered again", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Revision", ["test"]);
    const prior = (await f.app.inject({ method: "GET", url: "/api/config" })).json<Configuration>().services[0]!;
    const repository = (await f.app.inject({ method: "GET", url: "/api/repositories" })).json()[0];
    const nextUrl = "git@example.test:team/new-location.git";
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/repositories/${repository.id}`, headers, payload: { expectedRevision: repository.revision, name: repository.name, url: nextUrl } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Original upstream", url: repository.url } })).statusCode, 201);
    const oldDraft: ServiceConfigurationInput = { name: prior.name, description: prior.description, expectedRevision: prior.revision, repositories: prior.repositories, deployments: prior.deployments.map(row => ({ environmentKey: row.environmentKey, capabilities: [], repositoryBranches: row.repositoryBranches.map(branch => ({ repositoryAlias: branch.repositoryAlias, baseBranch: branch.baseBranch })) })) };
    const stale = await f.app.inject({ method: "PATCH", url: "/api/services/revision", headers, payload: oldDraft });
    assert.equal(stale.statusCode, 409, stale.body); assert.equal(stale.json().error, "configuration_changed");
    const current = (await f.app.inject({ method: "GET", url: "/api/config" })).json<Configuration>().services[0]!;
    assert.equal(current.repositories[0]!.url, nextUrl); assert.equal(current.revision, prior.revision + 1);
  } finally { await f.cleanup(); }
});
