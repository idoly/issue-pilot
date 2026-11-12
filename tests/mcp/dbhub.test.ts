import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("installed DBHub preserves readonly SQL and rejects executing EXPLAIN options over stdio", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dbhub-protocol-"));
  const database = new DatabaseSync(path.join(root, "fixture.db"));
  database.exec("CREATE TABLE evidence (id INTEGER); INSERT INTO evidence VALUES (1)");
  const client = new Client({ name: "dbhub-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve("@bytebase/dbhub"), "--transport", "stdio", "--config", fileURLToPath(new URL("../../scripts/dbhub.toml", import.meta.url))],
    env: { PATH: process.env.PATH!, HOME: root, DBHUB_DSN: `sqlite://${path.join(root, "fixture.db")}` },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const sql = tools.find((tool) => tool.name.startsWith("execute_sql"))!;
    const explain = tools.find((tool) => tool.name.startsWith("explain_sql"))!;
    assert.ok(sql && explain);
    const result = await client.callTool({ name: sql.name, arguments: { sql: "SELECT * FROM evidence" } });
    assert.ok(!result.isError, JSON.stringify(result));
    const plan = await client.callTool({ name: explain.name, arguments: { sql: "SELECT * FROM evidence" } });
    assert.ok(!plan.isError, JSON.stringify(plan));
    const mutation = await client.callTool({ name: sql.name, arguments: { sql: "DELETE FROM evidence" } });
    assert.equal(mutation.isError, true);
    for (const input of ["ANALYSE DELETE FROM evidence", '("ANALYZE" TRUE) DELETE FROM evidence', "('ANALYZE' TRUE) DELETE FROM evidence"]) {
      const rejected = await client.callTool({ name: explain.name, arguments: { sql: input } });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /does not support ANALYZE|only accepts these EXPLAIN options/);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evidence").get()!.count, 1);
  } finally {
    await client.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
