import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { stringify } from "yaml";
import { eq } from "drizzle-orm";
import { createApiFixture } from "../http/fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { applicationSettings, mcpServices, services, userCredentials, userPreferences } from "../../src/db/schema.ts";

const execute = promisify(execFile);
test("explicit import refuses an active API, persists preferences and MySQL ownership, and repeats without rewriting credentials", async () => {
  const f = await createApiFixture();
  // Import is offline. Reopen readers after each CLI invocation like an API restart.
  const snapshot = async () => {
    const database = openDatabase(f.databaseFile);
    try {
      return {
        settings: (await database.db.select().from(applicationSettings))[0]!,
        preference: (await database.db.select().from(userPreferences))[0]!,
        credentials: (await database.db.select().from(userCredentials).where(eq(userCredentials.subject, issuePilotConfig.bootstrapUser.subject)))[0]!,
        connections: await database.db.select().from(mcpServices),
        service: (await database.db.select().from(services).where(eq(services.key, "imported")))[0]!,
      };
    } finally { await database.close(); }
  };
  try {
    const user = { version: 2, shared: { dingtalk: { apiKey: "global-gateway-key", fields: { title: "序号" } } }, users: { [issuePilotConfig.bootstrapUser.subject]: { apiKeys: { "enterprise-ai": "imported-private-key" }, dingtalk: { source: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=row", assignee: "Owner" } } } } };
    const service = { version: 2, automation: { maxConcurrentIssues: 2 }, repositories: { app: "git@example.test:team/app.git" }, services: { imported: { name: "Imported", environments: { prod: { repositories: { app: "release" }, mysql: [{ host: "db.example.test", port: 3306, username: "reader", password: " private mysql ", database: "orders" }] }, dev: { repositories: { app: "old-independent-dev" } } } } } };
    await writeFile(path.join(f.root, "service.yaml"), stringify(service), { mode: 0o600 });
    await writeFile(path.join(f.root, "user.yaml"), stringify(user), { mode: 0o600 });
    await writeFile(path.join(f.root, "mcp.json"), JSON.stringify({ mcpServers: { mysql: { command: "npx", args: ["-y", "@benborla29/mcp-server-mysql@2.0.9"] }, dingtalk: { url: "https://gateway.example.test/mcp" } } }), { mode: 0o600 });
    const args = ["--experimental-strip-types", "scripts/import-configuration.ts", "--state-root", f.root, "--apply"];
    await assert.rejects(execute(process.execPath, args), error => error instanceof Error && "stderr" in error && /application_already_running/.test(String(error.stderr)));
    await f.stop();
    const imported = await execute(process.execPath, args);
    assert.equal(JSON.parse(imported.stdout).imported, true); assert.doesNotMatch(imported.stdout + imported.stderr, /imported-private-key|global-gateway-key|private mysql/);
    const original = await snapshot();
    assert.equal(original.settings.maxConcurrentIssues, 2); assert.equal(original.preference.dingtalk.source?.assignee, "Owner");
    assert.equal(original.credentials.modelApiKeys["enterprise-ai"], "imported-private-key");
    assert.equal(original.connections.filter(row => row.deploymentId).length, 1);
    assert.equal(original.connections.find(row => row.deploymentId)!.stdio!.env.MYSQL_PASS, " private mysql ");
    const repeat = await execute(process.execPath, args); assert.equal(JSON.parse(repeat.stdout).imported, true);
    assert.deepEqual(await snapshot(), original);
    service.services.imported.environments.prod.mysql[0]!.port = 0;
    await writeFile(path.join(f.root, "service.yaml"), stringify(service));
    await assert.rejects(execute(process.execPath, args), error => error instanceof Error && "stderr" in error && /configuration_import_failed/.test(String(error.stderr)) && !/private mysql|imported-private-key/.test(String(error.stderr)));
    assert.deepEqual(await snapshot(), original);
    assert.equal(await readFile(path.join(f.root, "user.yaml"), "utf8"), stringify(user));
    service.services.imported.environments.prod.mysql[0]!.port = 3306;
    service.services.imported.environments.prod.mysql[0]!.database = "orders_changed";
    await writeFile(path.join(f.root, "service.yaml"), stringify(service));
    await execute(process.execPath, args);
    const changed = await snapshot();
    assert.equal(changed.service.revision, original.service.revision + 1);
    assert.equal(changed.connections.find(row => row.deploymentId)!.stdio!.env.MYSQL_DB, "orders_changed");
  } finally { await f.cleanup(); }
});
