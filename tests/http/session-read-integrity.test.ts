import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

for (const channel of ["MCP", "SSE"] as const)
  for (const damage of ["empty", "blank", "truncated", "malformed"] as const)
    test(`${channel} refuses a ${damage} session without rewriting it and accepts a repaired transcript`, { timeout: 10_000 }, async () => {
      const f = await createApiFixture();
      const database = openDatabase(f.databaseFile);
      const client = new Client({ name: "session-integrity-fixture", version: "1" });
      try {
        await createService(f.app, "Session integrity");
        const created = await createIssue(f.app, "session-integrity");
        f.engine.running.clear();
        const [issue] = await database.db
          .select()
          .from(issues)
          .where(eq(issues.key, String(created.id)));
        assert.ok(issue);
        const root = issueRoot(f.root, issue.key);
        const manager = await createPrivateSessionManager(root, root);
        manager.appendCustomEntry("issue-pilot-user", { message: "Preserve the recorded evidence" });
        const sessionFile = manager.getSessionFile()!;
        await database.db.insert(agentSessions).values({ issueId: issue.id, sessionFile, workspacePath: root });
        const original = await readFile(sessionFile, "utf8");
        const damaged = damage === "empty" ? "" : damage === "blank" ? " \t\n\n" : damage === "truncated" ? original.slice(0, -1) : original + "invalid JSON record\n";
        await writeFile(sessionFile, damaged);
        const files = await readdir(root);
        const bindings = await database.db.select().from(agentSessions);
        const enqueued = f.engine.enqueued.length;
        const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
        if (channel === "MCP") await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp")));
        const read = async () => {
          if (channel === "MCP") {
            const result = await client.callTool({ name: "issue_conversation", arguments: { key: issue.key } });
            return { failed: result.isError === true, text: JSON.stringify(result.content) };
          }
          const response = await fetch(`${address}/api/issues/${issue.key}/agent-stream`, { signal: AbortSignal.timeout(5_000) });
          if (response.status !== 200) return { failed: response.status === 500, text: await response.text() };
          const reader = response.body!.getReader();
          let text = "";
          try {
            while (!text.includes("event: snapshot_ready")) {
              const chunk = await reader.read();
              if (chunk.done) break;
              text += new TextDecoder().decode(chunk.value);
            }
          } finally {
            await reader.cancel();
          }
          return { failed: false, text };
        };
        const rejected = await read();
        assert.equal(await readFile(sessionFile, "utf8"), damaged, "a read must preserve the damaged evidence");
        assert.equal(rejected.failed, true, rejected.text);
        assert.match(rejected.text, /agent_session_file_incomplete/);
        assert.deepEqual(await database.db.select().from(agentSessions), bindings);
        assert.deepEqual(await readdir(root), files);
        await writeFile(sessionFile, original);
        const repaired = await read();
        assert.equal(repaired.failed, false, repaired.text);
        assert.match(repaired.text, /Preserve the recorded evidence/);
        assert.equal(await readFile(sessionFile, "utf8"), original);
        assert.equal(f.engine.enqueued.length, enqueued);
      } finally {
        await client.close();
        database.close();
        await f.cleanup();
      }
    });
