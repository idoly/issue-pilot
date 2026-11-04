import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDmsConnectionConfiguration, parseDmsScopeConfiguration, parseSlsConnectionConfiguration, parseSlsScopeConfiguration } from "../../src/capabilities/registry.ts";

test("validates DMS connection credentials independently from query targets", () => {
  const database = { instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" };
  const unresolved = { instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "", instanceHost: "", instancePort: "", databaseId: "" };
  const connection = { url: "https://dms.example.test/sse", authorization: "Bearer token" };
  assert.deepEqual(parseDmsConnectionConfiguration(connection), connection);
  // Resolution belongs to the server: browser-supplied resolved metadata is ignored, not stored.
  assert.deepEqual(parseDmsScopeConfiguration({ databases: [database] }), { databases: [unresolved] });
  assert.throws(() => parseDmsScopeConfiguration({ databases: [] }), /invalid_dms_databases/);
  assert.throws(() => parseDmsScopeConfiguration({ databases: [database, { ...database }] }), /duplicate_dms_database_schema/);
  for (const url of ["", "http://dms.example.test/sse", "https://user@dms.example.test/sse", "https://dms.example.test/sse?token=secret"])
    assert.throws(() => parseDmsConnectionConfiguration({ ...connection, url }), /invalid_dms_url/);
  for (const authorization of ["", "token", "Bearer token with spaces"]) assert.throws(() => parseDmsConnectionConfiguration({ ...connection, authorization }), /invalid_dms_authorization/);
});

test("validates SLS credentials and uses the same target rules for single and named scopes", () => {
  const credentials = { accessKeyId: "key", accessKeySecret: "secret" };
  const scope = { region: "cn-test", project: "orders-test", logstores: ["application"] };
  assert.deepEqual(parseSlsConnectionConfiguration(credentials), credentials);
  assert.deepEqual(parseSlsScopeConfiguration(scope), scope);
  for (const invalid of [
    { ...scope, logstores: [] },
    { ...scope, project: "INVALID" },
    { ...scope, region: "INVALID" },
    { ...scope, logstores: ["bad/store"] },
  ]) {
    assert.throws(() => parseSlsScopeConfiguration(invalid), /invalid_sls_scope/);
    assert.throws(() => parseSlsScopeConfiguration({ ...scope, targets: [{ name: "invalid", ...invalid }] }), /invalid_sls_scope/);
  }
});
