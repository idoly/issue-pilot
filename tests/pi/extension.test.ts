import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerIssuePilotExtension } from "../../src/pi/extension.ts";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

test("registers only selected broker-backed capabilities", async () => {
  const tools = new Map<string, RegisteredTool>();
  const pi = {
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  registerIssuePilotExtension(pi, {
    issueId: "internal-issue-id",
    capabilities: ["db", "redis"],
    brokerUrl: "http://127.0.0.1:3000",
    brokerToken: "short-lived-token",
  });

  assert.deepEqual([...tools.keys()].sort(), ["db", "redis"]);
  const originalFetch = globalThis.fetch;
  let request: { url: string; authorization: string; body: unknown } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization") ?? "",
      body: JSON.parse(String(init?.body)),
    };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "query complete" }], details: { rows: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await tools.get("db")!.execute("call", { statement: "SELECT 1" });
    assert.equal(result.content[0]?.text, "query complete");
    assert.deepEqual(request, {
      url: "http://127.0.0.1:3000/internal/agent-capabilities/db",
      authorization: "Bearer short-lived-token",
      body: { issueId: "internal-issue-id", input: { statement: "SELECT 1" } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
