import assert from "node:assert/strict";
import { test } from "node:test";
import { fillMissingUserCredentials, moveDingtalkSource, queryTargets, repositoryAddress, simpleServiceFile, userFileLayout } from "../../src/configuration/file-layout.ts";

test("compact YAML preserves target identities and requires explicit names for several SLS targets", () => {
  assert.equal(repositoryAddress("git@example.test:app.git", 2), "git@example.test:app.git");
  assert.throws(() => repositoryAddress({ url: "git@example.test:app.git" }, 2));
  const duplicateSchemas = [{ alias: "FIRST", schema: "orders" }, { alias: "SECOND", schema: "orders" }];
  assert.deepEqual(queryTargets("dms", duplicateSchemas, 2).map(target => target.value), duplicateSchemas);
  assert.equal(queryTargets("sls", { region: "cn-test", project: "logs" }, 2, "prod")[0]!.name, "prod");
  assert.throws(() => queryTargets("sls", [{ region: "one" }, { region: "two" }], 2), /query_target_name_required/);
  assert.throws(() => queryTargets("sls", [{ name: "same" }, { name: "same" }], 2), /duplicate_query_target_name/);
  const converted = simpleServiceFile({ version: 1, repositories: { app: { url: "git@example.test:app.git" } }, services: { orders: { environments: { prod: { dms: { orders: duplicateSchemas[0] }, sls: { prod: { region: "cn-test", project: "logs", logstores: ["app"] } } } } } } });
  assert.deepEqual(converted, { version: 2, repositories: { app: "git@example.test:app.git" }, services: { orders: { environments: { prod: { dms: duplicateSchemas[0], sls: { region: "cn-test", project: "logs", logstores: ["app"] } } } } } });
  assert.deepEqual(simpleServiceFile(converted), converted);
  assert.throws(() => simpleServiceFile({ repositories: { app: { url: "address", unexpected: "preserve" } } }), /repository_metadata_requires_review/);
});

test("legacy shared connections remain explicit while personal sources move to their named owner", () => {
  const layout = userFileLayout({ version: 1, user: { subject: "alice" }, apiKeys: { provider: "fixture-key" }, dingtalk: { apiKey: "fixture-gateway-key" } });
  layout.users.bob = {};
  const source = { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: "Alice", intervalMinutes: 15 }, service = { sources: { dingtalk: source } };
  moveDingtalkSource(service, layout.users, "alice");
  assert.deepEqual(service, {});
  assert.deepEqual(layout.users.bob, {});
  assert.deepEqual(layout.shared.dingtalk, { apiKey: "fixture-gateway-key" });
  assert.deepEqual(layout.users.alice!.dingtalk, { apiKey: "fixture-gateway-key", source });
  assert.throws(() => moveDingtalkSource({ sources: { other: {} } }, layout.users, "alice"), /source_migration_requires_review/);
  assert.throws(() => moveDingtalkSource({ sources: { dingtalk: { ...source, assignee: "Bob" } } }, layout.users, "alice"), /conflicting_dingtalk_sources/);
});

test("explicit credential seeding fills missing accounts and providers without replacing existing identities or copying source filters", () => {
  const users: Record<string, Record<string, unknown>> = {
    owner: { apiKeys: { first: "owner-first", second: "owner-second" }, ssh: { privateKey: "owner-ssh" }, dms: { url: "https://owner.example.test", authorization: "Bearer owner" }, sls: { accessKeyId: "owner-id", accessKeySecret: "owner-secret" }, dingtalk: { apiKey: "owner-gateway", source: { assignee: "Owner" } } },
    other: { apiKeys: { first: "own-first" }, dms: { url: "https://other.example.test", authorization: "Bearer other" }, dingtalk: { source: { assignee: "Other" } } },
    empty: {},
  };
  const counts = fillMissingUserCredentials(users, "owner");
  assert.deepEqual(users.other!.apiKeys, { first: "own-first", second: "owner-second" });
  assert.deepEqual(users.other!.dms, { url: "https://other.example.test", authorization: "Bearer other" });
  assert.deepEqual(users.other!.dingtalk, { apiKey: "owner-gateway", source: { assignee: "Other" } });
  assert.deepEqual(users.empty!.dingtalk, { apiKey: "owner-gateway" });
  assert.deepEqual(users.empty!.ssh, users.owner!.ssh);
  assert.deepEqual(counts, { apiKeys: 3, ssh: 2, dms: 1, sls: 2, dingtalk: 2 });
  assert.deepEqual(fillMissingUserCredentials(users, "owner"), { apiKeys: 0, ssh: 0, dms: 0, sls: 0, dingtalk: 0 });
  users.incomplete = { sls: { accessKeyId: "different" } };
  assert.throws(() => fillMissingUserCredentials(users, "owner"), /incomplete_user_credentials_require_review/);
});
