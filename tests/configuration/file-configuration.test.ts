import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { stringify } from "yaml";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { applyFileConfiguration } from "../../src/configuration/file-configuration.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { globalAgentConfiguration, mcpServices, serviceDeployments, services, userCredentials } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { modelCatalog, TestAgentController, testAgent } from "../http/fixture.ts";

async function files(root: string, invalid = false) {
  const user = {
    version: 1, user: { subject: issuePilotConfig.bootstrapUser.subject }, apiKeys: { [testAgent.provider]: "private-model-key" },
    ssh: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----" },
    sls: { accessKeyId: "private-sls-key", accessKeySecret: "private-sls-secret" },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-dms-token" }, dingtalk: { apiKey: "private-dingtalk-key" },
  };
  const service = {
    version: 1, issuesDirectory: "workspaces", agent: { provider: testAgent.provider, model: testAgent.model, thinkingLevel: "high", runtime: { settings: { retry: { enabled: false } } } }, automation: { maxConcurrentIssues: 2 },
    repositories: { app: { url: "git@example.test:app.git" } },
    services: { orders: { name: "Orders", environments: {
      dev: { repositories: { app: "develop" } },
      test: { repositories: { app: invalid ? "" : "test" }, mysql: [{ host: "db.example.test", port: 3306, username: "reader", password: " private-mysql-password ", database: "orders" }] },
      prod: { repositories: { app: "prod" }, dms: { prod: { alias: "ORDERS", schema: "orders" } }, sls: { first: { region: "cn-test", project: "orders-first", logstores: ["application"] }, second: { region: "cn-other", project: "orders-second", logstores: ["gateway"] } } },
    } } },
  };
  const mcp = { mcpServers: { mysql: { type: "stdio", command: process.execPath, args: ["mysql-fixture.mjs"] }, dms: { type: "sse", url: "https://dms.example.test/sse" }, dingtalk: { type: "streamable-http", url: "https://dingtalk.example.test/server" } } };
  await Promise.all([writeFile(path.join(root, "service.yaml"), stringify(service), { mode: 0o600 }), writeFile(path.join(root, "user.yaml"), stringify(user), { mode: 0o600 }), writeFile(path.join(root, "mcp.json"), JSON.stringify(mcp), { mode: 0o600 })]);
}

test("files project services, named SLS targets, user credentials and exact MySQL MCP environments atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-config-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    await files(root);
    const status = await applyFileConfiguration(database.db, root);
    assert.deepEqual(status, { services: true, mcp: true, maxConcurrentIssues: 2, userSubject: issuePilotConfig.bootstrapUser.subject });
    const [owner] = await database.db.select().from(userCredentials);
    assert.equal(owner!.modelApiKeys[testAgent.provider], "private-model-key");
    assert.equal(owner!.productionSlsAccessKeySecret, "private-sls-secret");
    const [agent] = await database.db.select().from(globalAgentConfiguration);
    assert.equal(agent!.provider, testAgent.provider);
    assert.deepEqual(agent!.runtime, { settings: { retry: { enabled: false } } });
    const agentTimestamp = agent!.updatedAt.getTime();
    const deployments = await database.db.select().from(serviceDeployments);
    const production = deployments.find(row => row.config.dms)!;
    assert.equal(production.config.dms!.databases[0]!.schemaName, "orders");
    assert.equal(production.config.dms!.databases[0]!.databaseId, "");
    assert.equal(production.config.sls!.targets?.length, 2);
    const connections = await database.db.select().from(mcpServices);
    assert.equal(connections.some(row => row.name === "mysql"), false);
    const mysql = connections.find(row => row.name === "mysql-orders-test-orders")!;
    assert.equal(mysql.stdio!.env.MYSQL_PASS, " private-mysql-password ");
    assert.equal(mysql.stdio!.env.MYSQL_DB, "orders");
    assert.equal(mysql.stdio!.env.ALLOW_DELETE_OPERATION, "false");
    assert.doesNotMatch(JSON.stringify(mysql.stdio!.args), /private-mysql-password/);
    assert.equal(new URL(connections.find(row => row.name === "dingtalk")!.url).searchParams.get("key"), "private-dingtalk-key");
    const before = connections.map(row => ({ id: row.id, updatedAt: row.updatedAt.getTime() }));
    const credentialsTimestamp = owner!.updatedAt.getTime();
    await applyFileConfiguration(database.db, root);
    assert.deepEqual((await database.db.select().from(mcpServices)).map(row => ({ id: row.id, updatedAt: row.updatedAt.getTime() })), before);
    assert.equal((await database.db.select().from(userCredentials))[0]!.updatedAt.getTime(), credentialsTimestamp);
    assert.equal((await database.db.select().from(globalAgentConfiguration))[0]!.updatedAt.getTime(), agentTimestamp);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("file configuration rolls back invalid imports and reports no private parse or SQL values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-config-failure-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    await files(root, true);
    await assert.rejects(applyFileConfiguration(database.db, root), error => error instanceof Error && error.message === "invalid_file_configuration" && error.cause === undefined);
    assert.deepEqual(await database.db.select().from(userCredentials), []);
    assert.deepEqual(await database.db.select().from(services), []);
    await writeFile(path.join(root, "user.yaml"), 'secret: "private-unclosed-key\n', { mode: 0o600 });
    await assert.rejects(applyFileConfiguration(database.db, root), error => error instanceof Error && !error.message.includes("private-unclosed-key"));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("API exposes safe file ownership status and prevents editing a second configuration source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-config-api-"));
  await mkdir(root, { recursive: true, mode: 0o700 }); await files(root);
  const app = await buildApi({ stateRoot: root, databaseFile: path.join(root, "issues.db"), engine: new TestAgentController(), modelCatalog, logger: false });
  try {
    const config = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(config.statusCode, 200, config.body);
    assert.equal(config.json().fileManaged.services, true);
    assert.doesNotMatch(config.body, /private-model-key|private-sls-secret|private-dms-token|private-dingtalk-key|private-mysql-password/);
    const mcp = await app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.doesNotMatch(mcp.body, /private-dingtalk-key|private-dms-token|private-mysql-password/);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/services/orders", payload: {} })).json().error, "configuration_managed_by_files");
    assert.equal((await app.inject({ method: "PUT", url: "/api/me/credentials", payload: {} })).json().error, "credentials_managed_by_user_file");
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
