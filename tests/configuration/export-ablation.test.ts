import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { parse, stringify } from "yaml";
import { createApiFixture, createService } from "../http/fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { applicationSettings, mcpServices, serviceDeployments, userPreferences } from "../../src/db/schema.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applyFileConfiguration } from "../../src/configuration/file-configuration.ts";

const execute = promisify(execFile);
const owner = issuePilotConfig.bootstrapUser.subject;
async function files(root: string) {
  return { user: parse(await readFile(path.join(root, "user.yaml"), "utf8")), service: parse(await readFile(path.join(root, "service.yaml"), "utf8")), mcp: JSON.parse(await readFile(path.join(root, "mcp.json"), "utf8")) };
}
for (const withSubject of [true, false]) test(`current DB export preserves literal configuration and round-trips (${withSubject ? "explicit owner" : "no artificial owner"})`, async () => {
  const f = await createApiFixture(), staging = await mkdtemp(path.join(tmpdir(), "issue-pilot-export-ablation-"));
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Export", ["prod", "test", "dev"]);
    await createService(f.app, "Retired", ["test"]);
    const dms = { url: "https://dms.example.test/sse", authorization: "Bearer fixture", databases: [{ instanceAlias: "ORDERS", schemaName: "orders", instanceId: "instance", instanceHost: "db.example.test", instancePort: "3306", databaseId: "database" }] };
    const sls = { accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", region: "cn-test", project: "orders-test", logstores: ["app"] };
    const mysql = [{ host: "db.example.test", port: 3306, username: "reader", password: " literal fixture ", database: "orders" }];
    const rows = (await database.client.execute("SELECT d.id,s.key,e.key AS environment FROM service_deployments d JOIN services s ON s.id=d.service_id JOIN environments e ON e.id=d.environment_id")).rows;
    const prod = rows.find(row => row.key === "export" && row.environment === "prod")!;
    const retired = rows.find(row => row.key === "retired")!;
    await database.db.update(serviceDeployments).set({ config: { dms, sls, mysql } }).where(eq(serviceDeployments.id, String(prod.id)));
    const oldDatabase = { databases: [{ url: "mysql://retired.example.test/orders", username: "old", password: "retired-fixture" }] };
    await database.db.update(serviceDeployments).set({ config: { db: oldDatabase } }).where(eq(serviceDeployments.id, String(retired.id)));
    const template = { command: "npx", args: ["-y", "@benborla29/mcp-server-mysql", "--literal"], env: { FIXTURE_FLAG: "unchanged" } };
    await database.db.insert(applicationSettings).values({ id: 1, maxConcurrentIssues: 4, mysqlStdio: template });
    await database.db.insert(userPreferences).values({ subject: owner, dingtalk: { fields: { title: "Ticket" } } });
    await database.db.insert(mcpServices).values({ id: "docs", name: "playwright-docs", url: "https://docs.example.test/mcp", transport: "streamable_http", enabled: true });
    const output = path.join(staging, "export");
    await execute(process.execPath, ["--experimental-strip-types", "scripts/prepare-configuration.ts", "--state-root", f.root, "--output", output, ...(withSubject ? ["--subject", owner] : [])]);
    const exported = await files(output);
    assert.deepEqual(exported.mcp.mcpServers.mysql, { ...template, type: "stdio" });
    assert.ok(exported.mcp.mcpServers["playwright-docs"]);
    assert.deepEqual(exported.service.services.export.environments.dev.repositories, {});
    assert.deepEqual(exported.service.services.export.environments.prod.mysql, mysql);
    assert.equal(exported.service.services.retired.environments.test.mysql, undefined);
    assert.deepEqual(exported.user.shared.dms, { url: dms.url, authorization: dms.authorization });
    assert.deepEqual(exported.user.shared.sls, { accessKeyId: sls.accessKeyId, accessKeySecret: sls.accessKeySecret });
    for (const name of ["user.yaml", "service.yaml", "mcp.json"]) assert.equal((await stat(path.join(output, name))).mode & 0o777, 0o600);
    const deploymentBefore = (await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.id, String(prod.id))))[0]!;
    await applyFileConfiguration(database.db, output);
    assert.deepEqual((await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.id, String(prod.id))))[0]!.config, deploymentBefore.config);
    assert.deepEqual((await database.db.select().from(serviceDeployments).where(eq(serviceDeployments.id, String(retired.id))))[0]!.config.db, oldDatabase);
  } finally { await database.close(); await f.cleanup(); await rm(staging, { recursive: true, force: true }); }
});

test("reference preferences do not omit DB query credential groups or replace current concurrency", async () => {
  const f = await createApiFixture(), staging = await mkdtemp(path.join(tmpdir(), "issue-pilot-export-reference-"));
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Reference", ["prod"]);
    const sls = { accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", region: "cn-test", project: "orders-test", logstores: ["app"] };
    const [deployment] = await database.db.select().from(serviceDeployments);
    await database.db.update(serviceDeployments).set({ config: { sls } }).where(eq(serviceDeployments.id, deployment!.id));
    await database.db.insert(applicationSettings).values({ id: 1, maxConcurrentIssues: 5 });
    const referenceUser = path.join(staging, "reference-user.yaml"), referenceService = path.join(staging, "reference-service.yaml");
    await writeFile(referenceUser, stringify({ version: 2, shared: { dingtalk: { fields: { title: "Ticket" } } }, users: { [owner]: {} } }));
    await writeFile(referenceService, stringify({ version: 1, automation: { maxConcurrentIssues: 1 } }));
    const output = path.join(staging, "export");
    const args = ["--experimental-strip-types", "scripts/prepare-configuration.ts", "--state-root", f.root, "--output", output, "--subject", owner, "--reference-user", referenceUser, "--reference-service", referenceService];
    await execute(process.execPath, args);
    const exported = await files(output);
    assert.deepEqual(exported.user.shared.sls, { accessKeyId: sls.accessKeyId, accessKeySecret: sls.accessKeySecret });
    assert.equal(exported.service.automation.maxConcurrentIssues, 5);
    await applyFileConfiguration(database.db, output);
    assert.deepEqual((await database.db.select().from(serviceDeployments))[0]!.config.sls, sls);
  } finally { await database.close(); await f.cleanup(); await rm(staging, { recursive: true, force: true }); }
});

test("explicit missing references and exports inside live state fail before creating output files", async () => {
  const f = await createApiFixture(), staging = await mkdtemp(path.join(tmpdir(), "issue-pilot-export-boundary-"));
  try {
    const base = ["--experimental-strip-types", "scripts/prepare-configuration.ts", "--state-root", f.root, "--subject", owner];
    for (const kind of ["user", "service", "mcp"]) {
      const output = path.join(staging, kind);
      await assert.rejects(execute(process.execPath, [...base, "--output", output, `--reference-${kind}`, path.join(staging, "missing") ]));
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
    const nested = path.join(f.root, "workspaces", "accidental-export");
    await assert.rejects(execute(process.execPath, [...base, "--output", nested]));
    await assert.rejects(stat(nested), { code: "ENOENT" });
  } finally { await f.cleanup(); await rm(staging, { recursive: true, force: true }); }
});

test("moving a legacy source still requires its explicit owner when ordinary exports need none", async () => {
  const f = await createApiFixture(), staging = await mkdtemp(path.join(tmpdir(), "issue-pilot-export-source-owner-"));
  try {
    const reference = path.join(staging, "service.yaml");
    await writeFile(reference, stringify({ version: 1, sources: { dingtalk: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=row", assignee: "Owner" } } }));
    const output = path.join(staging, "export");
    await assert.rejects(execute(process.execPath, ["--experimental-strip-types", "scripts/prepare-configuration.ts", "--state-root", f.root, "--output", output, "--reference-service", reference]));
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally { await f.cleanup(); await rm(staging, { recursive: true, force: true }); }
});
