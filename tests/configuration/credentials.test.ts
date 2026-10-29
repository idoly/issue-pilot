import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCapabilityConfiguration, resolveConfiguredCapabilitySections, resolveDeploymentConfiguration } from "../../src/configuration/credentials.ts";
import { type CapabilityConfiguration, type StoredDeploymentConfig } from "../../src/domain/contracts.ts";
const configuration: CapabilityConfiguration = {
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer dms-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
};
function dmsInput(credentialUpdate: Record<string, unknown>) {
  const { credentialConfigured: _configured, ...section } = projectCapabilityConfiguration(configuration).dms!;
  return { ...section, credentialUpdate };
}
test("projects no secrets, preserves DMS credentials and stores only SLS scope", () => {
  const projected = projectCapabilityConfiguration(configuration);
  assert.equal(projected.dms!.credentialConfigured, true);
  assert.equal(projected.sls!.credentialConfigured, undefined);
  assert.doesNotMatch(JSON.stringify(projected), /sls-secret|dms-token|sls-key|accessKeyId|accessKeySecret/);
  assert.deepEqual(resolveConfiguredCapabilitySections({ dms: dmsInput({ mode: "preserve" }) }, ["dms"], configuration).dms, configuration.dms);
  assert.deepEqual(resolveConfiguredCapabilitySections({ sls: projected.sls }, ["sls"], configuration).sls, projected.sls);
  assert.deepEqual(resolveConfiguredCapabilitySections({ sls: { ...projected.sls, credentialUpdate: { mode: "preserve" } } }, ["sls"], configuration).sls, projected.sls);
});
test("DMS requires complete credentials and rejects preserving a changed connection", () => {
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: dmsInput({ mode: "clear" }) }, ["dms"], configuration), /credential_required/);
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: dmsInput({ mode: "preserve" }) }, ["dms"]), /credential_not_configured|dms_credentials_target_changed/);
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: { ...dmsInput({ mode: "preserve" }), url: "https://other.example.test/sse" } }, ["dms"], configuration), /dms_credentials_target_changed/);
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: dmsInput({ mode: "replace", values: {} }) }, ["dms"]), /invalid_dms_authorization/);
});
test("SLS deployment input rejects credential replacement, clearing and direct credential fields", () => {
  const scope = projectCapabilityConfiguration(configuration).sls!;
  for (const mode of ["replace", "clear"]) assert.throws(() => resolveConfiguredCapabilitySections({ sls: { ...scope, credentialUpdate: { mode, values: { accessKeyId: "key", accessKeySecret: "secret" } } } }, ["sls"]), /service_sls_credentials_not_allowed/);
  assert.throws(() => resolveConfiguredCapabilitySections({ sls: { ...scope, accessKeyId: "key" } }, ["sls"]), /credential_fields_not_allowed/);
});
test("retired private deployment configuration is not projected or executed", () => {
  const stored: StoredDeploymentConfig = { ...configuration, db: { databases: [{ url: "mysql://legacy.example.test:3306/orders", username: "legacy", password: "retired-secret" }] }, redis: { host: "legacy", port: 6379, username: "", database: 0 } };
  assert.deepEqual(resolveDeploymentConfiguration(stored), configuration);
  assert.doesNotMatch(JSON.stringify(projectCapabilityConfiguration(stored)), /legacy|retired-secret/);
});
