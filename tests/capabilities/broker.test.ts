import assert from "node:assert/strict";
import test from "node:test";

import { executeCapability } from "../../src/capabilities/broker.ts";
import { createIssuePolicy } from "../../src/pi/policy.ts";

const policy = createIssuePolicy({
  issueKey: "ISSUE-20260808-001",
  issueType: "smart_analysis",
  workspaceRoot: "/tmp/issue-pilot-broker-test",
  model: { provider: "test", modelId: "test", thinkingLevel: "off" },
  service: {
    serviceKey: "service",
    environmentKey: "test",
    environmentKind: "test",
    capabilities: ["playwright", "nacos", "db", "redis", "mq", "es", "sls"],
    playwright: { deploymentId: "deployment", baseUrl: "https://app.example.test" },
    nacos: { deploymentId: "deployment", serverUrl: "https://nacos.example.test:443", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["app.yaml"] },
    db: { deploymentId: "deployment" },
    redis: { deploymentId: "deployment" },
    mq: { deploymentId: "deployment", virtualHost: "/" },
    es: { deploymentId: "deployment" },
    sls: { deploymentId: "deployment", region: "cn-test", project: "project-test", logstores: ["application"] },
    repositories: [],
  },
});

test("validates capability input at the broker execution boundary", async () => {
  const config = {
    playwright: { baseUrl: "https://app.example.test", username: "", password: "" },
    nacos: { serverUrl: "https://nacos.example.test", username: "" },
    db: { url: "mysql://db.example.test:3306/app", username: "reader", password: "secret" },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", password: "secret", virtualHost: "/" },
    es: { url: "http://es.example.test", username: "" },
    sls: { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "project-test", logstores: ["application"] },
  };
  for (const [capability, input, error] of [
    ["es", { action: "delete" }, "invalid_es_input"],
    ["es", { action: "search", extra: true }, "invalid_es_input"],
    ["redis", { action: "del", key: "key" }, "invalid_redis_input"],
    ["mq", { action: "delete", queue: "queue" }, "invalid_mq_input"],
    ["db", { statement: "SELECT 1", extra: true }, "invalid_db_input"],
    ["playwright", { actions: [{ type: "login", username_selector: "#user" }] }, "invalid_playwright_input"],
  ] as const) {
    await assert.rejects(executeCapability(policy, config, capability, input), new RegExp(error));
  }
});
