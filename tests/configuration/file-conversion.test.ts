import assert from "node:assert/strict";
import { test } from "node:test";
import { convertUserFile, moveDingtalkSource, fillMissingUserCredentials } from "../../scripts/configuration-conversion.ts";

test("legacy shared connections remain explicit while personal sources move to their named owner", () => {
  const layout = convertUserFile({ version: 1, user: { subject: "alice" }, apiKeys: { provider: "fixture-key" }, dingtalk: { apiKey: "fixture-gateway-key" } });
  layout.users.bob = {};
  const source = { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: "Alice", intervalMinutes: 15 }, service = { sources: { dingtalk: source } };
  moveDingtalkSource(service, layout.users, "alice");
  assert.deepEqual(service, {});
  assert.deepEqual(layout.users.bob, {});
  assert.deepEqual(layout.shared.dingtalk, { apiKey: "fixture-gateway-key" });
  assert.deepEqual(layout.users.alice!.dingtalk, { source });
  assert.throws(() => moveDingtalkSource({ sources: { other: {} } }, layout.users, "alice"), /source_migration_requires_review/);
  assert.throws(() => moveDingtalkSource({ sources: { dingtalk: { ...source, assignee: "Bob" } } }, layout.users, "alice"), /conflicting_dingtalk_sources/);
});

test("explicit credential seeding fills missing accounts and providers without replacing existing identities or copying source filters", () => {
  const users: Record<string, Record<string, unknown>> = {
    owner: { apiKeys: { first: "owner-first", second: "owner-second" }, ssh: { privateKey: "owner-ssh" }, dms: { url: "https://owner.example.test", authorization: "Bearer owner" }, sls: { accessKeyId: "owner-id", accessKeySecret: "owner-secret" }, dingtalk: { source: { assignee: "Owner" } } },
    other: { apiKeys: { first: "own-first" }, dms: { url: "https://other.example.test", authorization: "Bearer other" }, dingtalk: { source: { assignee: "Other" } } },
    empty: {},
  };
  const counts = fillMissingUserCredentials(users, "owner");
  assert.deepEqual(users.other!.apiKeys, { first: "own-first", second: "owner-second" });
  assert.deepEqual(users.other!.dms, { url: "https://other.example.test", authorization: "Bearer other" });
  assert.deepEqual(users.other!.dingtalk, { source: { assignee: "Other" } });
  assert.equal(users.empty!.dingtalk, undefined);
  assert.deepEqual(users.empty!.ssh, users.owner!.ssh);
  assert.deepEqual(counts, { apiKeys: 3, ssh: 2, dms: 1, sls: 2 });
  assert.deepEqual(fillMissingUserCredentials(users, "owner"), { apiKeys: 0, ssh: 0, dms: 0, sls: 0 });
  users.incomplete = { sls: { accessKeyId: "different" } };
  assert.throws(() => fillMissingUserCredentials(users, "owner"), /incomplete_user_credentials_require_review/);
});
