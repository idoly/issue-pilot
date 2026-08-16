import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/pi/tools.ts";
import type { ToolRuntime } from "../../src/tool-runtime.ts";

const context: AgentSessionContext = {
  issueKey: "ISSUE-20260808-001",
  serviceKey: "orders",
  environmentKey: "prod",
  model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
  capabilities: ["db", "redis", "dms"],
  canModifyCode: false,
};

test("creates only context-selected SDK capability tools", () => {
  const tools = createCapabilityTools(context, {
    db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["db", "redis", "dms"]);
  assert.match(tools[0]?.promptSnippet ?? "", /read-only MySQL/);
  assert.match(tools[1]?.promptGuidelines?.[0] ?? "", /allowlisted read operations/);
  assert.match(tools[2]?.promptSnippet ?? "", /Alibaba Cloud DMS/);
});

test("validates Pi tool input and passes the application tool runtime directly", async () => {
  const unavailable: ToolRuntime = { run: () => Promise.reject(new Error("tool_runtime_unavailable")) };
  const tools = createCapabilityTools(context, {
    db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false },
  }, unavailable);
  const redis = tools.find((tool) => tool.name === "redis")!;
  const dms = tools.find((tool) => tool.name === "dms")!;
  await assert.rejects(redis.execute("call", { action: "del", key: "order" }, undefined, undefined, {} as never), /invalid_redis_input/);
  await assert.rejects(dms.execute("call", { statement: "SELECT 1 LIMIT 1" }, undefined, undefined, {} as never), /tool_runtime_unavailable/);
});
