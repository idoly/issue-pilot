import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { deploymentCapabilities, environments, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";

test("creates a private SQLite database with JSON, dates, transactions, and foreign keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sqlite-"));
  const file = join(root, "issues.db");
  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: resolve("drizzle") });
    await db.transaction(async (transaction) => {
      await transaction.insert(subjects).values({ subject: "demo-owner", username: "owner", displayName: "Owner", email: "owner@example.com" });
      await transaction.insert(environments).values({ organizationId: "demo", scope: "global", key: "test", name: "Test", kind: "test", config: { connector: "test" } });
    });
    const [environment] = await db.select().from(environments);
    assert.deepEqual(environment?.config, { connector: "test" });
    assert.ok(environment?.createdAt instanceof Date);
    const [production] = await db.insert(environments).values({ organizationId: "demo", scope: "global", key: "production", name: "Production", kind: "production", config: {} }).returning();
    const [service] = await db.insert(services).values({ organizationId: "demo", scope: "global", key: "orders", name: "Orders", description: "" }).returning();
    await db.insert(serviceRepositories).values({ serviceId: service!.id, url: "git@example.test:orders.git" });
    const deployments = await db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: environment!.id, baseBranch: "develop", config: {} },
      { serviceId: service!.id, environmentId: production!.id, baseBranch: "release", config: {} },
    ]).returning();
    await db.insert(deploymentCapabilities).values({ deploymentId: deployments[0]!.id, capability: "database_read" });
    await assert.rejects(client.execute({
      sql: "insert into issues (id, key, title, reporter_subject, environment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      args: ["invalid-scope", "ISSUE-20260805-001", "Invalid scope", "demo-owner", environment!.id, Date.now(), Date.now()],
    }), /issue_scope_required/);
    await client.execute({
      sql: "insert into issues (id, key, title, reporter_subject, service_id, environment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["valid-scope", "ISSUE-20260805-002", "Valid scope", "demo-owner", service!.id, environment!.id, Date.now(), Date.now()],
    });
    await assert.rejects(client.execute({ sql: "update issues set service_id = null where id = ?", args: ["valid-scope"] }), /issue_scope_required/);
    assert.deepEqual(deployments.map((deployment) => deployment.baseBranch).sort(), ["develop", "release"]);
    await assert.rejects(db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, baseBranch: "other", config: {} }));
    await db.insert(serviceRepositories).values({ serviceId: service!.id, url: "git@example.test:second.git" });
    assert.equal((await db.select().from(serviceRepositories)).length, 2);
    assert.equal((await client.execute("pragma foreign_key_check")).rows.length, 0);
    const obsoleteTables = await client.execute("select name from sqlite_master where type = 'table' and name in ('service_modules', 'service_relations', 'service_relation_modules', 'issue_service_modules', 'issue_services', 'issue_diagnoses', 'issue_test_runs', 'issue_evidence')");
    assert.equal(obsoleteTables.rows.length, 0);
    const issueColumns = await client.execute("pragma table_info('issues')");
    assert.equal(issueColumns.rows.some((column) => column.name === "labels"), false);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
