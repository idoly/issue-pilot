import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";

import { AgentEventBus } from "../../src/agent/events.ts";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, subjects } from "../../src/db/schema.ts";
import { registerAgentRoutes } from "../../src/http/agent-routes.ts";
import { ApiError } from "../../src/http/input.ts";
import { SerialQueue } from "../../src/serial.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService, modelCatalog } from "./fixture.ts";

for (const channel of ["list", "history", "SSE"] as const)
  for (const explicit of [false, true])
    test(`${channel} reauthorizes the ${explicit ? "explicit" : "implicit"} reader after waiting`, { timeout: 10_000 }, async () => {
      const f = await createApiFixture();
      const database = openDatabase(f.databaseFile);
      const app = Fastify();
      const events = new AgentEventBus();
      const scope = new SerialQueue();
      let release!: () => void, enter!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let waiting = true;
      const wait = async () => {
        if (!waiting) return;
        enter();
        await gate;
      };
      registerAgentRoutes({
        app,
        database,
        engine: f.engine,
        events,
        stateRoot: f.root,
        runScopeExclusive: (operation) =>
          scope.run(async () => {
            await wait();
            return operation();
          }),
        modelCatalog: {
          async list() {
            await wait();
            return modelCatalog.list();
          },
        },
      });
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
      let response: Response | undefined;
      let pending: Promise<Response> | undefined;
      try {
        await createService(f.app, "Reader identity");
        const issue = await createIssue(f.app, "reader-identity");
        const issueId = f.engine.enqueued.at(-1)!;
        f.engine.running.clear();
        const root = issueRoot(f.root, String(issue.id));
        const manager = await createPrivateSessionManager(root, root);
        manager.appendCustomEntry("issue-pilot-user", { message: "Saved conversation" });
        const sessionFile = manager.getSessionFile()!;
        await database.db.insert(agentSessions).values({ issueId, sessionFile, workspacePath: root });
        const original = await readFile(sessionFile);
        // This reader owns no Issues. The bootstrap user remains active, so implicit fallback would leak data.
        const reader = "reader@example.test";
        await database.db.insert(subjects).values({ subject: reader, role: "product", createdAt: new Date(0) });
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const suffix = channel === "list" ? "sessions" : channel === "history" ? `sessions/${manager.getSessionId()}` : "agent-stream";
        const url = `${address}/api/issues/${issue.id}/${suffix}`;
        const headers: Record<string, string> = explicit ? { "x-issue-pilot-subject": reader } : {};
        pending = fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
        await entered;
        await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, reader));
        waiting = false;
        release();
        response = await pending;
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: "invalid_current_subject" });
        assert.deepEqual(await readFile(sessionFile), original);
        assert.equal(f.engine.enqueued.length, 1);

        await database.db.update(subjects).set({ active: true }).where(eq(subjects.subject, reader));
        response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200);
        if (channel === "SSE") {
          let replay = "";
          for await (const chunk of response.body!) {
            replay += new TextDecoder().decode(chunk);
            if (replay.includes("event: snapshot_ready")) break;
          }
          assert.match(replay, /Saved conversation/);
          assert.match(replay, /event: snapshot_ready/);
        } else if (channel === "list") assert.equal((await response.json())[0].sessionId, manager.getSessionId());
        else assert.match(await response.text(), /Saved conversation/);
      } finally {
        waiting = false;
        release();
        await response?.body?.cancel().catch(() => undefined);
        await pending?.then(
          (value) => value.body?.cancel().catch(() => undefined),
          () => undefined,
        );
        await app.close();
        database.close();
        await f.cleanup();
      }
    });
