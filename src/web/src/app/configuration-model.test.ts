import { describe, expect, it } from "vitest";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";

const draft: DeploymentCapabilityDraft = {
  capabilities: [...CAPABILITY_KEYS],
  nacos: { serverUrl: " https://nacos.example.test ", namespace: " test ", group: " DEFAULT_GROUP ", dataIds: ["orders.yaml"], username: " reader ", password: "nacos-secret", credentialConfigured: false, credentialEnabled: true },
  db: { databases: [{ url: " mysql://db.example.test:3306/orders ", username: " reader ", password: "db-secret", credentialConfigured: false, credentialEnabled: true }] },
  redis: { host: " redis.example.test ", port: 6379, username: " reader ", password: "redis-secret", database: 1, credentialConfigured: false, credentialEnabled: true },
  mq: { host: " mq.example.test ", managementPort: 15672, username: " reader ", password: "mq-secret", virtualHost: " /orders ", credentialConfigured: false, credentialEnabled: true },
  es: { url: " https://es.example.test ", username: " reader ", password: "es-secret", credentialConfigured: false, credentialEnabled: true },
  dms: { url: "https://dms.example.test/sse", authorization: "", credentialConfigured: true, credentialEnabled: true, databases: [{ instanceAlias: " ORDERS-PROD ", schemaName: " orders ", instanceId: " instance-1 ", instanceHost: " db.example.test ", instancePort: " 3306 ", databaseId: " 123 " }] },
  sls: { accessKeyId: "", accessKeySecret: "", credentialConfigured: true, credentialEnabled: true, region: " cn-test ", project: " orders-test ", logstores: ["application"] },
};
const dms = { url: "https://dms.example.test/sse", credentialUpdate: { mode: "preserve" }, databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] };
const replace = (values: Record<string, string>) => ({ mode: "replace", values });

describe("capability deployment serialization", () => {
  it("serializes native credential replacements and stored DMS/SLS credentials", () => {
    expect(Object.keys(serializeCapabilityDraft(draft))).toEqual(CAPABILITY_KEYS);
    expect(serializeCapabilityDraft(draft)).toEqual({
      nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", credentialUpdate: replace({ password: "nacos-secret" }) },
      db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", credentialUpdate: replace({ password: "db-secret" }) }] },
      redis: { host: "redis.example.test", port: 6379, username: "reader", database: 1, credentialUpdate: replace({ password: "redis-secret" }) },
      mq: { host: "mq.example.test", managementPort: 15672, username: "reader", virtualHost: "/orders", credentialUpdate: replace({ password: "mq-secret" }) },
      es: { url: "https://es.example.test", username: "reader", credentialUpdate: replace({ password: "es-secret" }) },
      dms,
      sls: { region: "cn-test", project: "orders-test", logstores: ["application"], credentialUpdate: { mode: "preserve" } },
    });
  });
  it("preserves configured credentials without putting their values in the request", () => {
    const existing = structuredClone(draft);
    for (const key of CAPABILITY_KEYS) {
      if (key === "dms" || key === "sls") continue;
      if (key === "db") { existing.db!.databases[0]!.credentialConfigured = true; existing.db!.databases[0]!.password = ""; continue; }
      const section = existing[key]! as Record<string, unknown>;
      section.credentialConfigured = true; section.password = "";
    }
    const serialized = serializeCapabilityDraft(existing);
    for (const key of CAPABILITY_KEYS.filter(key => key !== "db" && key !== "dms" && key !== "sls")) expect((serialized[key] as { credentialUpdate?: unknown })?.credentialUpdate).toEqual({ mode: "preserve" });
    expect(serialized.db?.databases[0]?.credentialUpdate).toEqual({ mode: "preserve" });
    expect(serialized.dms).toEqual(dms);
    expect(JSON.stringify(serialized)).not.toMatch(/secret|accessKeyId|accessKeySecret|authorization|password/);
  });
  it("clears optional credentials and omits unselected capabilities", () => {
    expect(serializeCapabilityDraft({ ...draft, capabilities: ["nacos"], nacos: { ...draft.nacos!, username: "", credentialEnabled: false } })).toEqual({ nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "", credentialUpdate: { mode: "clear" } } });
    expect(serializeCapabilityDraft({ ...draft, capabilities: ["dms"] })).toEqual({ dms });
  });
});
