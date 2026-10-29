import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { DBHUB_DATABASES } from "../../src/domain/contracts.ts";
import { dbHubDsn, deploymentDbHubTargets, parseDbHubTargets } from "../../src/configuration/dbhub.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { mcpServices, serviceDeployments, subjects } from "../../src/db/schema.ts";
import { createApiFixture, createService, servicePayload } from "./fixture.ts";
const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const target = { type: "postgres" as const, host: "db.example.test", port: 5432, username: "reader@example", password: " p@ss:/?#% ", database: "orders" };

test("DBHub types, default ports and connection secrets are parsed without placing secrets in argv", async () => {
  for (const database of DBHUB_DATABASES) {
    const [parsed] = parseDbHubTargets([{ ...target, type: database.value, port: undefined }]);
    assert.equal(parsed!.port, database.port);
    const url = new URL(dbHubDsn(parsed!));
    assert.equal(decodeURIComponent(url.password), target.password);
    assert.equal(decodeURIComponent(url.username), target.username);
  }
  for (const change of [{ type: "sqlite" }, { type: "unknown" }, { port: 0 }, { host: "db/user" }, { host: "user@db" }, { password: "" }, { password: "\0" }]) assert.throws(() => parseDbHubTargets([{ ...target, ...change }]));
  assert.throws(() => parseDbHubTargets([target, target]), /duplicate_dbhub_target/);
  assert.deepEqual(deploymentDbHubTargets({ mysql: [{ host: "db", port: 3306, username: "u", password: "p", database: "d" }] }), [{ type: "mysql", host: "db", port: 3306, username: "u", password: "p", database: "d" }]);
});

test("DBHub service connections save atomically, project credentials, replace old MySQL and clean up", async () => {
  const f = await createApiFixture(); const database = await openApplicationDatabase(f.databaseFile);
  try {
    const service = await createService(f.app, "Database", ["prod", "dev"]);
    const input = servicePayload("Database", ["prod", "dev"]);
    const withTargets = { ...input, deployments: input.deployments.map(row => ({ ...row, ...(row.environmentKey === "prod" ? { dbhub: [target, { ...target, type: "mysql", port: 3306 }] } : {}) })) };
    const save = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: withTargets });
    assert.equal(save.statusCode, 200, save.body);
    const publicConfig = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.doesNotMatch(publicConfig.body, /p@ss|DBHUB_DSN/);
    const projected = publicConfig.json().services.find((row: { key: string }) => row.key === service.key).deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod");
    assert.equal(projected.dbhub[0].passwordConfigured, true);
    const privateConfig = await f.app.inject({ method: "GET", url: `/api/services/${service.key}/dbhub-targets`, headers });
    assert.equal(privateConfig.headers["cache-control"], "private, no-store");
    assert.equal(privateConfig.json().deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod").dbhub[0].password, target.password);
    await database.db.insert(subjects).values({ subject: "viewer", role: "product" });
    assert.equal((await f.app.inject({ method: "GET", url: `/api/services/${service.key}/dbhub-targets`, headers: { "x-issue-pilot-subject": "viewer" } })).statusCode, 403);
    const connections = await database.db.select().from(mcpServices);
    assert.equal(connections.length, 2);
    for (const connection of connections) {
      assert.ok(connection.deploymentId);
      assert.match(connection.name, /^DBHub-/);
      assert.equal(connection.stdio!.command, process.execPath);
      assert.match(connection.stdio!.args[0]!, /@bytebase\/dbhub\/dist\/index\.js$/);
      assert.deepEqual(connection.stdio!.args.slice(1, 4), ["--transport", "stdio", "--config"]);
      assert.doesNotMatch(JSON.stringify(connection.stdio!.args), /p@ss|reader|DBHUB_DSN/);
      assert.equal(decodeURIComponent(new URL(connection.stdio!.env.DBHUB_DSN!).password), target.password);
      const config = await readFile(connection.stdio!.args[4]!, "utf8");
      assert.match(config, /readonly = true/); assert.match(config, /max_rows = 1000/);
      assert.equal((await f.app.inject({ method: "DELETE", url: `/api/mcp-services/${connection.id}`, headers })).statusCode, 409);
    }
    const invalid = structuredClone(withTargets); invalid.deployments.find(row => row.environmentKey === "prod")!.dbhub!.push(target);
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: invalid })).statusCode, 400);
    assert.deepEqual(await database.db.select().from(mcpServices), connections);
    const repeated = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: withTargets }); assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(await database.db.select().from(mcpServices), connections);
    const deploymentsBeforeFailure = await database.db.select().from(serviceDeployments);
    await database.client.execute("CREATE TRIGGER fail_dbhub_insert BEFORE INSERT ON mcp_services BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END");
    const changed = structuredClone(withTargets); changed.deployments.find(row => row.environmentKey === "prod")!.dbhub![0]!.port = 5433;
    const failed = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: changed });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(await database.db.select().from(mcpServices), connections);
    assert.deepEqual(await database.db.select().from(serviceDeployments), deploymentsBeforeFailure);
    await database.client.execute("DROP TRIGGER fail_dbhub_insert");
    const cleared = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: input }); assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal((await database.db.select().from(mcpServices)).length, 0);
    assert.ok((await database.db.select().from(serviceDeployments)).every(row => !row.config.dbhub));
  } finally { database.close(); await f.cleanup(); }
});

test("saving DBHub replaces the deployment's MySQL connection without touching other deployments", async () => {
  const f = await createApiFixture(); const database = await openApplicationDatabase(f.databaseFile);
  try {
    const service = await createService(f.app, "Replacement", ["prod", "test"]);
    const base = servicePayload("Replacement", ["prod", "test"]);
    const legacy = { ...target, type: undefined, port: 3306 };
    const old = { ...base, deployments: base.deployments.map(row => ({ ...row, mysql: [legacy] })) };
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: old })).statusCode, 200);
    const initial = await database.db.select().from(mcpServices);
    // Reproduce a connection generated by the replaced MySQL adapter.
    await database.client.execute({ sql: "UPDATE mcp_services SET id = ? WHERE id = ?", args: ["mysql-old-fixture", initial[0]!.id] });
    const before = await database.db.select().from(mcpServices);
    const replacement = { ...base, deployments: base.deployments.map(row => ({ ...row, ...(row.environmentKey === "prod" ? { dbhub: [target] } : { mysql: [legacy] }) })) };
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: replacement })).statusCode, 200);
    const after = await database.db.select().from(mcpServices);
    assert.equal(after.length, 2); assert.equal(after.filter(row => row.id.startsWith("dbhub-")).length, 2);
    assert.ok(!after.some(row => row.id.startsWith("mysql-")));
    const retained = after.find(row => before.some(old => old.id === row.id))!;
    assert.deepEqual(retained, before.find(row => row.id === retained.id));
    const mixed = structuredClone(replacement); Object.assign(mixed.deployments[0]!, { mysql: [legacy] });
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: mixed })).json().error, "conflicting_database_targets");
  } finally { database.close(); await f.cleanup(); }
});
