import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createIssue, createService, json, servicePayload, testAgent } from "./fixture.ts";

const matchRevision = (revision: string) => ({ "if-match": revision });

test("projects bootstrap user, environments, models, repositories, and deployments without internal fields", async () => {
  const fixture = await createApiFixture();
  try {
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const currentUser = await fixture.app.inject({ method: "GET", url: "/api/me" });
    assert.equal(currentUser.statusCode, 200);
    assert.deepEqual(await json(currentUser), issuePilotConfig.bootstrapUser);
    const users = JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/users" })).body) as Array<{ subject: string }>;
    assert.deepEqual(users.map(({ subject }) => subject), [issuePilotConfig.bootstrapUser.subject]);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "missing-user" } })).statusCode, 400);

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
      agentModels: Array<Record<string, unknown>>;
      services: Array<{ key: string; revision: string; repositories: Array<Record<string, unknown>>; deployments: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(config.environments.map(({ key }) => key).sort(), ["dev", "prod", "test"]);
    assert.equal(config.environments.some((environment) => "id" in environment || "kind" in environment), false);
    assert.deepEqual(Object.keys(config.agentModels[0]!).sort(), ["id", "provider", "thinkingLevels"]);
    const service = config.services[0]!;
    assert.equal(service.key, "alpha");
    assert.match(service.revision, /^[a-f0-9]{64}$/);
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
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ revision: string; repositories: Array<{ id: string; alias: string; url: string }> }> };
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
        capabilities: ["sls", "dms", "es", "mq", "redis", "db", "nacos"],
        agent: testAgent,
        nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha.yaml"], username: "operator", credentialUpdate: replace({ password: "nacos-secret" }) },
        db: { url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: replace({ password: "db-secret" }) },
        redis: { host: "redis.example.test", port: 6379, username: "", database: 0, credentialUpdate: replace({ password: "redis-secret" }) },
        mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", virtualHost: "/", credentialUpdate: replace({ password: "mq-secret" }) },
        es: { url: "http://es.example.test/proxy", username: "", credentialUpdate: { mode: "clear" } },
        dms: { dbId: "123456", logic: true, tid: "987654", credentialUpdate: replace({ accessKeyId: "dms-key", accessKeySecret: "dms-secret" }) },
        sls: { region: "cn-test", project: "alpha-test", logstores: ["application"], credentialUpdate: replace({ accessKeyId: "sls-key", accessKeySecret: "sls-secret" }) },
      }],
    };
    const update = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(initialService.revision), payload });
    assert.equal(update.statusCode, 200, update.body);

    const response = await fixture.app.inject({ method: "GET", url: "/api/config" });
    const saved = JSON.parse(response.body) as { services: Array<{ revision: string; deployments: Array<Record<string, unknown>> }> };
    const savedService = saved.services[0]!;
    assert.notEqual(savedService.revision, initialService.revision);
    const deployment = savedService.deployments[0]!;
    assert.deepEqual(deployment.capabilities, ["nacos", "db", "redis", "mq", "es", "dms", "sls"]);
    assert.deepEqual(deployment.dms, { dbId: "123456", logic: true, tid: "987654", credentialConfigured: true });
    assert.equal("playwright" in deployment, false);
    assert.deepEqual(deployment.sls, { region: "cn-test", project: "alpha-test", logstores: ["application"], credentialConfigured: true });
    assert.deepEqual(deployment.es, { url: "http://es.example.test/proxy", username: "", credentialConfigured: false });
    const secrets = ["nacos-secret", "db-secret", "redis-secret", "mq-secret", "dms-key", "dms-secret", "sls-key", "sls-secret"];
    assert.equal(secrets.some((secret) => response.body.includes(secret)), false);
    assert.equal(response.body.includes("accessKeyId") || response.body.includes("accessKeySecret") || response.body.includes("password"), false);

    const sqlite = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    const stored = JSON.parse(sqlite.prepare("SELECT config FROM service_deployments").get()!.config as string) as Record<string, Record<string, string>>;
    sqlite.close();
    assert.equal("playwright" in stored, false);
    assert.equal(stored.db!.password, "db-secret");
    assert.equal(stored.dms!.accessKeyId, "dms-key");
    assert.equal(stored.dms!.accessKeySecret, "dms-secret");

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
        db: preserve(originalDeployment.db),
        redis: preserve(originalDeployment.redis),
        mq: preserve(originalDeployment.mq),
        dms: { ...preserve(originalDeployment.dms), logic: false },
        sls: preserve(originalDeployment.sls),
      }],
    };
    const preserved = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(savedService.revision), payload: preservedPayload });
    assert.equal(preserved.statusCode, 200, preserved.body);
    const afterPreserve = new DatabaseSync(fixture.databaseFile, { readOnly: true });
    const preservedConfig = JSON.parse(afterPreserve.prepare("SELECT config FROM service_deployments").get()!.config as string) as Record<string, Record<string, unknown>>;
    afterPreserve.close();
    assert.equal(preservedConfig.db!.password, "db-secret");
    assert.equal(preservedConfig.dms!.accessKeySecret, "dms-secret");
    assert.equal(preservedConfig.dms!.logic, false);

    const afterPreserveRevision = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((result) => (JSON.parse(result.body) as { services: Array<{ revision: string }> }).services[0]!.revision);
    assert.notEqual(afterPreserveRevision, savedService.revision);
    const cleared = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(afterPreserveRevision), payload: {
      ...payload,
      deployments: [{ ...originalDeployment, capabilities: ["nacos"], nacos: { ...originalDeployment.nacos, username: "", credentialUpdate: { mode: "clear" } } }],
    } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const clearedConfig = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((result) => JSON.parse(result.body)) as { services: Array<{ revision: string; deployments: Array<{ nacos: Record<string, unknown> }> }> };
    const clearedService = clearedConfig.services[0]!;
    assert.equal(clearedService.deployments[0]!.nacos.credentialConfigured, false);

    for (const [section, error] of [
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: { mode: "clear" } }, "credential_required"],
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", password: "forbidden", credentialUpdate: { mode: "preserve" } }, "credential_fields_not_allowed"],
      [{ url: "mysql://db.example.test:3306/alpha", username: "reader", credentialUpdate: { mode: "replace", values: { password: "" } } }, "invalid_credential_replacement"],
    ] as const) {
      const invalid = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(clearedService.revision), payload: {
        ...payload,
        deployments: [{ ...payload.deployments[0], capabilities: ["db"], db: section }],
      } });
      assert.equal(invalid.statusCode, 400);
      assert.equal((await json(invalid)).error, error);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects stale Service updates and deletes with opaque configuration revisions", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    await createService(fixture.app, "Beta");
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; revision: string }> };
    const alpha = config.services.find(({ key }) => key === "alpha")!;
    const beta = config.services.find(({ key }) => key === "beta")!;
    const updatePayload = servicePayload("Alpha updated");

    const missing = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: updatePayload });
    assert.equal(missing.statusCode, 428);
    assert.equal((await json(missing)).error, "service_revision_required");
    const stale = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision("0".repeat(64)), payload: updatePayload });
    assert.equal(stale.statusCode, 409);
    assert.equal((await json(stale)).error, "service_configuration_changed");
    assert.deepEqual(fixture.engine.closedSessions, []);

    const updated = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(alpha.revision), payload: updatePayload });
    assert.equal(updated.statusCode, 200, updated.body);
    const afterUpdate = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string; revision: string }> };
    const updatedAlpha = afterUpdate.services.find(({ key }) => key === "alpha")!;
    assert.equal(updatedAlpha.name, "Alpha updated");
    assert.notEqual(updatedAlpha.revision, alpha.revision);
    const repeated = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(alpha.revision), payload: { ...updatePayload, name: "Must not persist" } });
    assert.equal(repeated.statusCode, 409);
    const afterRepeated = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; name: string }> };
    assert.equal(afterRepeated.services.find(({ key }) => key === "alpha")!.name, "Alpha updated");

    const missingDelete = await fixture.app.inject({ method: "DELETE", url: "/api/services/beta" });
    assert.equal(missingDelete.statusCode, 428);
    const staleDelete = await fixture.app.inject({ method: "DELETE", url: "/api/services/beta", headers: matchRevision("0".repeat(64)) });
    assert.equal(staleDelete.statusCode, 409);
    const deleted = await fixture.app.inject({ method: "DELETE", url: "/api/services/beta", headers: matchRevision(beta.revision) });
    assert.equal(deleted.statusCode, 204, deleted.body);
  } finally {
    await fixture.cleanup();
  }
});

test("validates models and repository ownership before replacing a Service", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    await createService(fixture.app, "Beta");
    for (const [agent, expected] of [
      [{ provider: "enterprise-ai", model: "missing-model", thinkingLevel: "high" }, "agent_model_not_available"],
      [{ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "off" }, "agent_thinking_level_not_supported"],
    ] as const) {
      const invalid = servicePayload("Invalid");
      invalid.deployments[0]!.agent = agent as never;
      const response = await fixture.app.inject({ method: "POST", url: "/api/services", payload: invalid });
      assert.equal(response.statusCode, 400);
      assert.equal((await json(response)).error, expected);
    }
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; revision: string; repositories: Array<{ id: string; alias: string; url: string }> }> };
    const alpha = config.services.find(({ key }) => key === "alpha")!;
    const beta = config.services.find(({ key }) => key === "beta")!;
    const crossService = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(alpha.revision), payload: {
      name: "Must not persist",
      repositories: [{ id: beta.repositories[0]!.id, alias: "alpha", url: alpha.repositories[0]!.url }],
      deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryAlias: "alpha", baseBranch: "main" }], capabilities: [], agent: testAgent }],
    } });
    assert.equal(crossService.statusCode, 400);
    assert.equal((await json(crossService)).error, "invalid_repository");
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
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ revision: string; repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }> }> }> };
    const payload = {
      name: "Alpha renamed",
      description: "serialized",
      repositories: config.services[0]!.repositories,
      deployments: [{ environmentKey: "test", repositoryBranches: config.services[0]!.deployments[0]!.repositoryBranches, capabilities: [], agent: testAgent }],
    };
    let closeStarted!: () => void;
    let releaseClose!: () => void;
    const started = new Promise<void>((resolve) => { closeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
    fixture.engine.closeSessionHook = async () => { closeStarted(); await gate; };
    const update = fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(config.services[0]!.revision), payload });
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

    const updatedRevision = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => (JSON.parse(response.body) as { services: Array<{ revision: string }> }).services[0]!.revision);
    fixture.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    const failed = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", headers: matchRevision(updatedRevision), payload: { ...payload, name: "Must not persist" } });
    assert.equal(failed.statusCode, 500);
    const after = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ name: string }> };
    assert.equal(after.services[0]!.name, "Alpha renamed");
  } finally {
    await fixture.cleanup();
  }
});
