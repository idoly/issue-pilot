import assert from "node:assert/strict";
import { test } from "node:test";

import { createCapabilityExecutor, executeCapability } from "../../src/capabilities/broker.ts";
import type { ToolRuntime } from "../../src/tool-runtime.ts";
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
    capabilities: ["nacos", "db", "redis", "mq", "es", "dms", "sls"],
    nacos: { deploymentId: "deployment", serverUrl: "https://nacos.example.test:443", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["app.yaml"] },
    db: { deploymentId: "deployment" },
    dms: { deploymentId: "deployment", dbId: "123456", logic: false },
    redis: { deploymentId: "deployment" },
    mq: { deploymentId: "deployment", virtualHost: "/" },
    es: { deploymentId: "deployment" },
    sls: { deploymentId: "deployment", region: "cn-test", project: "project-test", logstores: ["application"] },
    repositories: [],
  },
});

test("injects the selected tool runtime into Aliyun capabilities", async () => {
  const unavailable: ToolRuntime = { run: () => Promise.reject(new Error("tool_runtime_unavailable")) };
  const execute = createCapabilityExecutor(unavailable);
  await assert.rejects(execute(policy, {
    dms: { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false },
  }, "dms", { statement: "SELECT 1 LIMIT 1" }), /tool_runtime_unavailable/);
});

test("validates capability input at the broker execution boundary", async () => {
  const config = {
    nacos: { serverUrl: "https://nacos.example.test", username: "" },
    db: { url: "mysql://db.example.test:3306/app", username: "reader", password: "secret" },
    dms: { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false },
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
    ["dms", { statement: "SELECT 1 LIMIT 1", extra: true }, "invalid_dms_input"],
  ] as const) {
    await assert.rejects(executeCapability(policy, config, capability, input), new RegExp(error));
  }
});
