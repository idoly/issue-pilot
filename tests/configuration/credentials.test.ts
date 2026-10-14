import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITY_CREDENTIALS } from "../../src/configuration/contracts.ts";
import { projectCapabilityConfiguration, resolveConfiguredCapabilitySections } from "../../src/configuration/credentials.ts";
import { CAPABILITY_KEYS, type CapabilityConfiguration, type CapabilityName } from "../../src/domain/contracts.ts";

const configuration: CapabilityConfiguration = {
  nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "operator", password: "nacos-secret" },
  db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", password: "db-secret" }] },
  redis: { host: "redis.example.test", port: 6379, username: "reader", password: "redis-secret", database: 0 },
  mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", password: "mq-secret", virtualHost: "/" },
  es: { url: "https://es.example.test", username: "reader", password: "es-secret" },
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer dms-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
};

function publicInput(key: CapabilityName, credentialUpdate: Record<string, unknown>): Record<string, unknown> {
  const projected = projectCapabilityConfiguration(configuration);
  if (key === "db") return {
    databases: projected.db!.databases.map(({ password: _password, credentialConfigured: _configured, ...database }) => ({ ...database, credentialUpdate })),
  };
  const section = projected[key] as Record<string, unknown>;
  const credentialFields = new Set<string>(CAPABILITY_CREDENTIALS[key].fields as readonly string[]);
  const visible = Object.fromEntries(Object.entries(section).filter(([field]) => field !== "credentialConfigured" && !credentialFields.has(field)));
  return { ...visible, credentialUpdate };
}

test("projects and preserves every capability credential through the shared contract", () => {
  const projected = projectCapabilityConfiguration(configuration);
  for (const key of CAPABILITY_KEYS) {
    if (key === "db") {
      assert.equal(projected.db!.databases[0]!.credentialConfigured, true);
      assert.equal(projected.db!.databases[0]!.password, configuration.db!.databases[0]!.password);
    } else {
      const section = projected[key] as Record<string, unknown>;
      assert.equal(section.credentialConfigured, true);
      for (const field of CAPABILITY_CREDENTIALS[key].fields) assert.equal(section[field], (configuration[key] as Record<string, unknown>)[field]);
    }
    const resolved = resolveConfiguredCapabilitySections({ [key]: publicInput(key, { mode: "preserve" }) }, [key], configuration);
    assert.deepEqual(resolved[key], configuration[key]);
  }
  assert.equal(JSON.stringify(projected).includes("secret"), true);
});

test("clears only optional credentials and rejects preservation without stored values", () => {
  for (const key of CAPABILITY_KEYS) {
    const section = publicInput(key, { mode: "clear" });
    if (key === "nacos" || key === "es") section.username = "";
    if (CAPABILITY_CREDENTIALS[key].required) {
      assert.throws(() => resolveConfiguredCapabilitySections({ [key]: section }, [key], configuration), /credential_required/);
    } else {
      const resolved = resolveConfiguredCapabilitySections({ [key]: section }, [key], configuration)[key] as Record<string, unknown>;
      for (const field of CAPABILITY_CREDENTIALS[key].fields) assert.equal(field in resolved, false);
    }
  }
  assert.throws(() => resolveConfiguredCapabilitySections({ db: publicInput("db", { mode: "preserve" }) }, ["db"]), /credential_not_configured/);
  assert.throws(() => resolveConfiguredCapabilitySections({ dms: { url: "https://dms.example.test/sse", databases: configuration.dms!.databases, credentialUpdate: { mode: "replace", values: {} } } }, ["dms"]), /invalid_dms_authorization/);
});
