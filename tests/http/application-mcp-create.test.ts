import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Settings } from "typebox/system";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentEventBus } from "../../src/agent/events.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createApiFixture, createService } from "./fixture.ts";

const payload = (title: string, workMode = "test_analysis") => ({ title, serviceKey: "mcp-create", workMode });
const parsed = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

test("MCP creation delegates to the standard transaction, attributes the reporter and enqueues once", async () => {
  const events = new AgentEventBus();
  const f = await createApiFixture({ events }); const client = new Client({ name: "creation-fixture", version: "1" });
  try {
    await createService(f.app, "MCP Create", ["test", "prod", "dev"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp"), { requestInit: { headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject } } }) as Parameters<Client["connect"]>[0]);
    const created = await client.callTool({ name: "issue_create", arguments: payload("Created through MCP") });
    assert.ok(!created.isError, JSON.stringify(created));
    const issue = parsed(created); assert.match(issue.id, /^ISSUE-\d{8}-\d{3,}$/);
    assert.equal(issue.title, "Created through MCP"); assert.equal(issue.environmentKey, "test"); assert.equal(issue.priority, "p2");
    assert.equal(f.engine.enqueued.length, 1);
    const detail = JSON.parse((await f.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).body);
    assert.equal(detail.reporter.subject, issuePilotConfig.bootstrapUser.subject);
    assert.equal(detail.workspace.status, "not_created");
    const message = await client.callTool({ name: "issue_message", arguments: { key: issue.id, message: "补充：请先检查日志，再给结论。" } });
    assert.ok(!message.isError, JSON.stringify(message));
    assert.equal(parsed(message).accepted, true);
    assert.equal(f.engine.messages.at(-1), "补充：请先检查日志，再给结论。");
    assert.equal(f.engine.gitIdentities.at(-1)?.name, issuePilotConfig.bootstrapUser.name);
    const empty = await client.callTool({ name: "issue_message", arguments: { key: issue.id, message: " " } });
    assert.equal(empty.isError, true);
    events.publish({ id: "current-run-start", issueId: f.engine.enqueued[0]!, createdAt: new Date().toISOString(), event: { type: "agent_start" } });
    events.publish({ id: "current-run-progress", issueId: f.engine.enqueued[0]!, createdAt: new Date().toISOString(), event: { type: "message_start", message: fauxAssistantMessage("当前轮次的补充要求") } });
    const conversation = await client.callTool({ name: "issue_conversation", arguments: { key: issue.id } });
    assert.ok(!conversation.isError);
    assert.ok(JSON.stringify(conversation).includes("当前轮次的补充要求"));
    const beforeInvalid = f.engine.enqueued.length;
    const invalid = await client.callTool({ name: "issue_create", arguments: { ...payload("Invalid"), environmentKey: "dev" } });
    assert.equal(invalid.isError, true); assert.equal(f.engine.enqueued.length, beforeInvalid);
    const missing = await client.callTool({ name: "issue_create", arguments: { ...payload("Missing service"), serviceKey: "missing" } });
    assert.equal(missing.isError, true); assert.equal(f.engine.enqueued.length, beforeInvalid);
    const db = openDatabase(f.databaseFile);
    try { await db.client.execute({ sql: "update issues set status='resolved', resolved_at=? where key=?", args: [Date.now(), issue.id] }); } finally { await db.close(); }
    const closed = await client.callTool({ name: "issue_message", arguments: { key: issue.id, message: "should be refused" } });
    assert.equal(closed.isError, true);
    assert.ok(JSON.stringify(closed).includes("resolved_issue_cannot_run_agent"));
    assert.equal(f.engine.enqueued.length, beforeInvalid);
  } finally { await client.close(); await f.cleanup(); }
});

test("MCP keeps strict input schemas even when another consumer enables corrective TypeBox parsing", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "strict-schema-fixture", version: "1" });
  const settings = { ...Settings.Get() };
  try {
    await createService(f.app, "MCP Create", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp")) as Parameters<Client["connect"]>[0]);
    const created = await client.callTool({ name: "issue_create", arguments: payload("Strict input fixture") });
    assert.ok(!created.isError, JSON.stringify(created));
    const issue = parsed(created);
    const queued = f.engine.enqueued.length;
    const messages = f.engine.messages.length;
    Settings.Set({ correctiveParse: true });
    const invalid = [
      { name: "issue_create", arguments: { ...payload("Wrong title type"), title: 7 } },
      { name: "issue_create", arguments: { ...payload("Unknown start flag"), startAgent: false } },
      { name: "issue_message", arguments: { key: issue.id, message: 7 } },
      { name: "issue_conversation", arguments: { key: issue.id, limit: "1" } },
    ];
    for (const input of invalid) {
      const result = await client.callTool(input);
      assert.equal(result.isError, true, JSON.stringify({ input, result }));
    }
    assert.equal(f.engine.enqueued.length, queued);
    assert.equal(f.engine.messages.length, messages);
  } finally {
    Settings.Set(settings);
    await client.close();
    await f.cleanup();
  }
});

test("MCP creation preserves role restrictions on development and production-data work modes", async () => {
  const f = await createApiFixture(); const client = new Client({ name: "product-creation", version: "1" });
  try {
    await createService(f.app, "MCP Create", ["test", "prod", "dev"]);
    const user = await f.app.inject({ method: "POST", url: "/api/users", headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject }, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });assert.equal(user.statusCode, 201);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp"), { requestInit: { headers: { "x-issue-pilot-subject": "product" } } }) as Parameters<Client["connect"]>[0]);
    for (const mode of ["development_fix", "development_feature"]) {
      const result = await client.callTool({ name: "issue_create", arguments: payload("Forbidden", mode) });
      assert.equal(result.isError, true);assert.equal(f.engine.enqueued.length, 0);
    }
    const result = await client.callTool({ name: "issue_create", arguments: payload("Investigation", "production_analysis") });
    assert.ok(!result.isError);assert.equal(f.engine.enqueued.length, 1);
  } finally { await client.close(); await f.cleanup(); }
});
