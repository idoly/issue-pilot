import { describe, expect, it } from "vitest";

import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";

const draft: DeploymentCapabilityDraft = {
  capabilities: [...CAPABILITY_KEYS],
  nacos: { serverUrl: " https://nacos.example.test ", namespace: " test ", group: " DEFAULT_GROUP ", dataIds: ["orders.yaml"], username: " reader ", password: "nacos-secret", credentialConfigured: false, credentialEnabled: true },
  db: { url: " mysql://db.example.test:3306/orders ", username: " reader ", password: "db-secret", credentialConfigured: false, credentialEnabled: true },
  redis: { host: " redis.example.test ", port: 6379, username: " reader ", password: "redis-secret", database: 1, credentialConfigured: false, credentialEnabled: true },
  mq: { host: " mq.example.test ", port: 5672, managementPort: 15672, username: " reader ", password: "mq-secret", virtualHost: " /orders ", credentialConfigured: false, credentialEnabled: true },
  es: { url: " https://es.example.test ", username: " reader ", password: "es-secret", credentialConfigured: false, credentialEnabled: true },
  dms: { url: " https://dms.example.test/sse ", authorization: " Bearer dms-token ", databases: [{ instanceAlias: " ORDERS-PROD ", schemaName: " orders ", instanceId: " instance-1 ", instanceHost: " db.example.test ", instancePort: " 3306 ", databaseId: " 123 " }], credentialConfigured: false, credentialEnabled: true },
  sls: { accessKeyId: " sls-key ", accessKeySecret: "sls-secret", region: " cn-test ", project: " orders-test ", logstores: ["application"], credentialConfigured: false, credentialEnabled: true },
};

const replace = (values: Record<string, string>) => ({ mode: "replace", values });

describe("capability deployment serialization", () => {
  it("serializes every shared capability key through explicit credential replacements", () => {
    expect(Object.keys(serializeCapabilityDraft(draft))).toEqual(CAPABILITY_KEYS);
    expect(serializeCapabilityDraft(draft)).toEqual({
      nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", credentialUpdate: replace({ password: "nacos-secret" }) },
      db: { url: "mysql://db.example.test:3306/orders", username: "reader", credentialUpdate: replace({ password: "db-secret" }) },
      redis: { host: "redis.example.test", port: 6379, username: "reader", database: 1, credentialUpdate: replace({ password: "redis-secret" }) },
      mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", virtualHost: "/orders", credentialUpdate: replace({ password: "mq-secret" }) },
      es: { url: "https://es.example.test", username: "reader", credentialUpdate: replace({ password: "es-secret" }) },
      dms: { url: "https://dms.example.test/sse", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }], credentialUpdate: replace({ authorization: " Bearer dms-token " }) },
      sls: { region: "cn-test", project: "orders-test", logstores: ["application"], credentialUpdate: replace({ accessKeyId: " sls-key ", accessKeySecret: "sls-secret" }) },
    });
  });

  it("preserves configured credentials without placing their values in the request", () => {
    const existing = structuredClone(draft);
    for (const key of CAPABILITY_KEYS) {
      const section = existing[key]! as Record<string, unknown>;
      section.credentialConfigured = true;
      for (const field of ["password", "accessKeyId", "accessKeySecret", "authorization"]) if (field in section) section[field] = "";
    }
    const serialized = serializeCapabilityDraft(existing);
    for (const key of CAPABILITY_KEYS) expect(serialized[key]?.credentialUpdate).toEqual({ mode: "preserve" });
    expect(JSON.stringify(serialized)).not.toMatch(/secret|accessKeyId|accessKeySecret|authorization|password/);
  });

  it("explicitly clears optional credentials and omits unselected capabilities", () => {
    expect(serializeCapabilityDraft({ ...draft, capabilities: ["nacos"], nacos: { ...draft.nacos!, username: "", credentialEnabled: false } })).toEqual({
      nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", credentialUpdate: { mode: "clear" } },
    });
    expect(serializeCapabilityDraft({ ...draft, capabilities: ["dms"] })).toEqual({
      dms: { url: "https://dms.example.test/sse", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }], credentialUpdate: replace({ authorization: " Bearer dms-token " }) },
    });
  });
});
