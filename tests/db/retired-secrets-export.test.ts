import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { migrate } from "drizzle-orm/libsql/migrator";

import { exportRetiredSecrets } from "../../scripts/export-retired-secrets.ts";
import { openDatabase } from "../../src/db/client.ts";
import { migrateBefore } from "./migration-fixture.ts";

test("exports retired secrets from a checkpoint copy into a private no-overwrite file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-retired-export-"));
  const databaseFile = path.join(root, "issues.db");
  const database = openDatabase(databaseFile);
  try {
    await migrateBefore(database, path.join(root, "before-secret-retirement"), "0082_retire_private_secrets");
    await database.client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        "INSERT INTO user_credentials (subject, model_api_keys, updated_at) VALUES ('owner', '{\"provider-a\":\"user-secret\"}', 11)",
        'INSERT INTO application_settings (id, max_concurrent_issues, mysql_stdio) VALUES (1, 7, \'{"env":{"TOKEN":"settings-secret"}}\')',
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('prod', 'prod', 'Production', 'prod', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'orders', 'Orders', 1, 1)",
        `INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES
          ('deployment', 'service', 'prod', '{"nacos":{"password":"nacos-secret"},"redis":{"host":"redis.example.test"},"archivedDevelopment":{"note":"keep"}}', 1, 22)`,
      ],
      "write",
    );
    await database.client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }

  const outputDirectory = path.join(root, "private-evidence");
  await mkdir(outputDirectory, { mode: 0o700 });
  const output = path.join(outputDirectory, "retired-secrets.json");
  try {
    const result = await exportRetiredSecrets({ databasePath: databaseFile, outputPath: output, checkpointCopy: true, now: new Date("2026-11-17T00:00:00Z") });
    assert.deepEqual(result, { outputPath: output, users: 1, deployments: 1 });
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const exported = JSON.parse(await readFile(output, "utf8"));
    assert.equal(exported.format, "issue-pilot-retired-secrets-v1");
    assert.equal(exported.exportedAt, "2026-11-17T00:00:00.000Z");
    assert.deepEqual(exported.applicationSettings, { maxConcurrentIssues: 7, mysqlStdio: { env: { TOKEN: "settings-secret" } } });
    assert.deepEqual(exported.users, [{ subject: "owner", modelApiKeys: { "provider-a": "user-secret" }, updatedAt: "1970-01-01T00:00:11.000Z" }]);
    assert.deepEqual(exported.deployments, [
      {
        id: "deployment",
        serviceId: "service",
        environmentId: "prod",
        retiredConfig: { nacos: { password: "nacos-secret" }, redis: { host: "redis.example.test" } },
        updatedAt: "1970-01-01T00:00:22.000Z",
      },
    ]);

    // The returned summary is what the CLI prints; it must not contain retired values.
    assert.doesNotMatch(JSON.stringify(result), /user-secret|settings-secret|nacos-secret/);
    await assert.rejects(exportRetiredSecrets({ databasePath: databaseFile, outputPath: output, checkpointCopy: true }), /EEXIST/);

    await chmod(outputDirectory, 0o755);
    await assert.rejects(exportRetiredSecrets({ databasePath: databaseFile, outputPath: path.join(outputDirectory, "other.json"), checkpointCopy: true }), /private_0700/);
    await chmod(outputDirectory, 0o700);

    // Without --checkpoint-copy the script interlocks with the state lease instead.
    const leased = await exportRetiredSecrets({ databasePath: databaseFile, outputPath: path.join(outputDirectory, "leased.json"), checkpointCopy: false });
    assert.deepEqual(leased, { outputPath: path.join(outputDirectory, "leased.json"), users: 1, deployments: 1 });

    // After 0082 the columns are gone, so the exporter refuses to publish a misleading empty file.
    const migrated = openDatabase(databaseFile);
    try {
      await migrate(migrated.db, { migrationsFolder: path.resolve("drizzle") });
    } finally {
      migrated.close();
    }
    await assert.rejects(exportRetiredSecrets({ databasePath: databaseFile, outputPath: path.join(outputDirectory, "after.json"), checkpointCopy: true }), /already migrated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
