import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("adds stdio without changing HTTP MCP records or deployment references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-migration-")), migrationRoot = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0055_mcp_stdio")) };
  await mkdir(path.join(migrationRoot, "meta"), { recursive: true });
  await writeFile(path.join(migrationRoot, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(migrationRoot, `${tag}.sql`));
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(database.db, { migrationsFolder: migrationRoot });
    await database.client.execute("INSERT INTO mcp_services (id,name,url,transport,authorization,enabled,created_at,updated_at) VALUES ('mcp-1','Existing','https://example.test/mcp','sse','private-token',1,11,22)");
    await database.client.execute("INSERT INTO services (id,key,name,created_at,updated_at) VALUES ('service-1','test','Test',1,1)");
    await database.client.execute("INSERT INTO environments (id,key,name,kind,created_at,updated_at) VALUES ('environment-1','test','Test','test',1,1)");
    await database.client.execute({ sql: "INSERT INTO service_deployments (id,service_id,environment_id,config,created_at,updated_at) VALUES ('deployment-1','service-1','environment-1',?,1,1)", args: [JSON.stringify({ mcpServices: ["mcp-1"] })] });
    const before = (await database.client.execute("SELECT * FROM mcp_services")).rows[0]!;
    await migrate(database.db, { migrationsFolder: path.resolve("drizzle") });
    const after = (await database.client.execute("SELECT * FROM mcp_services")).rows[0]!;
    const { stdio, ...retained } = after; assert.equal(stdio, null); assert.deepEqual(retained, before);
    assert.deepEqual(JSON.parse(String((await database.client.execute("SELECT config FROM service_deployments")).rows[0]!.config)).mcpServices, ["mcp-1"]);
    await database.client.execute({ sql: "INSERT INTO mcp_services (id,name,url,transport,stdio,created_at,updated_at) VALUES ('stdio-1','Local','','stdio',?,1,1)", args: [JSON.stringify({ command: "node", args: [], env: {} })] });
    await assert.rejects(database.client.execute("UPDATE mcp_services SET transport='invalid'"), /CHECK constraint/);
    await assert.rejects(database.client.execute("UPDATE mcp_services SET name='Existing' WHERE id='stdio-1'"), /UNIQUE constraint/);
    assert.equal((await database.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await database.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
