import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApi } from "../../src/http/api.ts";
import { openDatabase } from "../../src/db/client.ts";
import { applicationSettings, mcpServices, serviceDeploymentRepositories, serviceDeployments, services, userPreferences } from "../../src/db/schema.ts";
import { loadDeploymentRepositories } from "../../src/workspace/deployment.ts";
import { loadDingtalkUserSettings } from "../../src/configuration/user-preferences.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createIssue, createService, modelCatalog, servicePayload, TestAgentController } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("page configuration persists across restart and old files never overwrite it", async () => {
  const f = await createApiFixture();
  let restarted: Awaited<ReturnType<typeof buildApi>> | undefined;
  try {
    await createService(f.app, "Page", ["prod", "dev", "test"]);
    await writeFile(path.join(f.root, "service.yaml"), 'version: 1\ninvalid: "private-unclosed\n', { mode: 0o600 });
    await writeFile(path.join(f.root, "user.yaml"), 'private-key: "invalid\n', { mode: 0o600 });
    const connection = openDatabase(f.databaseFile);
    try {
      await connection.db.insert(userPreferences).values({ subject: issuePilotConfig.bootstrapUser.subject, dingtalk: { fields: { title: "序号" }, source: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=row", assignee: "Owner" } } });
      await connection.db.insert(applicationSettings).values({ id: 1, maxConcurrentIssues: 2, dingtalkFields: { description: "描述" } });
    } finally { await connection.close(); }
    await f.stop();
    restarted = await buildApi({ stateRoot: f.root, databaseFile: f.databaseFile, engine: new TestAgentController(), modelCatalog, logger: false });
    assert.equal((await restarted.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const config = (await restarted.inject({ method: "GET", url: "/api/config" })).json();
    assert.equal(config.services[0].name, "Page"); assert.equal("fileManaged" in config, false);
    const connectionAfter = openDatabase(f.databaseFile);
    try { const preferences = await loadDingtalkUserSettings(connectionAfter.db, issuePilotConfig.bootstrapUser.subject); assert.equal(preferences.source?.assignee, "Owner"); assert.deepEqual(preferences.fields, { description: "描述", title: "序号" }); }
    finally { await connectionAfter.close(); }
    assert.equal(await readFile(path.join(f.root, "user.yaml"), "utf8"), 'private-key: "invalid\n');
    const credentials = await restarted.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { model: { mode: "replace", provider: "enterprise-ai", apiKey: "page-owned-key" } } });
    assert.equal(credentials.statusCode, 200, credentials.body);
    assert.doesNotMatch(credentials.body, /page-owned-key/);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test("development baselines derive only from production and reject independent overrides", async () => {
  const f = await createApiFixture();
  try {
    const input = servicePayload("Branches", ["prod", "test", "dev"]);
    const url = input.repositories[0]!.url;
    await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Branches", url } });
    input.deployments.find(row => row.environmentKey === "prod")!.repositoryBranches[0]!.baseBranch = "release/production";
    const created = await f.app.inject({ method: "POST", url: "/api/services", headers, payload: input });
    assert.equal(created.statusCode, 201, created.body);
    const config = (await f.app.inject({ method: "GET", url: "/api/config" })).json();
    const service = config.services.find((row: { key: string }) => row.key === "branches");
    assert.equal(service.deployments.find((row: { environmentKey: string }) => row.environmentKey === "dev").repositoryBranches[0].baseBranch, "release/production");
    const database = openDatabase(f.databaseFile);
    try {
      const [row] = await database.db.select().from(services).where(eq(services.key, "branches"));
      const dev = await database.client.execute({ sql: "SELECT d.id,d.environment_id FROM service_deployments d JOIN environments e ON e.id=d.environment_id WHERE d.service_id=? AND e.kind='dev'", args: [row!.id] });
      assert.equal((await database.db.select().from(serviceDeploymentRepositories).where(eq(serviceDeploymentRepositories.deploymentId, String(dev.rows[0]!.id)))).length, 0);
      const loaded = await loadDeploymentRepositories(database.db, { serviceId: row!.id, environmentId: String(dev.rows[0]!.environment_id) });
      assert.equal(loaded.repositories[0]!.baseBranch, "release/production");
    } finally { await database.close(); }
    input.deployments.find(row => row.environmentKey === "dev")!.repositoryBranches = [{ repositoryAlias: input.repositories[0]!.alias, baseBranch: "forbidden" }];
    const override = await f.app.inject({ method: "PATCH", url: "/api/services/branches", headers, payload: input });
    assert.equal(override.statusCode, 400); assert.equal(override.json().error, "development_branches_inherited");
  } finally { await f.cleanup(); }
});

test("MySQL targets save atomically with deployment-owned global MCP connections and private reads", async () => {
  const f = await createApiFixture();
  try {
    const input = servicePayload("Mysql", ["prod", "dev"]);
    await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Mysql", url: input.repositories[0]!.url } });
    const password = " private mysql password ";
    const withMysql = { ...input, deployments: input.deployments.map(row => ({ ...row, ...(row.environmentKey === "prod" ? { mysql: [{ host: "db.example.test", port: 3306, username: "reader", password, database: "orders" }] } : {}) })) };
    const created = await f.app.inject({ method: "POST", url: "/api/services", headers, payload: withMysql });
    assert.equal(created.statusCode, 201, created.body);
    const publicConfig = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.doesNotMatch(publicConfig.body, /private mysql password/);
    assert.equal(publicConfig.json().services[0].deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod").mysql[0].passwordConfigured, true);
    const selected = await f.app.inject({ method: "GET", url: "/api/services/mysql/mysql-targets", headers });
    assert.equal(selected.statusCode, 200); assert.equal(selected.headers["cache-control"], "private, no-store");
    assert.equal(selected.json().deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod").mysql[0].password, password);
    const connection = openDatabase(f.databaseFile);
    try {
      const rows = await connection.db.select().from(mcpServices);
      assert.equal(rows.length, 1); assert.ok(rows[0]!.deploymentId);
      assert.equal(rows[0]!.stdio!.env.MYSQL_PASS, password);
      assert.equal(rows[0]!.stdio!.env.ALLOW_DELETE_OPERATION, "false");
      assert.doesNotMatch(JSON.stringify(rows[0]!.stdio!.args), /private mysql/);
      await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });
      assert.equal((await f.app.inject({ method: "GET", url: "/api/services/mysql/mysql-targets", headers: { "x-issue-pilot-subject": "product" } })).statusCode, 403);
      const invalid = { ...withMysql, name: "Duplicate", deployments: withMysql.deployments.map(row => ({ ...row, ...(row.mysql ? { mysql: [...row.mysql, ...row.mysql] } : {}) })) };
      const failed = await f.app.inject({ method: "POST", url: "/api/services", headers, payload: invalid });
      assert.equal(failed.statusCode, 400);
      assert.equal((await connection.db.select().from(services)).length, 1);
      assert.equal((await connection.db.select().from(mcpServices)).length, 1);
      assert.equal((await f.app.inject({ method: "DELETE", url: `/api/mcp-services/${rows[0]!.id}`, headers })).statusCode, 409);
    } finally { await connection.close(); }
    const clear = await f.app.inject({ method: "PATCH", url: "/api/services/mysql", headers, payload: { ...input, expectedRevision: selected.json().revision } });
    assert.equal(clear.statusCode, 200, clear.body);
    const check = openDatabase(f.databaseFile); try { assert.deepEqual(await check.db.select().from(mcpServices), []); } finally { await check.close(); }
  } finally { await f.cleanup(); }
});

test("MySQL connection changes reserve all Issue environments because the generated tools are global", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Other", ["test"]);
    await createIssue(f.app, "other", "test");
    const input = servicePayload("Global Mysql", ["prod", "dev"]);
    await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "Global Mysql", url: input.repositories[0]!.url } });
    const payload = { ...input, deployments: input.deployments.map(row => ({ ...row, ...(row.environmentKey === "prod" ? { mysql: [{ host: "db.example.test", port: 3306, username: "reader", password: "fixture-password", database: "orders" }] } : {}) })) };
    const blocked = await f.app.inject({ method: "POST", url: "/api/services", headers, payload });
    assert.equal(blocked.statusCode, 409, blocked.body);
    const database = openDatabase(f.databaseFile);
    try { assert.deepEqual(await database.db.select().from(mcpServices), []); }
    finally { await database.close(); }
    f.engine.running.clear();
    assert.equal((await f.app.inject({ method: "POST", url: "/api/services", headers, payload })).statusCode, 201);
  } finally { await f.cleanup(); }
});

test("stale configuration revisions refuse repository and credential replacement", async () => {
  const f = await createApiFixture();
  try {
    const saved = await f.app.inject({ method: "POST", url: "/api/repositories", headers, payload: { name: "One", url: "git@example.test:team/repo.git" } });
    const id = saved.json().id;
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/repositories/${id}`, headers, payload: { name: "Two", url: "git@example.test:team/repo.git", expectedRevision: 0 } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/repositories/${id}`, headers, payload: { name: "Old", url: "git@example.test:team/repo.git", expectedRevision: 0 } })).statusCode, 409);
    const first = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { expectedRevision: 0, model: { mode: "replace", apiKey: "first-private-key" } } });
    assert.equal(first.statusCode, 200, first.body);
    const stale = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { expectedRevision: 0, model: { mode: "replace", apiKey: "stale-private-key" } } });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, "configuration_changed");
    const read = await f.app.inject({ method: "GET", url: "/api/me/credentials", headers });
    assert.equal(read.json().revision, 1); assert.doesNotMatch(read.body, /private-key/);
  } finally { await f.cleanup(); }
});

test("saving current deployment settings preserves opaque archived development data", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Archive", ["prod", "dev"]);
    const archive = { formerBranch: "develop", note: "retained historical evidence" };
    const database = openDatabase(f.databaseFile);
    try {
      const row = (await database.client.execute("SELECT d.id FROM service_deployments d JOIN services s ON s.id=d.service_id JOIN environments e ON e.id=d.environment_id WHERE s.key='archive' AND e.kind='dev'")).rows[0]!;
      await database.db.update(serviceDeployments).set({ config: { archivedDevelopment: archive } }).where(eq(serviceDeployments.id, String(row.id)));
      const input = servicePayload("Archive", ["prod", "dev"]);
      const saved = await f.app.inject({ method: "PATCH", url: "/api/services/archive", headers, payload: input });
      assert.equal(saved.statusCode, 200, saved.body);
      const [current] = await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.id, String(row.id)));
      assert.deepEqual(current!.config, { archivedDevelopment: archive });
      assert.doesNotMatch((await f.app.inject({ method: "GET", url: "/api/config" })).body, /retained historical evidence/);
    } finally { await database.close(); }
  } finally { await f.cleanup(); }
});
