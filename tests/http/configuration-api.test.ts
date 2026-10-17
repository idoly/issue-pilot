import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadConfigurationCatalog } from "../../src/configuration/read.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createApiFixture, createIssue, createService, json, servicePayload, testAgent } from "./fixture.ts";

test("configuration snapshots do not block Workspace writes", async () => {
  const fixture = await createApiFixture();
  const connection = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Snapshot", ["dev"]);
    await createIssue(fixture.app, "snapshot", "dev");
    fixture.engine.running.clear();
    // The snapshot begins before the write, and must hold no writer lock across awaits.
    const snapshot = loadConfigurationCatalog(connection.db);
    const update = connection.client.execute("update issue_workspaces set status = 'preparing', runtime_ready = 0 returning issue_id");
    const [catalog, result] = await Promise.all([snapshot, update]);
    assert.equal(catalog.services.length, 1);
    assert.equal(result.rows.length, 1);
  } finally { connection.close(); await fixture.cleanup(); }
});

test("projects bootstrap user, environments, models, repositories, and deployments without internal fields", async () => {
  const fixture = await createApiFixture();
  try {
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const currentUser = await fixture.app.inject({ method: "GET", url: "/api/me" });
    assert.equal(currentUser.statusCode, 200);
    assert.deepEqual(await json(currentUser), { ...issuePilotConfig.bootstrapUser, role: "developer" });
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
    assert.deepEqual(config.agent, { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" });
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

test("redacts stored credentials and applies explicit preserve, replace, and clear updates", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ repositories: Array<{ id: string; alias: string; url: string }> }> };
    const initialService = config.services[0]!;
    const repository = initialService.repositories[0]!;
    const replace = (values: Record<string, string>) => ({ mode: "replace", values });
    const payload = {
      name: "Alpha configured",
      description: "all capabilities",
      repositories: [{ ...repository, alias: "alpha-api" }],
      deployments: [{
        environmentKey: "test",
        repositoryBranches: [{ repositoryAlias: "alpha-api", baseBranch: "main" }],
        capabilities: ["es", "mq", "redis", "db", "nacos"],
        nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha.yaml"], username: "operator", credentialUpdate: replace({ password: "nacos-secret" }) },
        db: { databases: [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: replace({ password: "db-secret" }) }] },
        redis: { host: "redis.example.test", port: 6379, username: "", database: 0, credentialUpdate: replace({ password: "redis-secret" }) },
        mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", virtualHost: "/", credentialUpdate: replace({ password: "mq-secret" }) },
        es: { url: "http://es.example.test/proxy", username: "", credentialUpdate: { mode: "clear" } },
      }],
    };
    const update = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload });
    assert.equal(update.statusCode, 200, update.body);

    const response = await fixture.app.inject({ method: "GET", url: "/api/config" });
    const saved = JSON.parse(response.body) as { services: Array<{ deployments: Array<Record<string, unknown>> }> };
    const savedService = saved.services[0]!;
    const deployment = savedService.deployments[0]!;
    assert.deepEqual(deployment.capabilities, ["nacos", "db", "redis", "mq", "es"]);
    assert.deepEqual(deployment.db, { databases: [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialConfigured: true }] });
    assert.equal("dms" in deployment, false);
    assert.equal("playwright" in deployment, false);
    assert.equal("sls" in deployment, false);
    assert.deepEqual(deployment.es, { url: "http://es.example.test/proxy", username: "", credentialConfigured: false });
    const secrets = ["nacos-secret", "db-secret", "redis-secret", "mq-secret", "dms-token", "sls-key", "sls-secret"];
    assert.equal(secrets.some((secret) => response.body.includes(secret)), false);


    const sqlite = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    const stored = JSON.parse(sqlite.prepare("SELECT config FROM service_deployments").get()!.config as string) as Record<string, Record<string, string>>;
    sqlite.close();
    assert.equal("playwright" in stored, false);
    assert.equal((stored.db!.databases as unknown as Array<{ password: string }>)[0]!.password, "db-secret");
    assert.equal("dms" in stored, false);

    const preserve = <Value extends Record<string, unknown>>(section: Value) => {
      const { credentialUpdate: _credentialUpdate, ...configuration } = section;
      return { ...configuration, credentialUpdate: { mode: "preserve" } };
    };
    const originalDeployment = payload.deployments[0]!;
    const preservedPayload = {
      ...payload,
      deployments: [{
        ...originalDeployment,
        nacos: preserve(originalDeployment.nacos),
        db: { databases: originalDeployment.db.databases.map((database) => preserve(database)) },
        redis: preserve(originalDeployment.redis),
        mq: preserve(originalDeployment.mq),
      }],
    };
    const preserved = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: preservedPayload });
    assert.equal(preserved.statusCode, 200, preserved.body);
    const afterPreserve = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    const preservedConfig = JSON.parse(afterPreserve.prepare("SELECT config FROM service_deployments").get()!.config as string) as Record<string, Record<string, unknown>>;
    afterPreserve.close();
    assert.equal((preservedConfig.db!.databases as Array<{ password: string }>)[0]!.password, "db-secret");
    assert.equal("dms" in preservedConfig, false);

    const cleared = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {
      ...payload,
      deployments: [{ ...originalDeployment, capabilities: ["nacos"], nacos: { ...originalDeployment.nacos, username: "", credentialUpdate: { mode: "clear" } } }],
    } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const clearedConfig = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((result) => JSON.parse(result.body)) as { services: Array<{ deployments: Array<{ nacos: Record<string, unknown> }> }> };
    const clearedService = clearedConfig.services[0]!;
    assert.equal(clearedService.deployments[0]!.nacos.credentialConfigured, false);

    for (const [section, error] of [
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: { mode: "clear" } }, "credential_required"],
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", password: "forbidden", credentialUpdate: { mode: "preserve" } }, "credential_fields_not_allowed"],
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: { mode: "replace", values: { password: "" } } }, "invalid_db_password"],
    ] as const) {
      const invalid = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {
        ...payload,
        deployments: [{ ...payload.deployments[0], capabilities: ["db"], db: { databases: [section] } }],
      } });
      assert.equal(invalid.statusCode, 400);
      assert.equal((await json(invalid)).error, error);
    }
  } finally {
    await fixture.cleanup();
  }
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
      [{ provider: "enterprise-ai", model: "missing-model", thinkingLevel: "high" }, "agent_model_not_available"],
      [{ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "off" }, "agent_thinking_level_not_supported"],
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
