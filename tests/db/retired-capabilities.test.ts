import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { applyServiceConfiguration, prepareServiceConfiguration } from "../../src/configuration/service-deployments.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { openDatabase } from "../../src/db/client.ts";
import { environments, repositories, serviceDeployments, services } from "../../src/db/schema.ts";

test("retiring adapters preserves private history and active switches while disabling known Playwright MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-retired-upgrade-"));
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    await database.client.executeMultiple(
      "CREATE TABLE capability_switches (key text PRIMARY KEY,enabled integer NOT NULL,updated_at integer NOT NULL); CREATE TABLE mcp_services (id text PRIMARY KEY,name text,stdio text,enabled integer,updated_at integer); CREATE TABLE service_deployments (id text PRIMARY KEY,config text);",
    );
    for (const key of ["nacos", "db", "redis", "mq", "es", "dms", "sls"]) await database.client.execute({ sql: "INSERT INTO capability_switches VALUES(?,?,100)", args: [key, key === "dms" ? 0 : 1] });
    await database.client.execute({ sql: "INSERT INTO mcp_services VALUES('browser','Browser',?,1,100)", args: [JSON.stringify({ command: "npx", args: ["-y", "@playwright/mcp@0.0.83"] })] });
    await database.client.execute({ sql: "INSERT INTO mcp_services VALUES('mysql','mysql',?,1,100)", args: [JSON.stringify({ command: "npx", args: ["-y", "@benborla29/mcp-server-mysql@2.0.9"] })] });
    const historical = JSON.stringify({ db: { databases: [{ url: "mysql://legacy.example.test:3306/orders", password: "fixture-private-history" }] } });
    await database.client.execute({ sql: "INSERT INTO service_deployments VALUES('deployment',?)", args: [historical] });
    await database.client.executeMultiple(await readFile(path.resolve("drizzle/0059_retire_native_adapters.sql"), "utf8"));
    const switches = await database.client.execute("SELECT key,enabled,updated_at FROM capability_switches ORDER BY key");
    assert.deepEqual(
      switches.rows.map((row) => [row.key, row.enabled, row.updated_at]),
      [
        ["dms", 0, 100],
        ["sls", 1, 100],
      ],
    );
    const connections = await database.client.execute("SELECT id,enabled,updated_at FROM mcp_services ORDER BY id");
    assert.equal(connections.rows[0]!.enabled, 0);
    assert.equal(connections.rows[1]!.enabled, 1);
    assert.equal(connections.rows[1]!.updated_at, 100);
    assert.equal((await database.client.execute("SELECT config FROM service_deployments")).rows[0]!.config, historical);
    await assert.rejects(database.client.execute("INSERT INTO capability_switches VALUES('redis',1,100)"), /CHECK/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment writes drop retired capability and binding keys but keep archived development data", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-retired-deployment-write-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [production] = await database.db.select().from(environments).where(eq(environments.key, "prod")).limit(1);
    const [development] = await database.db.select().from(environments).where(eq(environments.key, "dev")).limit(1);
    const url = "git@example.test:team/orders.git";
    await database.db.insert(repositories).values({ name: "orders", url });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    const archivedDevelopment = { branch: "historical", note: "retained evidence" };
    // Historical rows may still carry retired keys; the next write must not copy them forward.
    await database.client.execute({
      sql: "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment-prod', ?, ?, ?, unixepoch(), unixepoch())",
      args: [
        service!.id,
        production!.id,
        JSON.stringify({
          dms: { databases: [] },
          nacos: { serverUrl: "https://nacos.example.test", password: "nacos-secret" },
          db: { databases: [{ url: "mysql://db.example.test/orders", password: "db-secret" }] },
          redis: { host: "redis.example.test", password: "redis-secret" },
          mq: { host: "mq.example.test", password: "mq-secret" },
          es: { url: "https://es.example.test", password: "es-secret" },
          mcpServices: ["old-binding"],
          archivedDevelopment,
        }),
      ],
    });
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: development!.id, config: { archivedDevelopment } });

    const prepared = await prepareServiceConfiguration({
      executor: database.db,
      serviceId: service!.id,
      input: {
        repositories: [{ alias: "orders", url }],
        deployments: [
          { environmentKey: "prod", capabilities: [], repositoryBranches: [{ repositoryAlias: "orders", baseBranch: "main" }] },
          { environmentKey: "dev", capabilities: [], repositoryBranches: [] },
        ],
      },
    });
    await applyServiceConfiguration({ executor: database.db, serviceId: service!.id, prepared });

    const rows = await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, service!.id));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(row.config, { archivedDevelopment });
      for (const key of ["nacos", "db", "redis", "mq", "es", "mcpServices"]) assert.equal(key in row.config, false, key);
    }
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
