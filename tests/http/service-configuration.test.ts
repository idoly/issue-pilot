import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCapabilityConfiguration } from "../../src/capabilities/registry.ts";

test("validates capability connection settings when saving page configuration", () => {
  const databaseUrl = "mysql://192.168.27.122:3306/srm_prod";
  assert.deepEqual(parseCapabilityConfiguration("db", { url: databaseUrl, username: "reader", password: "secret" }), {
    url: databaseUrl, username: "reader", password: "secret",
  });
  assert.throws(() => parseCapabilityConfiguration("db", { url: `${databaseUrl}?useSSL=false`, username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "mysql://db.example.test/orders", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "mysql://db.example.test:3306/orders/archive", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "mysql://db.example.test:3306/orders%2Farchive", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "jdbc:mysql://db.example.test/orders", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "mariadb://db.example.test/orders", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("db", { url: "mysql://hidden:secret@db.example.test/orders", username: "reader", password: "secret" }), /invalid_db_url/);
  assert.throws(() => parseCapabilityConfiguration("es", { url: "https://es.example.test", username: "reader", password: "" }), /invalid_es_credentials/);
  assert.throws(() => parseCapabilityConfiguration("redis", { host: "redis.example.test", port: 70_000, username: "", database: 0 }), /invalid_redis_port/);
  assert.throws(() => parseCapabilityConfiguration("redis", { host: "redis.example.test", port: 6379, username: "", database: -1 }), /invalid_redis_database/);
  assert.throws(() => parseCapabilityConfiguration("mq", { host: "mq.example.test", port: 5672, managementPort: 0, username: "reader", password: "secret", virtualHost: "/" }), /invalid_mq_management_port/);
  const dmsDatabase = { instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" };
  assert.deepEqual(parseCapabilityConfiguration("dms", { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [dmsDatabase] }), { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [dmsDatabase] });
  assert.throws(() => parseCapabilityConfiguration("dms", { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [] }), /invalid_dms_databases/);
  assert.throws(() => parseCapabilityConfiguration("dms", { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [dmsDatabase, { ...dmsDatabase, databaseId: "456" }] }), /duplicate_dms_database_schema/);
  assert.throws(() => parseCapabilityConfiguration("dms", { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [dmsDatabase, { ...dmsDatabase, instanceAlias: "ARCHIVE-PROD", schemaName: "archive" }] }), /duplicate_dms_database_id/);
  for (const url of ["", "http://dms.example.test/sse", "https://user@dms.example.test/sse", "https://dms.example.test/sse?token=secret"]) {
    assert.throws(() => parseCapabilityConfiguration("dms", { url, authorization: "Bearer token", databases: [dmsDatabase] }), /invalid_dms_url/);
  }
  for (const authorization of ["", "token", "Beare token", "Bearer token with spaces"]) {
    assert.throws(() => parseCapabilityConfiguration("dms", { url: "https://dms.example.test/sse", authorization, databases: [dmsDatabase] }), /invalid_dms_authorization/);
  }
});

test("requires explicit Nacos and SLS page scopes", () => {
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: [], username: "", password: "" }), /invalid_nacos_data_ids/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test/path", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", password: "" }), /invalid_nacos_server_url/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "bad/group", dataIds: ["orders.yaml"], username: "", password: "" }), /invalid_nacos_group/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", password: "" }), /invalid_nacos_credentials/);
  assert.throws(() => parseCapabilityConfiguration("sls", { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "orders-test", logstores: [] }), /invalid_sls_scope/);
  assert.throws(() => parseCapabilityConfiguration("sls", { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "INVALID", logstores: ["application"] }), /invalid_sls_scope/);
});
