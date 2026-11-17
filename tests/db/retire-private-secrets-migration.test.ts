import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDatabase } from "../../src/db/client.ts";
import { migrateBefore, migrateThrough } from "./migration-fixture.ts";

test("drops retired secret columns and deployment keys without disturbing other rows or triggers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-retire-secrets-"));
  const database = openDatabase(path.join(root, "issues.db"));
  const { client } = database;
  try {
    await migrateBefore(database, path.join(root, "before-secret-retirement"), "0082_retire_private_secrets");
    await client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        'INSERT INTO user_credentials (subject, model_api_keys, git_private_key, updated_at) VALUES (\'owner\', \'{"provider-a":"user-secret","provider-b":"other-secret"}\', \'git-key\', 11)',
        'INSERT INTO application_settings (id, max_concurrent_issues, mysql_stdio, dingtalk_fields) VALUES (1, 7, \'{"command":"npx","args":["mysql"],"env":{"TOKEN":"settings-secret"}}\', \'{"title":"subject"}\')',
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('prod', 'prod', 'Production', 'prod', 1, 1), ('test', 'test', 'Test', 'test', 1, 1), ('dev', 'dev', 'Development', 'dev', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'orders', 'Orders', 1, 1)",
        `INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES
          ('prod-deployment', 'service', 'prod', '{"dms":{"databases":[]},"nacos":{"serverUrl":"https://nacos.example.test","password":"nacos-secret"},"db":{"databases":[{"url":"mysql://db.example.test/orders","password":"db-secret"}]},"redis":{"host":"redis.example.test","password":"redis-secret"},"mq":{"host":"mq.example.test","password":"mq-secret"},"es":{"url":"https://es.example.test","password":"es-secret"},"mcpServices":["old-binding"],"archivedDevelopment":{"note":"keep"},"custom":{"keep":true}}', 1, 1),
          ('dev-deployment', 'service', 'dev', '{"archivedDevelopment":{"branch":"historical"}}', 1, 1),
          ('plain-deployment', 'service', 'test', '{}', 1, 1)`,
      ],
      "write",
    );
    const triggersBefore = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).rows.map((row) => row.name);

    await migrateThrough(database, path.join(root, "through-secret-retirement"), "0082_retire_private_secrets");

    assert.deepEqual((await client.execute("PRAGMA table_info('user_credentials')")).rows.map((row) => row.name).sort(), [
      "git_private_key",
      "model_credentials",
      "production_dms_authorization",
      "production_dms_url",
      "production_sls_access_key_id",
      "production_sls_access_key_secret",
      "revision",
      "subject",
      "updated_at",
    ]);
    assert.deepEqual((await client.execute("PRAGMA table_info('application_settings')")).rows.map((row) => row.name).sort(), [
      "dingtalk_fields",
      "id",
      "issue_search",
      "parameters",
      "parameters_revision",
      "shared_dms_credentials",
      "shared_dms_revision",
      "shared_sls_credentials",
      "shared_sls_revision",
    ]);
    assert.deepEqual((await client.execute("SELECT id, dingtalk_fields FROM application_settings")).rows, [{ id: 1, dingtalk_fields: '{"title":"subject"}' }]);
    assert.deepEqual((await client.execute("SELECT subject, git_private_key FROM user_credentials")).rows, [{ subject: "owner", git_private_key: "git-key" }]);
    const configs = Object.fromEntries((await client.execute("SELECT id, config FROM service_deployments ORDER BY id")).rows.map((row) => [String(row.id), JSON.parse(String(row.config))]));
    assert.deepEqual(configs["prod-deployment"], {
      dms: { databases: [] },
      archivedDevelopment: { note: "keep" },
      custom: { keep: true },
    });
    assert.deepEqual(configs["dev-deployment"], { archivedDevelopment: { branch: "historical" } });
    assert.deepEqual(configs["plain-deployment"], {});
    assert.deepEqual(
      (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).rows.map((row) => row.name),
      triggersBefore,
    );
    assert.equal((await client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
