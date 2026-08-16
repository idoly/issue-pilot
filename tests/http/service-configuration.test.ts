import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCapabilityConfiguration } from "../../src/capabilities/registry.ts";
import { parseCapabilities } from "../../src/http/service-configuration.ts";

test("rejects removed, unknown, or duplicate capability declarations", () => {
  assert.deepEqual(parseCapabilities(["db", "redis"]), ["db", "redis"]);
  assert.throws(() => parseCapabilities(["playwright"]), /invalid_capabilities/);
  assert.throws(() => parseCapabilities(["db", "unknown"]), /invalid_capabilities/);
  assert.throws(() => parseCapabilities(["db", "db"]), /invalid_capabilities/);
});

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
  assert.deepEqual(parseCapabilityConfiguration("dms", { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "987654" }), { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "987654" });
  assert.deepEqual(parseCapabilityConfiguration("dms", { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: true, tid: "" }), { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: true });
  for (const dbId of ["orders", "0", "2147483648"]) assert.throws(() => parseCapabilityConfiguration("dms", { accessKeyId: "key", accessKeySecret: "secret", dbId, logic: false }), /invalid_dms_scope/);
  assert.throws(() => parseCapabilityConfiguration("dms", { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: "false" }), /invalid_dms_scope/);
  assert.throws(() => parseCapabilityConfiguration("dms", { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "9007199254740992" }), /invalid_dms_scope/);
});

test("requires explicit Nacos and SLS page scopes", () => {
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: [], username: "", password: "" }), /invalid_nacos_data_ids/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test/path", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", password: "" }), /invalid_nacos_server_url/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "bad/group", dataIds: ["orders.yaml"], username: "", password: "" }), /invalid_nacos_group/);
  assert.throws(() => parseCapabilityConfiguration("nacos", { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", password: "" }), /invalid_nacos_credentials/);
  assert.throws(() => parseCapabilityConfiguration("sls", { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "orders-test", logstores: [] }), /invalid_sls_scope/);
  assert.throws(() => parseCapabilityConfiguration("sls", { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "INVALID", logstores: ["application"] }), /invalid_sls_scope/);
});
