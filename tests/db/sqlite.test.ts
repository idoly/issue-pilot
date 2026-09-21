import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { environments, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { configuredCapabilities } from "../../src/domain/contracts.ts";

test("preserves issue, CC, and session data when removing unused metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-migration-"));
  const file = join(root, "issues.db");
  const migrations = join(root, "migrations");
  const migrationSource = resolve("drizzle");
  const journal = JSON.parse(await readFile(join(migrationSource, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  assert.deepEqual(journal.entries.slice(-11).map(({ tag }) => tag), ["0031_remove_unused_issue_metadata", "0032_remove_redundant_pi_session_id", "0033_repository_deployment_branches", "0034_issue_repository_workspace_names", "0035_issue_deployment_scope", "0036_issue_status_resolution", "0037_managed_users", "0038_global_agent_configuration", "0039_dms_database_targets", "0040_dms_schema_selector", "0041_related_issues"]);
  const previousJournal = { ...journal, entries: journal.entries.slice(0, -11) };
  await mkdir(join(migrations, "meta"), { recursive: true });
  await Promise.all([
    writeFile(join(migrations, "meta", "_journal.json"), JSON.stringify(previousJournal)),
    ...previousJournal.entries.map(({ tag }) => copyFile(join(migrationSource, `${tag}.sql`), join(migrations, `${tag}.sql`))),
  ]);

  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: migrations });
    await client.execute("pragma foreign_keys = on");
    const now = Date.now();
    for (const statement of [
      "insert into subjects (subject, display_name, created_at, updated_at) values ('reporter', 'Reporter', 1, 1), ('recipient', 'Recipient', 1, 1)",
      "insert into environments (id, key, name, kind, created_at, updated_at) values ('environment', 'test', 'Test', 'test', 1, 1)",
      "insert into services (id, key, name, description, created_at, updated_at) values ('service', 'orders', 'Orders', '', 1, 1)",
      "insert into service_repositories (id, service_id, url, created_at, updated_at) values ('orders-api', 'service', 'git@example.test:team/orders-api.git', 1, 1), ('orders-web', 'service', 'https://example.test/team/orders-web.git', 1, 1)",
      "insert into service_deployments (id, service_id, environment_id, base_branch, config, created_at, updated_at) values ('test-deployment', 'service', 'environment', 'develop', '{\"agent\":{\"provider\":\"enterprise-ai\",\"model\":\"engineering-model\",\"thinkingLevel\":\"high\"}}', 1, 1)",
      `insert into issues (id, key, title, service_id, environment_id, reporter_subject, version, created_at, updated_at) values ('issue', 'ISSUE-20260809-001', 'Preserved', 'service', 'environment', 'reporter', 7, ${now}, ${now})`,
      "insert into issue_repositories (id, issue_id, url, base_branch, working_branch, local_path, commit_before, created_at, updated_at) values ('issue-repository', 'issue', 'git@example.test:team/orders-api.git', 'develop', 'hotfix-issue-20260809-001', '/state/workspaces/issue-20260809-001/orders-api', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1)",
      "insert into issue_cc_recipients (issue_id, subject, created_at) values ('issue', 'recipient', 2)",
      "insert into issue_history (id, issue_id, actor_subject, action, changes, created_at) values ('history', 'issue', 'reporter', 'created', '{}', 3)",
      "insert into issue_pilot_sessions (issue_id, pi_session_id, session_file, workspace_path, created_at, updated_at) values ('issue', 'pi-session', '/sessions/issue.jsonl', '/workspaces/issue', 4, 4)",
    ]) await client.execute(statement);

    await migrate(db, { migrationsFolder: migrationSource });

    assert.deepEqual((await client.execute("select key, title from issues")).rows, [{ key: "ISSUE-20260809-001", title: "Preserved" }]);
    assert.deepEqual((await client.execute("select issue_id, subject from issue_cc_recipients")).rows, [{ issue_id: "issue", subject: "recipient" }]);
    assert.deepEqual((await client.execute("select issue_id, session_file, workspace_path from issue_pilot_sessions")).rows, [{ issue_id: "issue", session_file: "/sessions/issue.jsonl", workspace_path: "/workspaces/issue" }]);
    assert.deepEqual((await client.execute("select id, workspace_name from issue_repositories")).rows, [{ id: "issue-repository", workspace_name: "orders-api" }]);
    await assert.rejects(client.execute("insert into issue_repositories (id, issue_id, url, base_branch, working_branch, local_path, workspace_name, commit_before, created_at, updated_at) values ('duplicate-workspace', 'issue', 'git@example.test:team/other.git', 'develop', 'hotfix-other', '/state/workspaces/issue-20260809-001/orders-api', 'orders-api', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 1)"));
    assert.equal((await client.execute("select name from sqlite_master where type = 'table' and name = 'issue_history'")).rows.length, 0);
    assert.equal((await client.execute("pragma table_info('issues')")).rows.some((column) => column.name === "version"), false);
    assert.equal((await client.execute("pragma table_info('issue_cc_recipients')")).rows.some((column) => column.name === "created_at"), false);
    assert.equal((await client.execute("pragma table_info('issue_pilot_sessions')")).rows.some((column) => column.name === "pi_session_id"), false);
    assert.equal((await client.execute("pragma table_info('service_deployments')")).rows.some((column) => column.name === "base_branch"), false);
    assert.deepEqual((await client.execute("select provider, model, thinking_level from global_agent_configuration")).rows, [{ provider: "enterprise-ai", model: "engineering-model", thinking_level: "high" }]);
    assert.deepEqual((await client.execute("select config from service_deployments")).rows, [{ config: "{}" }]);
    assert.deepEqual((await client.execute("select name from sqlite_master where type = 'trigger' and name like '%deployment%' order by name")).rows.map((row) => row.name), [
      "issues_deployment_required_insert", "issues_deployment_required_update", "service_deployments_issues_restrict_delete", "service_deployments_issues_restrict_update",
    ]);
    assert.deepEqual((await client.execute("select name from sqlite_master where type = 'trigger' and name like '%resolution_state%' order by name")).rows.map((row) => row.name), [
      "issues_resolution_state_insert", "issues_resolution_state_update",
    ]);
    assert.deepEqual((await client.execute("select id, alias from service_repositories order by id")).rows, [
      { id: "orders-api", alias: "orders-api" },
      { id: "orders-web", alias: "orders-web" },
    ]);
    assert.deepEqual((await client.execute("select deployment_id, repository_id, base_branch from service_deployment_repositories order by repository_id")).rows, [
      { deployment_id: "test-deployment", repository_id: "orders-api", base_branch: "develop" },
      { deployment_id: "test-deployment", repository_id: "orders-web", base_branch: "develop" },
    ]);
    await assert.rejects(client.execute("insert into issue_cc_recipients (issue_id, subject) values ('issue', 'recipient')"));
    await assert.rejects(client.execute("insert into issue_cc_recipients (issue_id, subject) values ('missing', 'recipient')"));
    assert.equal((await client.execute("pragma foreign_key_check")).rows.length, 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates each configured DMS database into the explicit target collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-dms-target-migration-"));
  const file = join(root, "issues.db");
  const migrations = join(root, "migrations");
  const migrationSource = resolve("drizzle");
  const journal = JSON.parse(await readFile(join(migrationSource, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  const dmsMigrationIndex = journal.entries.findIndex(({ tag }) => tag === "0039_dms_database_targets");
  const previousJournal = { ...journal, entries: journal.entries.slice(0, dmsMigrationIndex) };
  await mkdir(join(migrations, "meta"), { recursive: true });
  await Promise.all([
    writeFile(join(migrations, "meta", "_journal.json"), JSON.stringify(previousJournal)),
    ...previousJournal.entries.map(({ tag }) => copyFile(join(migrationSource, `${tag}.sql`), join(migrations, `${tag}.sql`))),
  ]);
  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: migrations });
    await client.execute("insert into environments (id, key, name, kind, created_at, updated_at) values ('environment', 'test', 'Test', 'test', 1, 1)");
    await client.execute("insert into services (id, key, name, description, created_at, updated_at) values ('service', 'orders', 'Orders', '', 1, 1)");
    const previousDms = { url: "https://dms.example.test/sse", authorization: "Bearer token", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", instanceLabel: "ORDERS-PROD · db.example.test:3306 · mysql/product", databaseId: "123", databaseLabel: "orders" };
    await client.execute({ sql: "insert into service_deployments (id, service_id, environment_id, config, created_at, updated_at) values ('deployment', 'service', 'environment', ?, 1, 1)", args: [JSON.stringify({ dms: previousDms })] });
    await migrate(db, { migrationsFolder: migrationSource });
    const [row] = (await client.execute("select config from service_deployments where id = 'deployment'")).rows;
    assert.deepEqual(JSON.parse(String(row!.config)), { dms: { url: previousDms.url, authorization: previousDms.authorization, databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] } });
    assert.equal((await client.execute("select count(*) count from sqlite_master where name = '_dms_database_targets_guard'")).rows[0]!.count, 0);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to guess an incomplete DMS database scope during migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-invalid-dms-target-migration-"));
  const file = join(root, "issues.db");
  const migrations = join(root, "migrations");
  const migrationSource = resolve("drizzle");
  const journal = JSON.parse(await readFile(join(migrationSource, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  const dmsMigrationIndex = journal.entries.findIndex(({ tag }) => tag === "0039_dms_database_targets");
  const previousJournal = { ...journal, entries: journal.entries.slice(0, dmsMigrationIndex) };
  await mkdir(join(migrations, "meta"), { recursive: true });
  await Promise.all([writeFile(join(migrations, "meta", "_journal.json"), JSON.stringify(previousJournal)), ...previousJournal.entries.map(({ tag }) => copyFile(join(migrationSource, `${tag}.sql`), join(migrations, `${tag}.sql`)))]);
  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: migrations });
    await client.execute("insert into environments (id, key, name, kind, created_at, updated_at) values ('environment', 'test', 'Test', 'test', 1, 1)");
    await client.execute("insert into services (id, key, name, description, created_at, updated_at) values ('service', 'orders', 'Orders', '', 1, 1)");
    await client.execute({ sql: "insert into service_deployments (id, service_id, environment_id, config, created_at, updated_at) values ('deployment', 'service', 'environment', ?, 1, 1)", args: [JSON.stringify({ dms: { url: "https://dms.example.test/sse", authorization: "Bearer token" } })] });
    await assert.rejects(migrate(db, { migrationsFolder: migrationSource }), /CHECK constraint failed/);
    assert.equal((await client.execute("select count(*) count from __drizzle_migrations")).rows[0]!.count, previousJournal.entries.length);
    assert.deepEqual(JSON.parse(String((await client.execute("select config from service_deployments")).rows[0]!.config)), { dms: { url: "https://dms.example.test/sse", authorization: "Bearer token" } });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to install resolution triggers over inconsistent Issue state", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-resolution-migration-"));
  const file = join(root, "issues.db");
  const migrations = join(root, "migrations");
  const migrationSource = resolve("drizzle");
  const journal = JSON.parse(await readFile(join(migrationSource, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  const resolutionMigrationIndex = journal.entries.findIndex(({ tag }) => tag === "0036_issue_status_resolution");
  assert.notEqual(resolutionMigrationIndex, -1);
  const previousJournal = { ...journal, entries: journal.entries.slice(0, resolutionMigrationIndex) };
  await mkdir(join(migrations, "meta"), { recursive: true });
  await Promise.all([
    writeFile(join(migrations, "meta", "_journal.json"), JSON.stringify(previousJournal)),
    ...previousJournal.entries.map(({ tag }) => copyFile(join(migrationSource, `${tag}.sql`), join(migrations, `${tag}.sql`))),
  ]);

  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: migrations });
    await client.execute("insert into subjects (subject, display_name, created_at, updated_at) values ('reporter', 'Reporter', 1, 1)");
    await client.execute("insert into environments (id, key, name, kind, created_at, updated_at) values ('environment', 'test', 'Test', 'test', 1, 1)");
    await client.execute("insert into services (id, key, name, description, created_at, updated_at) values ('service', 'orders', 'Orders', '', 1, 1)");
    await client.execute("insert into service_deployments (id, service_id, environment_id, config, created_at, updated_at) values ('deployment', 'service', 'environment', '{}', 1, 1)");
    await client.execute("insert into issues (id, key, title, status, service_id, environment_id, reporter_subject, created_at, updated_at) values ('issue', 'ISSUE-20260809-002', 'Invalid resolution', 'resolved', 'service', 'environment', 'reporter', 1, 1)");

    await assert.rejects(migrate(db, { migrationsFolder: migrationSource }), /issue_resolution_state_invalid/);
    assert.equal((await client.execute("select name from sqlite_master where type = 'trigger' and name like '%resolution_state%'")).rows.length, 0);
    assert.equal((await client.execute("select name from sqlite_temp_master where name like '_issue_resolution_state_check%'")).rows.length, 0);
    assert.equal((await client.execute("select count(*) count from __drizzle_migrations")).rows[0]!.count, previousJournal.entries.length);

    await client.execute("update issues set resolved_at = 1 where id = 'issue'");
    await migrate(db, { migrationsFolder: migrationSource });
    assert.deepEqual((await client.execute("select name from sqlite_master where type = 'trigger' and name like '%resolution_state%' order by name")).rows.map((row) => row.name), ["issues_resolution_state_insert", "issues_resolution_state_update"]);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("creates a private SQLite database with JSON, dates, transactions, and foreign keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sqlite-"));
  const file = join(root, "issues.db");
  const { db, client, close } = openDatabase(file);
  try {
    await migrate(db, { migrationsFolder: resolve("drizzle") });
    assert.deepEqual((await client.execute("pragma busy_timeout")).rows, [{ timeout: 5_000 }]);
    await db.transaction(async (transaction) => {
      await transaction.insert(subjects).values({ subject: "demo-owner", displayName: "Owner", email: "owner@example.com" });
      await transaction.insert(environments).values({ key: "test", name: "Test", kind: "test" });
    });
    assert.deepEqual((await client.execute("pragma busy_timeout")).rows, [{ timeout: 5_000 }]);
    const [environment] = await db.select().from(environments);
    assert.ok(environment?.createdAt instanceof Date);
    const [prod] = await db.insert(environments).values({ key: "prod", name: "Prod", kind: "prod" }).returning();
    const [service] = await db.insert(services).values({ key: "orders", name: "Orders", description: "" }).returning();
    const [repository] = await db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "orders", url: "git@example.test:orders.git" }).returning();
    const [testDeployment] = await db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: { db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" } } }).returning();
    await assert.rejects(client.execute({
      sql: "insert into issues (id, key, title, reporter_subject, environment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      args: ["invalid-scope", "ISSUE-20260805-001", "Invalid scope", "demo-owner", environment!.id, Date.now(), Date.now()],
    }), /issue_scope_required/);
    await client.execute({
      sql: "insert into issues (id, key, title, reporter_subject, service_id, environment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["valid-scope", "ISSUE-20260805-002", "Valid scope", "demo-owner", service!.id, environment!.id, Date.now(), Date.now()],
    });
    await assert.rejects(client.execute({ sql: "insert into issues (id, key, title, status, reporter_subject, service_id, environment_id, created_at, updated_at) values (?, ?, ?, 'resolved', ?, ?, ?, ?, ?)", args: ["invalid-resolution", "ISSUE-20260805-004", "Invalid resolution", "demo-owner", service!.id, environment!.id, Date.now(), Date.now()] }), /issue_resolution_state_invalid/);
    await assert.rejects(client.execute({ sql: "update issues set status = 'resolved' where id = ?", args: ["valid-scope"] }), /issue_resolution_state_invalid/);
    await client.execute({ sql: "update issues set status = 'resolved', resolved_at = ? where id = ?", args: [Date.now(), "valid-scope"] });
    await assert.rejects(client.execute({ sql: "update issues set status = 'open' where id = ?", args: ["valid-scope"] }), /issue_resolution_state_invalid/);
    await client.execute({ sql: "update issues set status = 'open', resolved_at = null where id = ?", args: ["valid-scope"] });
    await assert.rejects(client.execute({ sql: "update issues set service_id = null where id = ?", args: ["valid-scope"] }), /issue_scope_required/);
    await assert.rejects(client.execute({
      sql: "insert into issues (id, key, title, reporter_subject, service_id, environment_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["missing-deployment", "ISSUE-20260805-003", "Missing deployment", "demo-owner", service!.id, prod!.id, Date.now(), Date.now()],
    }), /issue_deployment_required/);
    await assert.rejects(client.execute({ sql: "update issues set environment_id = ? where id = ?", args: [prod!.id, "valid-scope"] }), /issue_deployment_required/);
    const deploymentIsUsed = (error: unknown) => {
      let cause = error;
      while (cause && typeof cause === "object") {
        if (cause instanceof Error && cause.message.includes("deployment_is_used_by_issues")) return true;
        cause = "cause" in cause ? cause.cause : undefined;
      }
      return false;
    };
    await assert.rejects(db.update(serviceDeployments).set({ environmentId: prod!.id }).where(eq(serviceDeployments.id, testDeployment!.id)), deploymentIsUsed);
    await assert.rejects(db.delete(serviceDeployments).where(eq(serviceDeployments.id, testDeployment!.id)), deploymentIsUsed);
    const [prodDeployment] = await db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, config: { es: { url: "http://es.example.test", username: "" } } }).returning();
    const deployments = [testDeployment!, prodDeployment!];
    await db.insert(serviceDeploymentRepositories).values([
      { deploymentId: testDeployment!.id, repositoryId: repository!.id, baseBranch: "develop" },
      { deploymentId: prodDeployment!.id, repositoryId: repository!.id, baseBranch: "release" },
    ]);
    assert.deepEqual(deployments.map(({ config }) => configuredCapabilities(config)), [["db"], ["es"]]);
    assert.deepEqual((await db.select().from(serviceDeploymentRepositories)).map((branch) => branch.baseBranch).sort(), ["develop", "release"]);
    await assert.rejects(db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} }));
    await db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "second", url: "git@example.test:second.git" });
    await assert.rejects(db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "second", url: "git@example.test:third.git" }));
    assert.equal((await db.select().from(serviceRepositories)).length, 2);
    assert.equal((await client.execute("pragma foreign_key_check")).rows.length, 0);
    const applicationTables = await client.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name");
    assert.deepEqual(applicationTables.rows.map((row) => row.name), [
      "environments", "global_agent_configuration", "issue_attachments", "issue_cc_recipients", "issue_comments", "issue_pilot_sessions", "issue_relations", "issue_repositories",
      "issue_workspaces", "issues", "service_deployment_repositories", "service_deployments", "service_repositories", "services", "subjects",
    ]);
    const issueColumns = await client.execute("pragma table_info('issues')");
    assert.deepEqual(issueColumns.rows.map((column) => column.name), [
      "id", "key", "title", "description", "status", "priority", "type", "service_id", "environment_id",
      "reporter_subject", "assignee_subject", "resolved_at", "created_at", "updated_at",
    ]);
    const subjectColumns = await client.execute("pragma table_info('subjects')");
    assert.deepEqual(subjectColumns.rows.map((column) => column.name), ["subject", "display_name", "email", "created_at", "updated_at", "active"]);
    assert.equal((await db.select().from(subjects).where(eq(subjects.subject, "demo-owner")))[0]!.active, true);
    const serviceRepositoryColumns = await client.execute("pragma table_info('service_repositories')");
    assert.deepEqual(serviceRepositoryColumns.rows.map((column) => column.name), ["id", "service_id", "alias", "url", "created_at", "updated_at"]);
    const deploymentColumns = await client.execute("pragma table_info('service_deployments')");
    assert.deepEqual(deploymentColumns.rows.map((column) => column.name), ["id", "service_id", "environment_id", "config", "created_at", "updated_at"]);
    const deploymentRepositoryColumns = await client.execute("pragma table_info('service_deployment_repositories')");
    assert.deepEqual(deploymentRepositoryColumns.rows.map((column) => column.name), ["deployment_id", "repository_id", "base_branch", "created_at", "updated_at"]);
    const repositoryColumns = await client.execute("pragma table_info('issue_repositories')");
    assert.deepEqual(repositoryColumns.rows.map((column) => column.name), [
      "id", "issue_id", "url", "base_branch", "working_branch", "local_path", "commit_before", "created_at", "updated_at", "workspace_name",
    ]);
    const relationColumns = await client.execute("pragma table_info('issue_relations')");
    assert.deepEqual(relationColumns.rows.map((column) => column.name), ["issue_id", "related_issue_id", "created_at"]);
    const workspaceColumns = await client.execute("pragma table_info('issue_workspaces')");
    assert.deepEqual(workspaceColumns.rows.map((column) => column.name), ["issue_id", "status", "runtime_ready", "last_error", "created_at", "updated_at"]);
    const sessionColumns = await client.execute("pragma table_info('issue_pilot_sessions')");
    assert.deepEqual(sessionColumns.rows.map((column) => column.name), ["issue_id", "session_file", "workspace_path", "created_at", "updated_at"]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
