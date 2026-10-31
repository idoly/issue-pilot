import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createWorkspaceTool } from "../../src/agent/workspace-tool.ts";
import type { IssueProjectManager } from "../../src/workspace/project.ts";
import { issues, issueWorkspaces } from "../../src/db/schema.ts";
import { applyIssueCredentials } from "../../src/configuration/user-credentials.ts";
import { projectCapabilityConfiguration } from "../../src/configuration/credentials.ts";
import { listEnvironmentServices } from "../../src/workspace/issue-services.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const target = { instanceAlias: "ORDERS", schemaName: "orders", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" };
async function serviceInput(f: Awaited<ReturnType<typeof createApiFixture>>, key = "other") {
  const service = JSON.parse((await f.app.inject({ method: "GET", url: "/api/config" })).body).services.find((row: { key: string }) => row.key === key);
  return { name: service.name, description: service.description, repositories: service.repositories, deployments: service.deployments.map((deployment: { environmentKey: string; repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }>; capabilities: string[] }) => ({ environmentKey: deployment.environmentKey, repositoryBranches: deployment.repositoryBranches.map(row => ({ repositoryAlias: row.repositoryAlias, baseBranch: row.baseBranch })), capabilities: [], mcpServices: [] })) };
}

test("workspace tool schema mutations remain local to that tool instance", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  let operation: object | undefined;
  try {
    await createService(f.app, "SchemaIsolation", ["dev", "test"]);
    const visible = await createIssue(f.app, "schemaisolation", "dev");
    const [issue] = await database.db.select().from(issues);
    assert.ok(issue && issue.key === visible.id);
    const first = await createWorkspaceTool(database.db, issue, "dev", {} as IssueProjectManager, "/unused");
    operation = Reflect.get(Reflect.get(Reflect.get(first.parameters, "anyOf")[0], "properties"), "operation");
    assert.ok(operation);
    Reflect.set(operation, "const", "changed-by-extension");
    const second = await createWorkspaceTool(database.db, issue, "dev", {} as IssueProjectManager, "/unused");
    const result = await second.execute("list", { operation: "list" }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(result), /schemaisolation/);
  } finally {
    if (operation) Reflect.set(operation, "const", "list");
    await database.close();
    await f.cleanup();
  }
});

test("service configuration and generated descriptions share one source without copying secrets", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Entry", ["prod", "test", "dev"]); await createService(f.app, "Other", ["prod", "test"]);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/resource-connections", headers })).statusCode, 404);
    const shared = { url: "https://dms.example.test/sse", authorization: "Bearer fixture-private-token" };
    const savedCredentials = await f.app.inject({ method: "PUT", url: "/api/config/shared-dms-credentials", headers, payload: { mode: "replace", expectedRevision: 0, ...shared } });
    assert.equal(savedCredentials.statusCode, 200, savedCredentials.body);
    const input = await serviceInput(f);
    const update = await f.app.inject({ method: "PATCH", url: "/api/services/other", headers, payload: { ...input, description: "按 order_no 关联网关日志。", deployments: input.deployments.map((deployment: { environmentKey: string }) => ({ ...deployment, capabilities: ["dms"], dms: { databases: [{ ...target, schemaName: deployment.environmentKey === "test" ? "orders_test" : "orders" }] } })) } });
    assert.equal(update.statusCode, 200, update.body);
    const displayed = await f.app.inject({ method: "GET", url: "/api/services/other/configuration-description", headers });
    assert.equal(displayed.statusCode, 200, displayed.body);
    assert.equal(displayed.headers["cache-control"], "private, no-store");
    assert.ok(!displayed.body.includes("Bearer fixture-private-token"));
    const privateDescription = JSON.parse(displayed.body).context;
    assert.doesNotMatch(privateDescription, /\| Authorization \|/);
    assert.ok(privateDescription.indexOf("### 测试环境") < privateDescription.indexOf("### 正式环境"));
    const entryDescription = JSON.parse((await f.app.inject({ method: "GET", url: "/api/services/entry/configuration-description", headers })).body).context;
    assert.ok(entryDescription.indexOf("### 开发环境") < entryDescription.indexOf("### 测试环境"));
    assert.ok(entryDescription.indexOf("### 测试环境") < entryDescription.indexOf("### 正式环境"));
    const config = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.ok(!config.body.includes("fixture-private-token"));
    const other = JSON.parse(config.body).services.find((row: { key: string }) => row.key === "other");
    assert.equal(other.description, "按 order_no 关联网关日志。");
    assert.match(other.context, /orders_test/); assert.doesNotMatch(other.context, /Shared DMS|代码基准分支|访问配置/);
    assert.deepEqual(other.deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod").dms, { databases: [target] });
    assert.equal((await f.app.inject({ method: "GET", url: "/api/resources" })).statusCode, 404);
    const dev = String((await db.client.execute("select id from environments where key='dev'")).rows[0]!.id);
    const prod = String((await db.client.execute("select id from environments where key='prod'")).rows[0]!.id);
    const services = await listEnvironmentServices(db.db, dev);
    const [issue] = await db.db.insert(issues).values({ key: "ISSUE-20261017-901", title: "investigate", type: "defect_fix", serviceId: services.find(row => row.service.key === "entry" && row.environment.key === "dev")!.service.id, environmentId: dev, reporterSubject: issuePilotConfig.bootstrapUser.subject }).returning();
    await db.db.insert(issueWorkspaces).values({ issueId: issue!.id });
    const workspace = await createWorkspaceTool(db.db, issue!, "dev", {} as IssueProjectManager, "/unused");
    const notes = await workspace.execute("describe", { operation: "describe", service: "other", environment: "test" }, undefined, undefined, {} as never);
    assert.match(JSON.stringify(notes.content), /orders_test/);
    assert.ok(!JSON.stringify(notes).includes("fixture-private-token"));
    await assert.rejects(workspace.execute("include", { operation: "include", service: "other" }, undefined, undefined, {} as never));
    const scopes = services.filter(row => row.environment.kind !== "dev").map(row => ({ environmentKey: row.environment.key, serviceKey: row.service.key, serviceName: row.service.name, config: applyIssueCredentials(projectCapabilityConfiguration(row.deployment.config), undefined, { dms: shared }) }));
    const tools = createCapabilityTools({ serviceKey: "entry", environmentKey: "dev", capabilities: ["dms"] }, {}, { serviceScopes: scopes });
    assert.deepEqual(tools.map(tool => tool.name), ["service_query"]);
    assert.ok(!JSON.stringify(tools[0]!.parameters).includes("fixture-private-token"));
    assert.match(JSON.stringify(tools[0]!.parameters), /orders_test/);
    assert.match(JSON.stringify(tools[0]!.parameters), /"const":"prod"/);
    await assert.rejects(tools[0]!.execute("wrong-source", { environment: "dev", service: "other", capability: "dms", schema: "orders", script: "SELECT 1" }, undefined, undefined, {} as never), /invalid_service_query_input/);
    const prodServices = await listEnvironmentServices(db.db, prod);
    assert.ok(prodServices.every(row => row.environment.key === "prod"));
  } finally { await db.close(); await f.cleanup(); }
});

test("formal/test changes reserve development Issues that inherit those capabilities", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Entry", ["dev"]); await createService(f.app, "Other", ["prod"]);
    const input = await serviceInput(f);
    await createIssue(f.app, "entry", "dev");
    const save = () => f.app.inject({ method: "PATCH", url: "/api/services/other", headers, payload: { ...input, description: "new notes" } });
    assert.equal((await save()).statusCode, 409);
    const createdWhileRunning = await f.app.inject({ method: "POST", url: "/api/services", headers, payload: { ...input, name: "Another source", repositories: input.repositories.map((repository: { alias: string; url: string }) => ({ alias: repository.alias, url: repository.url })) } });
    assert.equal(createdWhileRunning.statusCode, 409);
    f.engine.running.clear(); f.engine.closeSessionHook = async () => { throw new Error("close_failed"); };
    assert.equal((await save()).statusCode, 500);
    f.engine.closeSessionHook = undefined; assert.equal((await save()).statusCode, 200);
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });
    assert.equal((await f.app.inject({ method: "GET", url: "/api/services/other/configuration-description", headers: { "x-issue-pilot-subject": "product" } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/services/missing/configuration-description", headers })).statusCode, 404);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/services/other", headers: { "x-issue-pilot-subject": "product" }, payload: input })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/services/other", headers, payload: { ...input, deployments: input.deployments.map((row: object) => ({ ...row, mcpServices: ["missing"] })) } })).statusCode, 400);
    const dev = await serviceInput(f, "entry");
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/services/entry", headers, payload: { ...dev, deployments: dev.deployments.map((row: object) => ({ ...row, capabilities: ["redis"], redis: { host: "wrong", credentialUpdate: { mode: "clear" } } })) } })).statusCode, 400);
  } finally { await f.cleanup(); }
});
