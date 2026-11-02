import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase, type DatabaseConnection } from "../../src/db/client.ts";
import { environments, mcpServices, serviceDeployments, services } from "../../src/db/schema.ts";

const target = { host: "db.example.test", port: 3306, username: "reader@example", password: " literal p@ss:/?#% ", database: "orders" };
const migrationOptions = { migrationsFolder: path.resolve("drizzle") };

async function withOldSchema(run: (database: DatabaseConnection) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dbhub-migration-"));
  const folder = path.join(root, "migrations");
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0068_dbhub_targets")) };
    await mkdir(path.join(folder, "meta"), { recursive: true });
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
    for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    await migrate(database.db, { migrationsFolder: folder });
    await database.client.execute("PRAGMA foreign_keys = ON");
    await database.db.insert(environments).values([
      { id: "prod", key: "prod", name: "Production", kind: "prod" },
      { id: "test", key: "test", name: "Test", kind: "test" },
      { id: "dev", key: "dev", name: "Development", kind: "dev" },
    ]);
    await database.db.insert(services).values({ id: "service", key: "service", name: "Service", revision: 3 });
    await run(database);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

async function insertDeployment(database: DatabaseConnection, environment: string, config: unknown): Promise<void> {
  await database.db.insert(serviceDeployments).values({ id: environment, serviceId: "service", environmentId: environment, config: {} });
  await database.client.execute({ sql: "UPDATE service_deployments SET config = ? WHERE id = ?", args: [JSON.stringify(config), environment] });
}

async function state(database: DatabaseConnection) {
  return {
    deployments: (await database.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows,
    services: (await database.client.execute("SELECT * FROM services ORDER BY id")).rows,
    connections: (await database.client.execute("SELECT * FROM mcp_services ORDER BY id")).rows,
    migrations: (await database.client.execute("SELECT * FROM __drizzle_migrations ORDER BY id")).rows,
  };
}

test("DBHub migration preserves target order, literal credentials, unrelated data and existing connections; repeated migration is inert", async () => {
  await withOldSchema(async database => {
    const targets = [target, { ...target, host: "2001:db8::1", database: "audit" }];
    const historical = { mysql: [{ ...target, password: "private archived evidence" }] };
    await insertDeployment(database, "prod", { mysql: targets, redis: { historical: true } });
    await insertDeployment(database, "test", { dbhub: [{ ...target, type: "postgres", port: 5432 }] });
    await insertDeployment(database, "dev", { archivedDevelopment: historical });
    await database.db.insert(mcpServices).values({ id: "dbhub-existing", name: "Existing DBHub", url: "", transport: "stdio", deploymentId: "prod", enabled: true, stdio: { command: "/fixture/node", args: ["/fixture/dbhub.js"], env: { DBHUB_DSN: "fixture-connection" } } });
    const before = await state(database);
    await migrate(database.db, migrationOptions);
    const after = await state(database);
    const configs = Object.fromEntries(after.deployments.map(row => [String(row.id), JSON.parse(String(row.config))]));
    assert.deepEqual(configs.prod, { dbhub: targets.map(value => ({ ...value, type: "mysql" })), redis: { historical: true } });
    for (const id of ["test", "dev"]) assert.deepEqual(after.deployments.find(row => row.id === id), before.deployments.find(row => row.id === id));
    assert.equal(after.services[0]!.revision, 4);
    assert.deepEqual(after.connections, before.connections);
    await migrate(database.db, migrationOptions);
    assert.deepEqual(await state(database), after);
    assert.equal((await database.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.deepEqual((await database.client.execute("PRAGMA foreign_key_check")).rows, []);
  });
});

test("empty historical MySQL arrays are removed without creating an active development configuration", async () => {
  await withOldSchema(async database => {
    await insertDeployment(database, "dev", { mysql: [], archivedDevelopment: { branch: "historical" } });
    await migrate(database.db, migrationOptions);
    const [row] = (await state(database)).deployments;
    assert.deepEqual(JSON.parse(String(row!.config)), { archivedDevelopment: { branch: "historical" } });
  });
});

const invalidConfigurations = [
  { mysql: null },
  { mysql: {} },
  { mysql: [target], dbhub: [] },
  { mysql: [null] },
  { mysql: ["not-an-object"] },
  { mysql: [{ ...target, host: "user@db" }] },
  { mysql: [{ ...target, port: "3306" }] },
  { mysql: [{ ...target, password: "" }] },
  { mysql: [{ ...target, password: "nul\0secret" }] },
  { mysql: [{ ...target, unexpected: "preserve unknown fields" }] },
  { mysql: [target, target] },
];
for (const [index, config] of invalidConfigurations.entries()) test(`DBHub migration rejects invalid/conflicting historical configuration ${index} atomically and permits retry after explicit correction`, async () => {
  await withOldSchema(async database => {
    await insertDeployment(database, "prod", { mysql: [target] });
    await insertDeployment(database, "test", config);
    const before = await state(database);
    await assert.rejects(migrate(database.db, migrationOptions), error => {
      assert.doesNotMatch(String(error), /literal p@ss/);
      return true;
    });
    assert.deepEqual(await state(database), before);
    assert.deepEqual((await database.client.execute("SELECT name FROM sqlite_master WHERE name = '__dbhub_migration_guard'")).rows, []);
    await database.client.execute({ sql: "UPDATE service_deployments SET config = ? WHERE id = 'test'", args: [JSON.stringify({ mysql: [target] })] });
    await migrate(database.db, migrationOptions);
    assert.equal((await state(database)).services[0]!.revision, 4);
  });
});

for (const cause of ["development-target", "historical-command"] as const) test(`DBHub migration preserves unsafe ${cause} for owner inspection`, async () => {
  await withOldSchema(async database => {
    await insertDeployment(database, cause === "development-target" ? "dev" : "prod", { mysql: [target] });
    if (cause === "historical-command") await database.db.insert(mcpServices).values({ id: "mysql-historical", name: "Historical", url: "", transport: "stdio", deploymentId: "prod", enabled: true, stdio: { command: "/unknown/command", args: [], env: {} } });
    const before = await state(database);
    await assert.rejects(migrate(database.db, migrationOptions));
    assert.deepEqual(await state(database), before);
  });
});
