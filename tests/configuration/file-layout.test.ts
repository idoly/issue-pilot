import assert from "node:assert/strict";
import { test } from "node:test";
import { dingtalkFieldConfiguration, queryTargets, repositoryAddress, userFileLayout } from "../../src/configuration/file-layout.ts";

test("DingTalk field mappings accept only supported text mappings", () => {
  assert.deepEqual(dingtalkFieldConfiguration({ title: " 序号 ", description: "工单描述", attachments: "附件" }), { title: "序号", description: "工单描述", attachments: "附件" });
  assert.throws(() => dingtalkFieldConfiguration({ status: "状态" }), /invalid_file_configuration/);
  assert.throws(() => dingtalkFieldConfiguration({ title: 123 }), /invalid_file_configuration/);
});

test("compact YAML preserves target identities and requires explicit names for several SLS targets", () => {
  assert.equal(repositoryAddress("git@example.test:app.git"), "git@example.test:app.git");
  assert.throws(() => repositoryAddress({ url: "git@example.test:app.git" }));
  const duplicateSchemas = [{ alias: "FIRST", schema: "orders" }, { alias: "SECOND", schema: "orders" }];
  assert.deepEqual(queryTargets("dms", duplicateSchemas).map(target => target.value), duplicateSchemas);
  assert.equal(queryTargets("sls", { region: "cn-test", project: "logs" }, "prod")[0]!.name, "prod");
  assert.throws(() => queryTargets("sls", [{ region: "one" }, { region: "two" }]), /query_target_name_required/);
  assert.throws(() => queryTargets("sls", [{ name: "same" }, { name: "same" }]), /duplicate_query_target_name/);

});

test("runtime user layout accepts only explicit v2 accounts", () => {
  assert.deepEqual(userFileLayout({ version: 2, users: { alice: {}, bob: {} } }), { shared: {}, users: { alice: {}, bob: {} } });
  assert.deepEqual(userFileLayout(undefined), { shared: {}, users: {} });
  for (const version of [undefined, 1, 3, "2"]) assert.throws(() => userFileLayout({ version, user: { subject: "alice" } }), /invalid_file_configuration/);
});
