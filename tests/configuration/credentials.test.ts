import assert from "node:assert/strict";
import { test } from "node:test";
import { projectCapabilityConfiguration, resolveConfiguredCapabilitySections } from "../../src/configuration/credentials.ts";
import { type CapabilityConfiguration, type StoredDeploymentConfig } from "../../src/domain/contracts.ts";
const configuration: CapabilityConfiguration = {
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer dms-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
};
test("projects and resolves only DMS and SLS scopes, without deployment credentials", () => {
  const projected = projectCapabilityConfiguration(configuration);
  assert.deepEqual(projected.dms, { databases: configuration.dms!.databases });
  assert.doesNotMatch(JSON.stringify(projected), /sls-secret|dms-token|dms.example|sls-key|accessKeyId|accessKeySecret|credentialConfigured/);
  assert.deepEqual(resolveConfiguredCapabilitySections(projected, ["dms", "sls"]), projected);
  for (const key of ["dms", "sls"] as const) assert.deepEqual(resolveConfiguredCapabilitySections({ [key]: { ...projected[key], credentialUpdate: { mode: "preserve" } } }, [key])[key], projected[key]);
});
test("deployment inputs reject connection credentials and credential mutations", () => {
  const projected = projectCapabilityConfiguration(configuration);
  for (const key of ["dms", "sls"] as const) {
    for (const mode of ["replace", "clear"]) assert.throws(() => resolveConfiguredCapabilitySections({ [key]: { ...projected[key], credentialUpdate: { mode, values: {} } } }, [key]), new RegExp(`service_${key}_credentials_not_allowed`));
    const credentials = key === "dms" ? { url: "https://dms.example.test/sse" } : { accessKeyId: "key" };
    assert.throws(() => resolveConfiguredCapabilitySections({ [key]: { ...projected[key], ...credentials } }, [key]), /credential_fields_not_allowed/);
  }
});
test("retired private deployment configuration and historical credentials are not projected or executed", () => {
  const stored: StoredDeploymentConfig = { ...configuration, db: { databases: [{ url: "mysql://legacy.example.test:3306/orders", username: "legacy", password: "retired-secret" }] }, redis: { host: "legacy", port: 6379, username: "", database: 0 } };
  assert.deepEqual(projectCapabilityConfiguration(stored), projectCapabilityConfiguration(configuration));
  assert.doesNotMatch(JSON.stringify(projectCapabilityConfiguration(stored)), /legacy|retired-secret/);
});
