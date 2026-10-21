import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCapabilityConfiguration } from "../../src/capabilities/registry.ts";
import type { CapabilityName } from "../../src/domain/contracts.ts";

test("validates DMS and SLS targets and rejects retired native adapters", () => {
  const database = { instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" };
  const dms = { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [database] };
  assert.deepEqual(parseCapabilityConfiguration("dms", dms), dms);
  assert.throws(() => parseCapabilityConfiguration("dms", { ...dms, databases: [] }), /invalid_dms_databases/);
  assert.throws(() => parseCapabilityConfiguration("dms", { ...dms, databases: [database, { ...database, databaseId: "456" }] }), /duplicate_dms_database_schema/);
  assert.throws(() => parseCapabilityConfiguration("dms", { ...dms, databases: [database, { ...database, schemaName: "archive" }] }), /duplicate_dms_database_id/);
  for (const url of ["", "http://dms.example.test/sse", "https://user@dms.example.test/sse", "https://dms.example.test/sse?token=secret"]) assert.throws(() => parseCapabilityConfiguration("dms", { ...dms, url }), /invalid_dms_url/);
  for (const authorization of ["", "token", "Bearer token with spaces"]) assert.throws(() => parseCapabilityConfiguration("dms", { ...dms, authorization }), /invalid_dms_authorization/);
  const sls = { accessKeyId: "key", accessKeySecret: "secret", region: "cn-test", project: "orders-test", logstores: ["application"] };
  assert.deepEqual(parseCapabilityConfiguration("sls", sls), sls);
  assert.throws(() => parseCapabilityConfiguration("sls", { ...sls, logstores: [] }), /invalid_sls_scope/);
  assert.throws(() => parseCapabilityConfiguration("sls", { ...sls, project: "INVALID" }), /invalid_sls_scope/);
  for (const key of ["nacos", "redis", "mq", "es", "db"]) assert.throws(() => parseCapabilityConfiguration(key as CapabilityName, {}), /unsupported_capability/);
});
