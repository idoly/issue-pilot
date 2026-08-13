import { describe, expect, it } from "vitest";

import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";

const draft: DeploymentCapabilityDraft = {
  capabilities: [...CAPABILITY_KEYS],
  agent: { provider: "provider", model: "model", thinkingLevel: "medium" },
  playwright: { baseUrl: " https://app.example.test ", username: " operator ", password: "browser-secret" },
  nacos: { serverUrl: " https://nacos.example.test ", namespace: " test ", group: " DEFAULT_GROUP ", dataIds: ["orders.yaml"], username: " reader ", password: "nacos-secret" },
  db: { url: " mysql://db.example.test:3306/orders ", username: " reader ", password: "db-secret" },
  redis: { host: " redis.example.test ", port: 6379, username: " reader ", password: "redis-secret", database: 1 },
  mq: { host: " mq.example.test ", port: 5672, managementPort: 15672, username: " reader ", password: "mq-secret", virtualHost: " /orders " },
  es: { url: " https://es.example.test ", username: " reader ", password: "es-secret" },
  dms: { accessKeyId: " dms-key ", accessKeySecret: "dms-secret", dbId: " 123456 ", logic: true, tid: " 987654 " },
  sls: { accessKeyId: " sls-key ", accessKeySecret: "sls-secret", region: " cn-test ", project: " orders-test ", logstores: ["application"] },
};

describe("capability deployment serialization", () => {
  it("serializes every shared capability key without dropping scope fields", () => {
    expect(Object.keys(serializeCapabilityDraft(draft))).toEqual(CAPABILITY_KEYS);
    expect(serializeCapabilityDraft(draft)).toEqual({
      playwright: { baseUrl: "https://app.example.test", username: "operator", password: "browser-secret" },
      nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders.yaml"], username: "reader", password: "nacos-secret" },
      db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "db-secret" },
      redis: { host: "redis.example.test", port: 6379, username: "reader", password: "redis-secret", database: 1 },
      mq: { host: "mq.example.test", port: 5672, managementPort: 15672, username: "reader", password: "mq-secret", virtualHost: "/orders" },
      es: { url: "https://es.example.test", username: "reader", password: "es-secret" },
      dms: { accessKeyId: "dms-key", accessKeySecret: "dms-secret", dbId: "123456", logic: true, tid: "987654" },
      sls: { accessKeyId: "sls-key", accessKeySecret: "sls-secret", region: "cn-test", project: "orders-test", logstores: ["application"] },
    });
  });

  it("omits configuration for capabilities that are not selected", () => {
    expect(serializeCapabilityDraft({ ...draft, capabilities: ["dms"] })).toEqual({ dms: { accessKeyId: "dms-key", accessKeySecret: "dms-secret", dbId: "123456", logic: true, tid: "987654" } });
  });
});
