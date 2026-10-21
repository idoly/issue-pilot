import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPABILITY_CREDENTIALS } from "../../src/configuration/contracts.ts";
import { projectCapabilityConfiguration, resolveConfiguredCapabilitySections, resolveDeploymentConfiguration } from "../../src/configuration/credentials.ts";
import { CAPABILITY_KEYS, type CapabilityConfiguration, type CapabilityName, type StoredDeploymentConfig } from "../../src/domain/contracts.ts";
const configuration: CapabilityConfiguration = {
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer dms-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
};
function publicInput(key: CapabilityName, credentialUpdate: Record<string, unknown>) {
  const section = projectCapabilityConfiguration(configuration)[key] as Record<string, unknown>;
  return { ...Object.fromEntries(Object.entries(section).filter(([field]) => field !== "credentialConfigured")), credentialUpdate };
}
test("projects and preserves active native credentials without exposing their values", () => {
  const projected = projectCapabilityConfiguration(configuration);
  for (const key of CAPABILITY_KEYS) {
    const section = projected[key] as Record<string, unknown>;
    assert.equal(section.credentialConfigured, true);
    for (const field of CAPABILITY_CREDENTIALS[key].fields) assert.equal(field in section, false);
    assert.deepEqual(resolveConfiguredCapabilitySections({ [key]: publicInput(key, { mode: "preserve" }) }, [key], configuration)[key], configuration[key]);
  }
  assert.doesNotMatch(JSON.stringify(projected), /sls-secret|dms-token|sls-key/);
});
test("requires complete replacement credentials and never preserves credentials for a new DMS target", () => {
  for (const key of CAPABILITY_KEYS) {
    assert.throws(() => resolveConfiguredCapabilitySections({ [key]: publicInput(key, { mode: "clear" }) }, [key], configuration), /credential_required/);
    assert.throws(() => resolveConfiguredCapabilitySections({ [key]: publicInput(key, { mode: "preserve" }) }, [key]), /credential_not_configured|dms_credentials_target_changed/);
  }
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: { ...publicInput("dms", { mode: "preserve" }), url: "https://other.example.test/sse" } }, ["dms"], configuration), /dms_credentials_target_changed/);
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: publicInput("dms", { mode: "replace", values: {} }) }, ["dms"]), /invalid_dms_authorization/);
  assert.throws(() => resolveConfiguredCapabilitySections({ sls: publicInput("sls", { mode: "replace", values: { accessKeyId: "key" } }) }, ["sls"]), /invalid_credential_replacement/);
});
test("retired private deployment configuration is not projected or executed", () => {
  const stored: StoredDeploymentConfig = { ...configuration, db: { databases: [{ url: "mysql://legacy.example.test:3306/orders", username: "legacy", password: "retired-secret" }] }, redis: { host: "legacy", port: 6379, username: "", database: 0 } };
  assert.deepEqual(resolveDeploymentConfiguration(stored), configuration);
  assert.doesNotMatch(JSON.stringify(projectCapabilityConfiguration(stored)), /legacy|retired-secret/);
});
