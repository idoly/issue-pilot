import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCapabilities, parseDatabaseConfiguration, parseDmsConfiguration, parseElasticsearchConfiguration, parseNacosConfiguration, parsePlaywrightConfiguration, parseRabbitMqConfiguration, parseRedisConfiguration, parseSlsConfiguration } from "../../src/http/service-configuration.ts";

test("rejects unknown or duplicate capability declarations", () => {
  assert.deepEqual(parseCapabilities(["db", "redis"]), ["db", "redis"]);
  assert.throws(() => parseCapabilities(["db", "unknown"]), /invalid_capabilities/);
  assert.throws(() => parseCapabilities(["db", "db"]), /invalid_capabilities/);
});

test("validates capability connection settings when saving page configuration", () => {
  const databaseUrl = "mysql://192.168.27.122:3306/srm_prod";
  assert.deepEqual(parseDatabaseConfiguration({ url: databaseUrl, username: "reader", password: "secret" }, true), {
    url: databaseUrl, username: "reader", password: "secret",
  });
  assert.throws(() => parseDatabaseConfiguration({ url: `${databaseUrl}?useSSL=false`, username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "mysql://db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "mysql://db.example.test:3306/orders/archive", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "mysql://db.example.test:3306/orders%2Farchive", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "jdbc:mysql://db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "mariadb://db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parseDatabaseConfiguration({ url: "mysql://hidden:secret@db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => parsePlaywrightConfiguration({ baseUrl: "ftp://app.example.test", username: "", password: "" }, true), /invalid_browser_base_url/);
  assert.throws(() => parsePlaywrightConfiguration({ baseUrl: "https://user@app.example.test", username: "", password: "" }, true), /invalid_browser_base_url/);
  assert.throws(() => parsePlaywrightConfiguration({ baseUrl: "https://app.example.test", username: "reader", password: "" }, true), /invalid_browser_credentials/);
  assert.throws(() => parseElasticsearchConfiguration({ url: "https://es.example.test", username: "reader", password: "" }, true), /invalid_es_credentials/);
  assert.throws(() => parseRedisConfiguration({ host: "redis.example.test", port: 70_000, username: "", database: 0 }, true), /invalid_redis_port/);
  assert.throws(() => parseRedisConfiguration({ host: "redis.example.test", port: 6379, username: "", database: -1 }, true), /invalid_redis_database/);
  assert.throws(() => parseRabbitMqConfiguration({ host: "mq.example.test", port: 5672, managementPort: 0, username: "reader", password: "secret", virtualHost: "/" }, true), /invalid_mq_management_port/);
  assert.deepEqual(parseDmsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "987654" }, true), { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "987654" });
  assert.deepEqual(parseDmsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: true, tid: "" }, true), { accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: true });
  for (const dbId of ["orders", "0", "2147483648"]) assert.throws(() => parseDmsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", dbId, logic: false }, true), /invalid_dms_scope/);
  assert.throws(() => parseDmsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: "false" }, true), /invalid_dms_scope/);
  assert.throws(() => parseDmsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", dbId: "123456", logic: false, tid: "9007199254740992" }, true), /invalid_dms_scope/);
});

test("requires explicit Nacos and SLS page scopes", () => {
  assert.throws(() => parseNacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: [], username: "", password: "" }, true), /invalid_nacos_data_ids/);
  assert.throws(() => parseNacosConfiguration({ serverUrl: "https://nacos.example.test/path", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", password: "" }, true), /invalid_nacos_server_url/);
  assert.throws(() => parseNacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "bad/group", dataIds: ["orders.yaml"], username: "", password: "" }, true), /invalid_nacos_group/);
  assert.throws(() => parseNacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", password: "" }, true), /invalid_nacos_credentials/);
  assert.throws(() => parseSlsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "orders-test", logstores: [] }, true), /invalid_sls_scope/);
  assert.throws(() => parseSlsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "INVALID", logstores: ["application"] }, true), /invalid_sls_scope/);
});
