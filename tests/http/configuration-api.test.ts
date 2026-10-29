import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { test } from "node:test";

import { createClient, type TransactionMode, type Transaction } from "@libsql/client";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadConfigurationCatalog } from "../../src/configuration/read.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createApiFixture, createIssue, createService, json, servicePayload, testAgent } from "./fixture.ts";

test("DMS scope errors preserve upstream HTTP status without private response details", async () => {
  const fixture = await createApiFixture(), originalFetch = globalThis.fetch;
  let upstreamStatus = 429;
  globalThis.fetch = async () => new Response("private-dms-token private-upstream-detail", { status: upstreamStatus, headers: { "retry-after": "120" } });
  try {
    for (const status of [429, 403, 503]) {
      upstreamStatus = status;
      const response = await fixture.app.inject({ method: "POST", url: "/api/dms/scope/resolve", headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject }, payload: { url: "https://dms.example.test/sse", authorization: "Bearer private-dms-token", environmentKey: "prod", instanceAlias: "ORDERS-PROD", schemaName: "orders" } });
      assert.equal(response.statusCode, 502, response.body);
      assert.equal((await json(response)).error, `dms_mcp_http_${status}`);
      assert.doesNotMatch(response.body, /private-dms-token|private-upstream-detail/);
    }
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});

test("configuration snapshots do not block Workspace writes", async () => {
  const fixture = await createApiFixture();
  const connection = openDatabase(fixture.databaseFile);
  const writer = createClient({ url: `file:${fixture.databaseFile}`, timeout: 25 });
  const begin = connection.client.transaction.bind(connection.client);
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let transaction: Transaction | undefined;
  let snapshot: ReturnType<typeof loadConfigurationCatalog> | undefined;
  connection.client.transaction = async (mode?: TransactionMode) => {
    transaction = await begin(mode);
    const commit = transaction.commit.bind(transaction);
    transaction.commit = async () => { started(); await gate; return commit(); };
    return transaction;
  };
  try {
    await createService(fixture.app, "Snapshot", ["dev"]);
    await createIssue(fixture.app, "snapshot", "dev");
    fixture.engine.running.clear();
    snapshot = loadConfigurationCatalog(connection.db);
    await Promise.race([ready, snapshot]);
    assert.ok(transaction && !transaction.closed);
    const result = await writer.execute("update issue_workspaces set status = 'preparing', runtime_ready = 0 returning issue_id");
    release();
    assert.equal((await snapshot).services.length, 1);
    assert.equal(result.rows.length, 1);
  } finally {
    release(); await snapshot?.catch(() => undefined);
    writer.close(); connection.close(); await fixture.cleanup();
  }
});

test("projects bootstrap user, environments, models, repositories, and deployments without internal fields", async () => {
  const fixture = await createApiFixture();
  try {
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const currentUser = await fixture.app.inject({ method: "GET", url: "/api/me" });
    assert.equal(currentUser.statusCode, 200);
    assert.deepEqual(await json(currentUser), { ...issuePilotConfig.bootstrapUser });
    const users = JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/users" })).body) as Array<{ subject: string }>;
    assert.deepEqual(users.map(({ subject }) => subject), [issuePilotConfig.bootstrapUser.subject]);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "missing-user" } })).statusCode, 400);
    const invalidConnection = await fixture.app.inject({ method: "POST", url: "/api/dms/scope/resolve", payload: { url: "http://dms.example.test/sse", authorization: "Bearer token", instanceAlias: "ORDERS", schemaName: "orders" } });
    assert.equal(invalidConnection.statusCode, 400);
    assert.equal((await json(invalidConnection)).error, "invalid_dms_url");

    await createService(fixture.app, "Alpha", ["test"], ["https://example.test/alpha.git", "https://example.test/alpha-shared.git"]);
    const concurrentReads = await Promise.all([
      fixture.app.inject({ method: "GET", url: "/api/config" }),
      fixture.app.inject({ method: "GET", url: "/api/config" }),
      fixture.app.inject({ method: "GET", url: "/api/catalog" }),
    ]);
    assert.deepEqual(concurrentReads.map((result) => result.statusCode), [200, 200, 200]);
    const catalogResponse = await fixture.app.inject({ method: "GET", url: "/api/catalog" });
    assert.equal(catalogResponse.statusCode, 200);
    assert.equal(catalogResponse.headers["cache-control"], "private, no-store");
    const catalog = await json(catalogResponse) as { environments: Array<{ key: string }>; services: Array<Record<string, unknown> & { deployments: Array<Record<string, unknown>> }> };
    assert.deepEqual(Object.keys(catalog).sort(), ["environments", "services"]);
    assert.deepEqual(Object.keys(catalog.services[0]!).sort(), ["deployments", "key", "name"]);
    assert.deepEqual(Object.keys(catalog.services[0]!.deployments[0]!).sort(), ["environmentKey"]);
    assert.equal(catalogResponse.body.includes("alpha.git"), false);
    const response = await fixture.app.inject({ method: "GET", url: "/api/config" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers.pragma, "no-cache");
    const config = await json(response) as {
      environments: Array<Record<string, unknown>>;
      agent: Record<string, unknown>;
      agentModels: Array<Record<string, unknown>>;
      services: Array<{ key: string; repositories: Array<Record<string, unknown>>; deployments: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(config.environments.map(({ key }) => key).sort(), ["dev", "prod", "test"]);
    assert.equal(config.environments.some((environment) => "id" in environment || "kind" in environment), false);
    assert.deepEqual(config.agent, { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium", codemode: "on", runtime: {} });
    assert.deepEqual(Object.keys(config.agentModels[0]!).sort(), ["id", "provider", "thinkingLevels"]);
    const service = config.services[0]!;
    assert.equal(service.key, "alpha");
    assert.deepEqual(service.repositories.map(({ alias, url }) => ({ alias, url })), [
      { alias: "alpha-1", url: "https://example.test/alpha.git" },
      { alias: "alpha-2", url: "https://example.test/alpha-shared.git" },
    ]);
    assert.equal(service.repositories.some((repository) => "kind" in repository), false);
    assert.equal(service.deployments.some((deployment) => "id" in deployment || "environmentId" in deployment), false);
  } finally {
    await fixture.cleanup();
  }
});

test("redacts DMS credentials and stores SLS scope without service credentials", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const current = (await fixture.app.inject({ method: "GET", url: "/api/config" })).json();
    const repository = current.services[0].repositories[0];
    const sls = { region: "cn-test", project: "alpha-test", logstores: ["application"] };
    const dms = { url: "https://dms.example.test/sse", databases: [{ instanceAlias: "ALPHA", schemaName: "alpha" }], credentialUpdate: { mode: "replace", values: { authorization: "Bearer dms-token" } } };
    const payload = { name: "Alpha configured", description: "active capabilities", repositories: [{ ...repository, alias: "alpha-api" }], deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha-api", baseBranch: "main" }], capabilities: ["dms", "sls"], dms, sls }] };
    const updated = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload });
    assert.equal(updated.statusCode, 200, updated.body);
    const response = await fixture.app.inject({ method: "GET", url: "/api/config" });
    const deployment = response.json().services[0].deployments[0];
    assert.deepEqual(deployment.capabilities, ["dms", "sls"]);
    assert.equal(deployment.dms.credentialConfigured, true);
    assert.equal(deployment.sls.credentialConfigured, undefined);
    assert.doesNotMatch(response.body, /dms-token|sls-key|sls-secret/);
    const preserved = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: { ...payload, deployments: [{ ...payload.deployments[0], dms: { ...dms, credentialUpdate: { mode: "preserve" } }, sls: { ...sls, credentialUpdate: { mode: "preserve" } } }] } });
    assert.equal(preserved.statusCode, 200, preserved.body);
    const sqlite = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    try {
      const stored = JSON.parse(sqlite.prepare("SELECT config FROM service_deployments").get()!.config as string);
      assert.equal(stored.sls.accessKeySecret, undefined);
      assert.equal(stored.dms.authorization, "Bearer dms-token");
    } finally { sqlite.close(); }
    for (const [section, expected] of [
      [{ ...sls, credentialUpdate: { mode: "clear" } }, "service_sls_credentials_not_allowed"],
      [{ ...sls, accessKeySecret: "forbidden", credentialUpdate: { mode: "preserve" } }, "credential_fields_not_allowed"],
      [{ ...sls, credentialUpdate: { mode: "replace", values: { accessKeyId: "key" } } }, "service_sls_credentials_not_allowed"],
    ] as const) {
      const invalid = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: { ...payload, deployments: [{ ...payload.deployments[0], capabilities: ["sls"], sls: section }] } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error, expected);
    }
  } finally { await fixture.cleanup(); }
});

for (const field of ["alias", "url"] as const) test(`swaps repository ${field} values without replacing their identities`, async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Swap", ["prod", "test"], ["https://example.test/swap-first.git", "https://example.test/swap-second.git"]);
    const load = async () => JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/config" })).body).services[0] as { repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ environmentKey: string; repositoryBranches: Array<{ repositoryId: string; baseBranch: string }> }> };
    const initial = await load();
    const repositories = initial.repositories.map((repository, index) => ({ ...repository, [field]: initial.repositories[1 - index]![field] }));
    const payload = { name: "Swap", description: "Swap existing bindings", repositories, deployments: ["prod", "test"].map(environmentKey => ({ environmentKey, capabilities: [], repositoryBranches: repositories.map((repository, index) => ({ repositoryAlias: repository.alias, baseBranch: index ? "release" : "main" })) })) };
    const update = await fixture.app.inject({ method: "PATCH", url: "/api/services/swap", payload });
    assert.equal(update.statusCode, 200, update.body);
    const saved = await load();
    assert.deepEqual([...saved.repositories].sort((a, b) => a.id.localeCompare(b.id)), [...repositories].sort((a, b) => a.id.localeCompare(b.id)));
    for (const deployment of saved.deployments) for (const [index, repository] of repositories.entries()) {
      assert.equal(deployment.repositoryBranches.find(branch => branch.repositoryId === repository.id)?.baseBranch, index ? "release" : "main");
    }
    assert.equal((await fixture.app.inject({ method: "PATCH", url: "/api/services/swap", payload })).statusCode, 200);
    const beforeFailure = await load();
    const sqlite = new DatabaseSync(fixture.databaseFile);
    sqlite.exec("CREATE TRIGGER reject_repository_insert BEFORE INSERT ON service_repositories BEGIN SELECT RAISE(ABORT, 'fixture_repository_insert_failed'); END");
    sqlite.close();
    const failed = await fixture.app.inject({ method: "PATCH", url: "/api/services/swap", payload: { ...payload, name: "Must roll back", repositories: initial.repositories } });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(await load(), beforeFailure);
  } finally { await fixture.cleanup(); }
});

test("keeps repository order when changing only one binding", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Order", ["test"], ["https://example.test/order-first.git", "https://example.test/order-second.git"]);
    const load = async () => JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/config" })).body).services[0].repositories as Array<{ id: string; alias: string; url: string }>;
    const repositories = (await load()).map((repository, index) => index ? repository : { ...repository, alias: "renamed" });
    const response = await fixture.app.inject({ method: "PATCH", url: "/api/services/order", payload: { name: "Order", description: "", repositories, deployments: [{ environmentKey: "test", capabilities: [], repositoryBranches: repositories.map(repository => ({ repositoryAlias: repository.alias, baseBranch: "main" })) }] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await load(), repositories);
  } finally { await fixture.cleanup(); }
});

test("does not log configuration credentials when a database write fails", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Logging", ["test"]);
    const configuration = JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/config" })).body);
    const repository = configuration.services[0].repositories[0];
    const sqlite = new DatabaseSync(fixture.databaseFile);
    sqlite.exec("CREATE TRIGGER reject_deployment_update BEFORE UPDATE ON service_deployments BEGIN SELECT RAISE(ABORT, 'fixture_write_failed'); END");
    sqlite.close();
    const logs: string[] = [];
    fixture.app.log.error = (error: unknown) => { logs.push(inspect(error)); };
    for (const password of ["fixture-private-password", "issue_deployment_required"]) {
      logs.length = 0;
      const response = await fixture.app.inject({ method: "PATCH", url: "/api/services/logging", payload: {
        name: "Logging", description: "", repositories: [repository], deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: repository.alias, baseBranch: "main" }], capabilities: ["dms"], dms: { url: "https://dms.example.test/sse", databases: [{ instanceAlias: "LOGGING", schemaName: "logging" }], credentialUpdate: { mode: "replace", values: { authorization: `Bearer ${password}` } } } }],
      } });
      assert.equal(response.statusCode, 500, "credential values must not be interpreted as database errors");
      assert.ok(logs.length > 0);
      assert.equal((response.body + logs.join("\n")).includes(password), false);
      assert.match(logs.join("\n"), /database_operation_failed:SQLITE_CONSTRAINT/);
    }
  } finally { await fixture.cleanup(); }
});

test("reuses a removed repository alias without changing the retained repository identity", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alias", ["prod", "test"], ["https://example.test/alias-first.git", "https://example.test/alias-second.git"]);
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then(response => JSON.parse(response.body)) as { services: Array<{ repositories: Array<{ id: string; alias: string; url: string }> }> };
    const [retained, removed] = config.services[0]!.repositories;
    const payload = { name: "Alias", description: "Keep first repository", repositories: [{ ...retained!, alias: removed!.alias }], deployments: ["prod", "test"].map(environmentKey => ({ environmentKey, repositoryBranches: [{ repositoryAlias: removed!.alias, baseBranch: "main" }], capabilities: [] })) };
    const update = await fixture.app.inject({ method: "PATCH", url: "/api/services/alias", payload });
    assert.equal(update.statusCode, 200, update.body);
    const after = await fixture.app.inject({ method: "GET", url: "/api/config" }).then(response => JSON.parse(response.body)) as { services: Array<{ repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ repositoryBranches: Array<{ repositoryId: string }> }> }> };
    assert.deepEqual(after.services[0]!.repositories, [{ ...retained!, alias: removed!.alias }]);
    assert.ok(after.services[0]!.deployments.every(deployment => deployment.repositoryBranches.length === 1 && deployment.repositoryBranches[0]!.repositoryId === retained!.id));
    assert.equal((await fixture.app.inject({ method: "PATCH", url: "/api/services/alias", payload })).statusCode, 200);
  } finally { await fixture.cleanup(); }
});

test("updates and deletes Service configuration directly", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    await createService(fixture.app, "Beta");
    await fixture.app.inject({ method: "POST", url: "/api/repositories", payload: { name: "Alpha updated", url: servicePayload("Alpha updated").repositories[0]!.url } });
    const updated = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: servicePayload("Alpha updated") });
    assert.equal(updated.statusCode, 200, updated.body);
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(config.services.find(({ key }) => key === "alpha")!.name, "Alpha updated");
    const deleted = await fixture.app.inject({ method: "DELETE", url: "/api/services/beta" });
    assert.equal(deleted.statusCode, 204, deleted.body);
  } finally {
    await fixture.cleanup();
  }
});

test("validates the global model and repository ownership independently", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    await createService(fixture.app, "Beta");
    for (const [agent, expected] of [
      [{ provider: "enterprise-ai", model: "missing-model", thinkingLevel: "high", codemode: "off", runtime: {} }, "agent_model_not_available"],
      [{ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "off", codemode: "off", runtime: {} }, "agent_thinking_level_not_supported"],
    ] as const) {
      const response = await fixture.app.inject({ method: "PUT", url: "/api/config/agent", payload: agent });
      assert.equal(response.statusCode, 400);
      assert.equal((await json(response)).error, expected);
    }
    const staleService = servicePayload("Invalid");
    (staleService.deployments[0] as Record<string, unknown>).agent = testAgent;
    const staleResponse = await fixture.app.inject({ method: "POST", url: "/api/services", payload: staleService });
    assert.equal(staleResponse.statusCode, 400);
    assert.equal((await json(staleResponse)).error, "deployment_agent_not_allowed");
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; repositories: Array<{ id: string; alias: string; url: string }> }> };
    const alpha = config.services.find(({ key }) => key === "alpha")!;
    const beta = config.services.find(({ key }) => key === "beta")!;
    const crossService = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {
      name: "Must not persist",
      repositories: [{ id: beta.repositories[0]!.id, alias: "alpha", url: alpha.repositories[0]!.url }],
      deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha", baseBranch: "main" }], capabilities: [] }],
    } });
    assert.equal(crossService.statusCode, 400);
    assert.equal((await json(crossService)).error, "invalid_repository");
  } finally {
    await fixture.cleanup();
  }
});

test("updates the single global model only after every affected Issue is idle", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    await createIssue(fixture.app, "alpha");
    const issueId = fixture.engine.enqueued[0]!;
    const blocked = await fixture.app.inject({ method: "PUT", url: "/api/config/agent", payload: testAgent });
    assert.equal(blocked.statusCode, 409);
    assert.equal((await json(blocked)).error, "global_configuration_has_running_issues");

    fixture.engine.running.delete(issueId);
    const updated = await fixture.app.inject({ method: "PUT", url: "/api/config/agent", payload: testAgent });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.ok(fixture.engine.closedSessions.includes(issueId));
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { agent: unknown };
    assert.deepEqual(config.agent, testAgent);
  } finally {
    await fixture.cleanup();
  }
});

test("reserves affected Issues and commits Service changes only after sessions close", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const issue = await createIssue(fixture.app, "alpha");
    const issueId = fixture.engine.enqueued[0]!;
    fixture.engine.running.delete(issueId);
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }> }> }> };
    const payload = {
      name: "Alpha renamed",
      description: "serialized",
      repositories: config.services[0]!.repositories,
      deployments: [{ environmentKey: "test", repositoryBranches: config.services[0]!.deployments[0]!.repositoryBranches, capabilities: [] }],
    };
    let closeStarted!: () => void;
    let releaseClose!: () => void;
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
    fixture.engine.closeSessionHook = async () => { closeStarted(); await gate; };
    const update = fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload });
    await started;
    const message = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "must wait" } });
    assert.equal(message.statusCode, 409);
    let readSettled = false;
    const during = fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body) as { services: Array<{ name: string }> }).finally(() => { readSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readSettled, false);
    releaseClose();
    assert.equal((await update).statusCode, 200);
    assert.equal((await during).services[0]!.name, "Alpha renamed");

    fixture.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    const failed = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: { ...payload, name: "Must not persist" } });
    assert.equal(failed.statusCode, 500);
    const after = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ name: string }> };
    assert.equal(after.services[0]!.name, "Alpha renamed");
  } finally {
    await fixture.cleanup();
  }
});
