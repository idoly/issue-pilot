import { describe, expect, it } from "vitest";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";
const draft: DeploymentCapabilityDraft = {
  capabilities: [...CAPABILITY_KEYS],
  dms: { url: "https://dms.example.test/sse", authorization: "", credentialConfigured: true, credentialEnabled: true, databases: [{ instanceAlias: " ORDERS-PROD ", schemaName: " orders ", instanceId: " instance-1 ", instanceHost: " db.example.test ", instancePort: " 3306 ", databaseId: " 123 " }] },
  sls: { accessKeyId: "", accessKeySecret: "", credentialConfigured: true, credentialEnabled: true, region: " cn-test ", project: " orders-test ", logstores: ["application"] },
};
describe("capability deployment serialization", () => {
  it("preserves stored DMS/SLS credentials without including secrets", () => {
    const serialized = serializeCapabilityDraft(draft);
    expect(Object.keys(serialized)).toEqual(["dms", "sls"]);
    expect(serialized.dms?.credentialUpdate).toEqual({ mode: "preserve" });
    expect(serialized.sls).toEqual({ region: "cn-test", project: "orders-test", logstores: ["application"], credentialUpdate: { mode: "preserve" } });
    expect(serialized.dms?.databases[0]?.instanceAlias).toBe("ORDERS-PROD");
    expect(JSON.stringify(serialized)).not.toMatch(/accessKeyId|accessKeySecret|authorization|password/);
  });
  it("serializes complete replacements and omits unselected capabilities", () => {
    const value = structuredClone(draft);
    value.sls!.accessKeyId = "new-key"; value.sls!.accessKeySecret = "new-secret";
    expect(serializeCapabilityDraft(value).sls?.credentialUpdate).toEqual({ mode: "replace", values: { accessKeyId: "new-key", accessKeySecret: "new-secret" } });
    expect(Object.keys(serializeCapabilityDraft({ ...draft, capabilities: ["dms"] }))).toEqual(["dms"]);
  });
});
