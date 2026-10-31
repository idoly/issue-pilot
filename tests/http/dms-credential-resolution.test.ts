import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createService } from "./fixture.ts";

test("resolves DMS scope with a saved server-side token without returning it to the browser", async () => {
  const fixture = await createApiFixture();
  const originalFetch = globalThis.fetch;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const token = "Bearer saved-dms-token";
  const seenHeaders: Array<string | null> = [];
  const send = (id: number, result: unknown) => stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`));
  try {
    await createService(fixture.app, "Saved DMS", ["prod"]);
    const configuration = JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/config" })).body);
    const service = configuration.services.find((row: { key: string }) => row.key === "saved-dms");
    const shared = await fixture.app.inject({ method: "PUT", url: "/api/config/shared-dms-credentials", payload: { mode: "replace", expectedRevision: 0, url: "https://dms.example.test/sse", authorization: token } });
    assert.equal(shared.statusCode, 200, shared.body);
    const saved = await fixture.app.inject({ method: "PATCH", url: "/api/services/saved-dms", payload: { name: service.name, description: service.description, repositories: service.repositories, deployments: service.deployments.map((deployment: { environmentKey: string; repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }> }) => ({ environmentKey: deployment.environmentKey, repositoryBranches: deployment.repositoryBranches.map(({ repositoryAlias, baseBranch }) => ({ repositoryAlias, baseBranch })), capabilities: ["dms"], dms: { databases: [{ instanceAlias: "ORDERS", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] } })) } });
    assert.equal(saved.statusCode, 200, saved.body);
    globalThis.fetch = async (_input, init) => {
      seenHeaders.push(new Headers(init?.headers).get("authorization"));
      if ((init?.method ?? "GET") === "GET") return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      const request = JSON.parse(String(init?.body));
      if (request.method === "initialize") send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
      if (request.method === "tools/list") send(request.id, { tools: ["listInstances", "getDatabase"].map((name) => ({ name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } })) });
      if (request.method === "tools/call") send(request.id, { content: [{ type: "text", text: JSON.stringify(request.params.name === "listInstances" ? { InstanceAlias: "ORDERS", InstanceId: 456, Host: "db.example.test", Port: 3306, InstanceType: "mysql", EnvType: "product" } : { DatabaseId: 123, InstanceId: 456, SchemaName: "orders" }) }] });
      return new Response(null, { status: 202 });
    };
    const response = await fixture.app.inject({ method: "POST", url: "/api/dms/scope/resolve", payload: { instanceAlias: "ORDERS", schemaName: "orders" } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).databaseId, "123");
    assert.ok(seenHeaders.length >= 4);
    assert.ok(seenHeaders.every((value) => value === token));
    assert.equal(response.body.includes("saved-dms-token"), false);
    const config = await fixture.app.inject({ method: "GET", url: "/api/config" });
    assert.equal(config.body.includes("saved-dms-token"), false);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/resource-connections" })).statusCode, 404);
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});
