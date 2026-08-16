import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITY_CREDENTIALS } from "../../src/configuration/contracts.ts";
import { redactCapabilityConfiguration, resolveConfiguredCapabilitySections } from "../../src/configuration/credentials.ts";
import { CAPABILITY_KEYS, type CapabilityConfiguration, type CapabilityName } from "../../src/domain/contracts.ts";

const configuration: CapabilityConfiguration = {
  nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "operator", password: "nacos-secret" },
  db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "db-secret" },
  redis: { host: "redis.example.test", port: 6379, username: "reader", password: "redis-secret", database: 0 },
  mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", password: "mq-secret", virtualHost: "/" },
  es: { url: "https://es.example.test", username: "reader", password: "es-secret" },
  dms: { accessKeyId: "dms-key", accessKeySecret: "dms-secret", dbId: "123456", logic: false },
  sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
};

function publicInput(key: CapabilityName, credentialUpdate: Record<string, unknown>): Record<string, unknown> {
  const section = redactCapabilityConfiguration(configuration)[key] as Record<string, unknown>;
  const { credentialConfigured: _credentialConfigured, ...visible } = section;
  return { ...visible, credentialUpdate };
}

test("redacts and preserves every capability credential through the shared contract", () => {
  const redacted = redactCapabilityConfiguration(configuration);
  for (const key of CAPABILITY_KEYS) {
    const section = redacted[key] as Record<string, unknown>;
    assert.equal(section.credentialConfigured, true);
    for (const field of CAPABILITY_CREDENTIALS[key].fields) assert.equal(field in section, false);
    const resolved = resolveConfiguredCapabilitySections({ [key]: publicInput(key, { mode: "preserve" }) }, [key], configuration);
    assert.deepEqual(resolved[key], configuration[key]);
  }
  assert.equal(JSON.stringify(redacted).includes("secret"), false);
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
});
