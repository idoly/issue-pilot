import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentContext } from "../../src/configuration/service-context.ts";
import type { StoredDeploymentConfig } from "../../src/domain/contracts.ts";

test("generated descriptions include exact capability parameters without secrets, internal access identifiers or repeated branches", () => {
  const configuration: StoredDeploymentConfig = {
    redis: { host: "redis.prod.internal", port: 6379, username: "reader", database: 7, password: "private-redis-password" },
    nacos: { serverUrl: "https://config.example.test", namespace: "prod-namespace", group: "PROD_GROUP", dataIds: ["orders.yaml"], username: "operator", password: "private-nacos-password" },
    dms: { url: "https://dms.example.test/sse", authorization: "private-dms-token", databases: [{ instanceAlias: "prod-instance", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" }] },
    sls: { accessKeyId: "private-sls-id", accessKeySecret: "private-sls-secret", region: "cn-hangzhou", project: "prod-project", logstores: ["orders-api", "gateway"] },
    mcpServices: ["docs"], archivedDevelopment: { password: "private-archive" },
  };
  const context = deploymentContext({ key: "prod", name: "正式" }, configuration, [{ id: "docs", name: "Docs", url: "https://docs.example.test/mcp?key=private-query-token", transport: "streamable_http", enabled: true }]);
  for (const value of ["prod-instance", "orders", "DatabaseId", "42", "orders-api", "gateway", "Docs"]) assert.ok(context.includes(value), value);
  assert.doesNotMatch(context, /private-redis-password|private-nacos-password|private-archive|private-dms-token|private-sls-id|private-sls-secret|访问配置|代码基准分支/);
  assert.doesNotMatch(context, /prod-namespace|PROD_GROUP|redis.prod.internal|private-query-token/);
  assert.match(context, /#### SLS\n\n\| \| \|/);
  assert.match(context, /<code>orders-api<\/code><br><code>gateway<\/code>/);
  assert.doesNotMatch(context, /用户.*&quot;&quot;/);
  const displayed = deploymentContext({ key: "prod", name: "正式" }, configuration, [], configuration);
  assert.doesNotMatch(displayed, /private-dms-token|private-sls-id|private-sls-secret|Authorization|AccessKey/);
  assert.doesNotMatch(displayed, /private-redis-password|private-nacos-password/);
  const development = deploymentContext({ key: "dev", name: "开发" }, configuration, []);
  assert.match(development, /继承正式和测试/);
  assert.doesNotMatch(development, /prod-namespace|prod-instance|prod-project|redis.prod.internal/);
});
