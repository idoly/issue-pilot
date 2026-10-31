import { describe, expect, it } from "vitest";
import { CAPABILITY_KEYS } from "../../../domain/contracts";
import { serializeCapabilityDraft, type DeploymentCapabilityDraft } from "./configuration-model";
const draft: DeploymentCapabilityDraft = {
  capabilities: [...CAPABILITY_KEYS],
  dms: { databases: [{ instanceAlias: " ORDERS-PROD ", schemaName: " orders ", instanceId: " instance-1 ", instanceHost: " db.example.test ", instancePort: " 3306 ", databaseId: " 123 " }] },
  sls: { region: " cn-test ", project: " orders-test ", logstores: ["application"] },
};
describe("capability deployment serialization", () => {
  it("serializes DMS and SLS scope without credentials", () => {
    const serialized = serializeCapabilityDraft(draft);
    expect(Object.keys(serialized)).toEqual(["dms", "sls"]);
    expect(serialized.dms?.credentialUpdate).toBeUndefined();
    expect(serialized.sls).toEqual({ region: "cn-test", project: "orders-test", logstores: ["application"] });
    expect(serialized.dms?.databases[0]?.instanceAlias).toBe("ORDERS-PROD");
    expect(JSON.stringify(serialized)).not.toMatch(/accessKeyId|accessKeySecret|authorization|password/);
  });
  it("preserves named SLS targets when serializing a deployment", () => {
    const value = structuredClone(draft);
    value.sls!.targets = [
      { name: "primary", region: "cn-test", project: "orders-test", logstores: ["application"] },
      { name: "gateway", region: "cn-other", project: "gateway-prod", logstores: ["requests"] },
    ];
    expect(serializeCapabilityDraft(value).sls?.targets).toEqual(value.sls!.targets);
  });
  it("omits connection changes and unselected capabilities", () => {
    const value = structuredClone(draft);
    expect(serializeCapabilityDraft(value).dms?.credentialUpdate).toBeUndefined();
    expect(serializeCapabilityDraft(value).sls?.credentialUpdate).toBeUndefined();
    expect(Object.keys(serializeCapabilityDraft({ ...draft, capabilities: ["dms"] }))).toEqual(["dms"]);
  });
});
