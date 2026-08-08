import assert from "node:assert/strict";
import test from "node:test";

import { browserConfiguration, dbConfiguration, esConfiguration, mqConfiguration, nacosConfiguration, parseCapabilities, redisConfiguration, slsConfiguration } from "../../src/capabilities/http-config.ts";

test("rejects unknown or duplicate capability declarations", () => {
  assert.deepEqual(parseCapabilities(["db", "redis"]), ["db", "redis"]);
  assert.throws(() => parseCapabilities(["db", "unknown"]), /invalid_capabilities/);
  assert.throws(() => parseCapabilities(["db", "db"]), /invalid_capabilities/);
});

test("validates capability connection settings when saving page configuration", () => {
  const databaseUrl = "mysql://192.168.27.122:3306/srm_prod";
  assert.deepEqual(dbConfiguration({ url: databaseUrl, username: "reader", password: "secret" }, true), {
    url: databaseUrl, username: "reader", password: "secret",
  });
  assert.throws(() => dbConfiguration({ url: `${databaseUrl}?useSSL=false`, username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => dbConfiguration({ url: "jdbc:mysql://db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => dbConfiguration({ url: "mariadb://db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => dbConfiguration({ url: "mysql://hidden:secret@db.example.test/orders", username: "reader", password: "secret" }, true), /invalid_db_url/);
  assert.throws(() => browserConfiguration({ baseUrl: "ftp://app.example.test", username: "", password: "" }, true), /invalid_browser_base_url/);
  assert.throws(() => browserConfiguration({ baseUrl: "https://user@app.example.test", username: "", password: "" }, true), /invalid_browser_base_url/);
  assert.throws(() => browserConfiguration({ baseUrl: "https://app.example.test", username: "reader", password: "" }, true), /invalid_browser_credentials/);
  assert.throws(() => esConfiguration({ url: "https://es.example.test", username: "reader", password: "" }, true), /invalid_es_credentials/);
  assert.throws(() => redisConfiguration({ host: "redis.example.test", port: 70_000, username: "", database: 0 }, true), /invalid_redis_port/);
  assert.throws(() => redisConfiguration({ host: "redis.example.test", port: 6379, username: "", database: -1 }, true), /invalid_redis_database/);
  assert.throws(() => mqConfiguration({ host: "mq.example.test", port: 5672, managementPort: 0, username: "reader", password: "secret", virtualHost: "/" }, true), /invalid_mq_management_port/);
});

test("requires explicit Nacos and SLS page scopes", () => {
  assert.throws(() => nacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: [], username: "", password: "" }, true), /invalid_nacos_data_ids/);
  assert.throws(() => nacosConfiguration({ serverUrl: "https://nacos.example.test/path", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", password: "" }, true), /invalid_nacos_server_url/);
  assert.throws(() => nacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "bad/group", dataIds: ["orders.yaml"], username: "", password: "" }, true), /invalid_nacos_group/);
  assert.throws(() => nacosConfiguration({ serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", password: "" }, true), /invalid_nacos_credentials/);
  assert.throws(() => slsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "orders-test", logstores: [] }, true), /invalid_sls_scope/);
  assert.throws(() => slsConfiguration({ accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "INVALID", logstores: ["application"] }, true), /invalid_sls_scope/);
});
