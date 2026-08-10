import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { environments, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { configuredCapabilities } from "../../src/domain/contracts.ts";

test("preserves issue, CC, and session data when removing unused metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-migration-"));
  const file = join(root, "issues.db");
  const migrations = join(root, "migrations");
  const migrationSource = resolve("drizzle");
  const journal = JSON.parse(await readFile(join(migrationSource, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  assert.deepEqual(journal.entries.slice(-2).map(({ tag }) => tag), ["0031_remove_unused_issue_metadata", "0032_remove_redundant_pi_session_id"]);
  const previousJournal = { ...journal, entries: journal.entries.slice(0, -2) };
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
      `insert into issues (id, key, title, service_id, environment_id, reporter_subject, version, created_at, updated_at) values ('issue', 'ISSUE-20260809-001', 'Preserved', 'service', 'environment', 'reporter', 7, ${now}, ${now})`,
      "insert into issue_cc_recipients (issue_id, subject, created_at) values ('issue', 'recipient', 2)",
      "insert into issue_history (id, issue_id, actor_subject, action, changes, created_at) values ('history', 'issue', 'reporter', 'created', '{}', 3)",
      "insert into issue_pilot_sessions (issue_id, pi_session_id, session_file, workspace_path, created_at, updated_at) values ('issue', 'pi-session', '/sessions/issue.jsonl', '/workspaces/issue', 4, 4)",
    ]) await client.execute(statement);

    await migrate(db, { migrationsFolder: migrationSource });

    assert.deepEqual((await client.execute("select key, title from issues")).rows, [{ key: "ISSUE-20260809-001", title: "Preserved" }]);
    assert.deepEqual((await client.execute("select issue_id, subject from issue_cc_recipients")).rows, [{ issue_id: "issue", subject: "recipient" }]);
    assert.deepEqual((await client.execute("select issue_id, session_file, workspace_path from issue_pilot_sessions")).rows, [{ issue_id: "issue", session_file: "/sessions/issue.jsonl", workspace_path: "/workspaces/issue" }]);
    assert.equal((await client.execute("select name from sqlite_master where type = 'table' and name = 'issue_history'")).rows.length, 0);
    assert.equal((await client.execute("pragma table_info('issues')")).rows.some((column) => column.name === "version"), false);
    assert.equal((await client.execute("pragma table_info('issue_cc_recipients')")).rows.some((column) => column.name === "created_at"), false);
    assert.equal((await client.execute("pragma table_info('issue_pilot_sessions')")).rows.some((column) => column.name === "pi_session_id"), false);
    await assert.rejects(client.execute("insert into issue_cc_recipients (issue_id, subject) values ('issue', 'recipient')"));
    await assert.rejects(client.execute("insert into issue_cc_recipients (issue_id, subject) values ('missing', 'recipient')"));
    assert.equal((await client.execute("pragma foreign_key_check")).rows.length, 0);
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
    await db.transaction(async (transaction) => {
      await transaction.insert(subjects).values({ subject: "demo-owner", username: "owner", displayName: "Owner", email: "owner@example.com" });
      await transaction.insert(environments).values({ key: "test", name: "Test", kind: "test" });
    });
    const [environment] = await db.select().from(environments);
    assert.ok(environment?.createdAt instanceof Date);
    const [prod] = await db.insert(environments).values({ key: "prod", name: "Prod", kind: "prod" }).returning();
    const [service] = await db.insert(services).values({ key: "orders", name: "Orders", description: "" }).returning();
    await db.insert(serviceRepositories).values({ serviceId: service!.id, url: "git@example.test:orders.git" });
    const deployments = await db.insert(serviceDeployments).values([
      { serviceId: service!.id, environmentId: environment!.id, baseBranch: "develop", config: { db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" } } },
      { serviceId: service!.id, environmentId: prod!.id, baseBranch: "release", config: { es: { url: "http://es.example.test", username: "" } } },
    ]).returning();
    assert.deepEqual(deployments.map(({ config }) => configuredCapabilities(config)), [["db"], ["es"]]);
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
    const applicationTables = await client.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name");
    assert.deepEqual(applicationTables.rows.map((row) => row.name), [
      "environments", "issue_attachments", "issue_cc_recipients", "issue_comments", "issue_pilot_sessions", "issue_repositories",
      "issue_workspaces", "issues", "service_deployments", "service_repositories", "services", "subjects",
    ]);
    const issueColumns = await client.execute("pragma table_info('issues')");
    assert.deepEqual(issueColumns.rows.map((column) => column.name), [
      "id", "key", "title", "description", "status", "priority", "type", "service_id", "environment_id",
      "reporter_subject", "assignee_subject", "resolved_at", "created_at", "updated_at",
    ]);
    const repositoryColumns = await client.execute("pragma table_info('issue_repositories')");
    assert.deepEqual(repositoryColumns.rows.map((column) => column.name), [
      "id", "issue_id", "url", "base_branch", "working_branch", "local_path", "commit_before", "created_at", "updated_at",
    ]);
    const sessionColumns = await client.execute("pragma table_info('issue_pilot_sessions')");
    assert.deepEqual(sessionColumns.rows.map((column) => column.name), ["issue_id", "session_file", "workspace_path", "created_at", "updated_at"]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
