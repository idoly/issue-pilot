import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { stringify } from "yaml";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { applyFileConfiguration, loadDingtalkUserSettings } from "../../src/configuration/file-configuration.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { fileRecord, userFileLayout } from "../../src/configuration/file-layout.ts";
import { eq } from "drizzle-orm";
import { globalAgentConfiguration, mcpServices, serviceDeployments, services, subjects, userCredentials } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { modelCatalog, TestAgentController, testAgent } from "../http/fixture.ts";

async function files(root: string, invalid = false) {
  const personal = {
    apiKeys: { [testAgent.provider]: "private-model-key" },
    ssh: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----" },
    sls: { accessKeyId: "private-sls-key", accessKeySecret: "private-sls-secret" },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-dms-token" }, dingtalk: {},
  };
  const user = { version: 2, shared: { sls: { ...personal.sls }, dms: { ...personal.dms }, dingtalk: { apiKey: "private-dingtalk-key" } }, users: { [issuePilotConfig.bootstrapUser.subject]: personal } };
  const service = {
    version: 2, issuesDirectory: "workspaces", agent: { provider: testAgent.provider, model: testAgent.model, thinkingLevel: "high", runtime: { settings: { retry: { enabled: false } } } }, automation: { maxConcurrentIssues: 2 },
    repositories: { app: "git@example.test:app.git" },
    services: { orders: { name: "Orders", environments: {
      dev: { repositories: { app: "develop" } },
      test: { repositories: { app: invalid ? "" : "test" }, mysql: [{ host: "db.example.test", port: 3306, username: "reader", password: " private-mysql-password ", database: "orders" }] },
      prod: { repositories: { app: "prod" }, dms: { alias: "ORDERS", schema: "orders" }, sls: [{ name: "first", region: "cn-test", project: "orders-first", logstores: ["application"] }, { name: "second", region: "cn-other", project: "orders-second", logstores: ["gateway"] }] },
    } } },
  };
  const mcp = { mcpServers: { mysql: { type: "stdio", command: process.execPath, args: ["mysql-fixture.mjs"] }, dms: { type: "sse", url: "https://dms.example.test/sse" }, dingtalk: { type: "streamable-http", url: "https://dingtalk.example.test/server" } } };
  await Promise.all([writeFile(path.join(root, "service.yaml"), stringify(service), { mode: 0o600 }), writeFile(path.join(root, "user.yaml"), stringify(user), { mode: 0o600 }), writeFile(path.join(root, "mcp.json"), JSON.stringify(mcp), { mode: 0o600 })]);
  return { user, service, mcp };
}

test("files project services, named SLS targets, user credentials and exact MySQL MCP environments atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-config-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    await files(root);
    const status = await applyFileConfiguration(database.db, root);
    assert.deepEqual(status, { services: true, mcp: true, maxConcurrentIssues: 2, userSubjects: [issuePilotConfig.bootstrapUser.subject], mcpServiceNames: ["dms", "dingtalk", "mysql-orders-test-orders"] });
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

test("runtime rejects obsolete configuration layouts without changing files or database projections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-current-config-only-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const current = await files(root);
    await applyFileConfiguration(database.db, root);
    const before = await database.db.select().from(userCredentials);
    for (const version of [undefined, 1, 3, "2"]) {
      const changed = stringify({ ...current.service, version });
      await writeFile(path.join(root, "service.yaml"), changed);
      await assert.rejects(applyFileConfiguration(database.db, root), /invalid_file_configuration/);
      assert.equal(await readFile(path.join(root, "service.yaml"), "utf8"), changed);
      assert.deepEqual(await database.db.select().from(userCredentials), before);
    }
    await writeFile(path.join(root, "service.yaml"), stringify(current.service));
    await writeFile(path.join(root, "user.yaml"), stringify({ version: 1, user: { subject: issuePilotConfig.bootstrapUser.subject }, dms: { authorization: "private-no-target" } }));
    await assert.rejects(applyFileConfiguration(database.db, root), /invalid_file_configuration/);
    const user = structuredClone(current.user);
    delete (user.users[issuePilotConfig.bootstrapUser.subject]!.dms as { url?: string }).url;
    await writeFile(path.join(root, "user.yaml"), stringify(user));
    await assert.rejects(applyFileConfiguration(database.db, root), /invalid_file_configuration/);
    assert.deepEqual(await database.db.select().from(userCredentials), before);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("API exposes safe file ownership status and prevents editing a second configuration source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-config-api-"));
  await mkdir(root, { recursive: true, mode: 0o700 }); await files(root);
  const seed = await openApplicationDatabase(path.join(root, "issues.db"));
  await seed.db.insert(mcpServices).values({ id: "retired", name: "Retired Browser", url: "", transport: "stdio", enabled: true, stdio: { command: process.execPath, args: ["-e", "process.exit(0)"], env: {} } });
  seed.close();
  const app = await buildApi({ stateRoot: root, databaseFile: path.join(root, "issues.db"), engine: new TestAgentController(), modelCatalog, logger: false });
  try {
    const config = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(config.statusCode, 200, config.body);
    assert.equal(config.json().fileManaged.services, true);
    assert.doesNotMatch(config.body, /private-model-key|private-sls-secret|private-dms-token|private-dingtalk-key|private-mysql-password/);
    const credentialStatus = await app.inject({ method: "GET", url: "/api/me/credentials" });
    assert.equal(credentialStatus.statusCode, 200, credentialStatus.body);
    assert.equal("dingtalkConfigured" in credentialStatus.json(), false);
    assert.doesNotMatch(credentialStatus.body, /private-model-key|private-sls-secret|private-dms-token|private-dingtalk-key|private-mysql-password/);
    const mcp = await app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.doesNotMatch(mcp.body, /private-dingtalk-key|private-dms-token|private-mysql-password|Retired Browser/);
    assert.equal((await app.inject({ method: "POST", url: "/api/mcp-services/retired/test" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/mcp-services/retired/configuration" })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: "/api/services/orders", payload: {} })).json().error, "configuration_managed_by_files");
    assert.equal((await app.inject({ method: "PUT", url: "/api/me/credentials", payload: {} })).json().error, "credentials_managed_by_user_file");
    assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test("version two keeps each account independent, including inactive and empty accounts, with shared service credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-multi-user-config-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const original = await files(root), service = structuredClone(original.service), layout = userFileLayout(original.user);
    const production = fileRecord(fileRecord(fileRecord(service.services).orders).environments).prod;
    assert.deepEqual(fileRecord(production).dms, { alias: "ORDERS", schema: "orders" });
    assert.equal(fileRecord(service.repositories).app, "git@example.test:app.git");
    await database.db.insert(subjects).values([
      { subject: "bob", displayName: "Bob", role: "developer" },
      { subject: "empty", displayName: "Empty", role: "product" },
      { subject: "inactive", displayName: "Inactive", role: "developer", active: false },
    ]);
    layout.users.bob = { apiKeys: { [testAgent.provider]: "bob-model-key" }, dms: { url: "https://bob.example.test/sse", authorization: "Bearer bob-dms-token" } };
    layout.users.empty = {};
    layout.users.inactive = { apiKeys: { [testAgent.provider]: "inactive-model-key" } };
    const owner = layout.users[issuePilotConfig.bootstrapUser.subject]!;
    owner.dingtalk = { source: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: "Owner", intervalMinutes: 15 } };
    await Promise.all([writeFile(path.join(root, "service.yaml"), stringify(service)), writeFile(path.join(root, "user.yaml"), stringify({ version: 2, shared: layout.shared, users: layout.users }))]);
    const status = await applyFileConfiguration(database.db, root);
    assert.deepEqual(new Set(status.userSubjects), new Set(Object.keys(layout.users)));
    const rows = await database.db.select().from(userCredentials), byUser = new Map(rows.map(row => [row.subject, row]));
    assert.equal(byUser.get("bob")!.modelApiKeys[testAgent.provider], "bob-model-key");
    assert.equal(byUser.get("bob")!.productionDmsAuthorization, "Bearer bob-dms-token");
    assert.equal(byUser.get("bob")!.productionSlsAccessKeyId, "");
    assert.deepEqual(byUser.get("empty")!.modelApiKeys, {});
    assert.equal(byUser.get("empty")!.gitPrivateKey, "");
    assert.equal(byUser.get("inactive")!.modelApiKeys[testAgent.provider], "inactive-model-key");
    assert.equal((await database.db.select().from(subjects).where(eq(subjects.subject, "inactive")))[0]!.active, false);
    const deployment = (await database.db.select().from(serviceDeployments)).find(row => row.config.dms)!;
    assert.equal(deployment.config.dms!.authorization, "Bearer private-dms-token");
    const bob = await loadDingtalkUserSettings(root, "bob"), own = await loadDingtalkUserSettings(root, issuePilotConfig.bootstrapUser.subject);
    assert.equal(bob.source, undefined); assert.equal("personal" in bob, false); assert.equal("shared" in bob, false);
    assert.equal(own.source?.assignee, "Owner");
    owner.apiKeys = { [testAgent.provider]: "must-roll-back" };
    layout.users.bob = { dms: { authorization: "incomplete-private-group" } };
    await writeFile(path.join(root, "user.yaml"), stringify({ version: 2, shared: layout.shared, users: layout.users }));
    await assert.rejects(applyFileConfiguration(database.db, root), error => error instanceof Error && !error.message.includes("incomplete-private-group"));
    assert.equal((await database.db.select().from(userCredentials).where(eq(userCredentials.subject, issuePilotConfig.bootstrapUser.subject)))[0]!.modelApiKeys[testAgent.provider], "private-model-key");
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("multi-user file management status follows the caller and does not disclose other file subjects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-file-users-api-"));
  const seed = await openApplicationDatabase(path.join(root, "issues.db"));
  const original = await files(root), layout = userFileLayout(original.user);
  await seed.db.insert(subjects).values({ subject: "bob", displayName: "Bob", role: "developer" }); seed.close();
  layout.users.bob = { apiKeys: {} };
  await writeFile(path.join(root, "service.yaml"), stringify(structuredClone(original.service)));
  await writeFile(path.join(root, "user.yaml"), stringify({ version: 2, shared: layout.shared, users: layout.users }));
  const app = await buildApi({ stateRoot: root, databaseFile: path.join(root, "issues.db"), engine: new TestAgentController(), modelCatalog, logger: false });
  try {
    for (const subject of ["bob", issuePilotConfig.bootstrapUser.subject]) {
      const headers = { "x-issue-pilot-subject": subject }, configuration = await app.inject({ method: "GET", url: "/api/config", headers });
      assert.equal(configuration.statusCode, 200, configuration.body);
      assert.equal(configuration.json().fileManaged.userSubject, subject);
      assert.equal(configuration.json().fileManaged.userSubjects, undefined);
      const update = await app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: {} });
      assert.equal(update.json().error, "credentials_managed_by_user_file");
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
