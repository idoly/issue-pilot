import assert from "node:assert/strict";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createIssue, createService, json, servicePayload, testAgent } from "./fixture.ts";

test("projects users, environments, models, repositories, and deployments without internal fields", async () => {
  const fixture = await createApiFixture();
  try {
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    const currentUsers = await Promise.all(Array.from({ length: 4 }, () => fixture.app.inject({ method: "GET", url: "/api/me" })));
    assert.deepEqual(currentUsers.map((response) => response.statusCode), [200, 200, 200, 200]);
    assert.equal((await json(currentUsers[0]!)).subject, issuePilotConfig.subject);
    const users = JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/users" })).body) as Array<{ subject: string }>;
    assert.deepEqual(users.map(({ subject }) => subject), issuePilotConfig.users.map(({ subject }) => subject));
    const switched = await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "hjx4403@xianhengguoji.com" } });
    assert.deepEqual(await json(switched), { subject: "hjx4403@xianhengguoji.com", name: "黄佳鑫", email: "hjx4403@xianhengguoji.com" });
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/me", headers: { "x-issue-pilot-subject": "missing-user" } })).statusCode, 400);

    await createService(fixture.app, "Alpha", ["test"], ["https://example.test/alpha.git", "https://example.test/alpha-shared.git"]);
    const response = await fixture.app.inject({ method: "GET", url: "/api/config" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers.pragma, "no-cache");
    const config = await json(response) as {
      environments: Array<Record<string, unknown>>;
      agentModels: Array<Record<string, unknown>>;
      capabilityCatalog: Array<{ key: string }>;
      services: Array<{ key: string; repositories: Array<Record<string, unknown>>; deployments: Array<Record<string, unknown>> }>;
    };
    assert.deepEqual(config.environments.map(({ key }) => key).sort(), ["dev", "prod", "test"]);
    assert.equal(config.environments.some((environment) => "id" in environment || "kind" in environment), false);
    assert.deepEqual(Object.keys(config.agentModels[0]!).sort(), ["id", "provider", "thinkingLevels"]);
    assert.deepEqual(config.capabilityCatalog.map(({ key }) => key), ["playwright", "nacos", "db", "redis", "mq", "es", "dms", "sls"]);
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

test("round-trips every capability through the shared configuration registry", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; repositories: Array<{ id: string; alias: string; url: string }> }> };
    const repository = config.services[0]!.repositories[0]!;
    const payload = {
      name: "Alpha configured",
      description: "all capabilities",
      repositories: [{ ...repository, alias: "alpha-api" }],
      deployments: [{
        environmentKey: "test",
        repositoryBranches: [{ repositoryAlias: "alpha-api", baseBranch: "main" }],
        capabilities: ["sls", "dms", "es", "mq", "redis", "db", "nacos", "playwright"],
        agent: testAgent,
        playwright: { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "browser-secret" },
        nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["alpha.yaml"], username: "operator", password: "nacos-secret" },
        db: { url: "mysql://db.example.test:3306/alpha", username: "reader", password: "db-secret" },
        redis: { host: "redis.example.test", port: 6379, username: "", password: "redis-secret", database: 0 },
        mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", password: "mq-secret", virtualHost: "/" },
        es: { url: "http://es.example.test/proxy", username: "", password: "" },
        dms: { accessKeyId: "dms-key", accessKeySecret: "dms-secret", dbId: "123456", logic: true, tid: "987654" },
        sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "alpha-test", logstores: ["application"] },
      }],
    };
    const update = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload });
    assert.equal(update.statusCode, 200, update.body);
    const saved = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ deployments: Array<Record<string, unknown>> }> };
    const deployment = saved.services[0]!.deployments[0]!;
    assert.deepEqual(deployment.capabilities, ["playwright", "nacos", "db", "redis", "mq", "es", "dms", "sls"]);
    assert.deepEqual(deployment.dms, { accessKeyId: "dms-key", accessKeySecret: "dms-secret", dbId: "123456", logic: true, tid: "987654" });
    assert.deepEqual(deployment.playwright, { baseUrl: "https://alpha.example.test/admin/login", username: "operator", password: "browser-secret" });
    assert.deepEqual(deployment.sls, { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "alpha-test", logstores: ["application"] });

    const missingPassword = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {
      ...payload,
      deployments: [{ ...payload.deployments[0], capabilities: ["db"], db: { url: "mysql://db.example.test:3306/alpha", username: "reader", password: "" } }],
    } });
    assert.equal(missingPassword.statusCode, 400);
    assert.equal((await json(missingPassword)).error, "invalid_db_password");
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
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ key: string; repositories: Array<{ id: string; alias: string; url: string }> }> };
    const alpha = config.services.find(({ key }) => key === "alpha")!;
    const beta = config.services.find(({ key }) => key === "beta")!;
    const crossService = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: {
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
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ repositories: Array<{ id: string; alias: string; url: string }>; deployments: Array<{ repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }> }> }> };
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
    const update = fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload });
    await started;
    const message = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "must wait" } });
    assert.equal(message.statusCode, 409);
    const during = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ name: string }> };
    assert.equal(during.services[0]!.name, "Alpha");
    releaseClose();
    assert.equal((await update).statusCode, 200);

    fixture.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    const failed = await fixture.app.inject({ method: "PATCH", url: "/api/services/alpha", payload: { ...payload, name: "Must not persist" } });
    assert.equal(failed.statusCode, 500);
    const after = await fixture.app.inject({ method: "GET", url: "/api/config" }).then((response) => JSON.parse(response.body)) as { services: Array<{ name: string }> };
    assert.equal(after.services[0]!.name, "Alpha renamed");
  } finally {
    await fixture.cleanup();
  }
});
