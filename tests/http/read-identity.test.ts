import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { subjects } from "../../src/db/schema.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { ApiError } from "../../src/http/input.ts";
import type { ApiRouteContext } from "../../src/http/route-context.ts";
import { registerWorkspaceRoutes } from "../../src/http/workspace-routes.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import { createApiFixture, createIssue, createService, workspaceStatistics } from "./fixture.ts";

const bootstrap = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("file, attachment, source and statistics-refresh reads reject unknown and inactive subjects", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Read identity");
    const issue = await createIssue(f.app, "read-identity");
    const disabled = "disabled-reader@example.test";
    await database.db.insert(subjects).values({ subject: disabled, active: false, role: "developer" });
    const base = `/api/issues/${issue.id}`;
    const reads = [
      `${base}/files`,
      `${base}/files/download?path=notes.txt`,
      `${base}/attachments/00000000-0000-0000-0000-000000000000`,
      ...["repositories", "tree", "file", "search", "history"].map((resource) => `${base}/source/${resource}`),
      "/api/workspaces/stats?refresh=true",
    ];
    for (const subject of ["unknown@example.test", disabled])
      for (const url of reads) {
        const response = await f.app.inject({ method: "GET", url, headers: { "x-issue-pilot-subject": subject } });
        assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
        assert.equal(response.json().error, "invalid_current_subject", url);
      }
  } finally {
    database.close();
    await f.cleanup();
  }
});

test("work-file reads reauthorize after the scope queue wait", { timeout: 10_000 }, async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const app = Fastify();
  try {
    await createService(f.app, "File wait");
    const issue = await createIssue(f.app, "file-wait");
    const reader = "waiting-reader@example.test";
    await database.db.insert(subjects).values({ subject: reader, active: true, role: "product" });
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    registerWorkspaceRoutes({
      app,
      database,
      stateRoot: f.root,
      sourceBrowser: new SourceBrowser(database.db, f.root),
      runScopeExclusive: async (operation: () => Promise<unknown>) => {
        enter();
        await gate;
        return operation();
      },
    } as unknown as ApiRouteContext);
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ApiError || error instanceof DomainError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }),
    );
    const pending = app.inject({ method: "GET", url: `/api/issues/${issue.id}/files`, headers: { "x-issue-pilot-subject": reader } });
    await entered;
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, reader));
    release();
    const response = await pending;
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "invalid_current_subject");
  } finally {
    await app.close();
    database.close();
    await f.cleanup();
  }
});

test("Agent message identity is checked before the multipart body is read", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Message identity");
    const issue = await createIssue(f.app, "message-identity");
    const sent = f.engine.messages.length;
    // A malformed multipart body would be invalid_multipart if it were parsed first.
    const malformed = { "content-type": "multipart/form-data; boundary=identity-first" };
    const payload = '--identity-first\r\nContent-Disposition: form-data; name="message"\r\n\r\nunterminated';
    const refused = await f.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, headers: { ...malformed, "x-issue-pilot-subject": "unknown@example.test" }, payload });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, "invalid_current_subject");
    const parsed = await f.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, headers: { ...malformed, ...bootstrap }, payload });
    assert.equal(parsed.statusCode, 400, parsed.body);
    assert.notEqual(parsed.json().error, "invalid_current_subject");
    assert.equal(f.engine.messages.length, sent);
  } finally {
    await f.cleanup();
  }
});

test("explicit workspace statistics refreshes are spaced by the configured interval", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await createApiFixture();
  try {
    await workspaceStatistics(f.app, true);
    const early = await f.app.inject({ url: "/api/workspaces/stats?refresh=true", headers: bootstrap });
    assert.equal(early.statusCode, 429, early.body);
    assert.equal(early.json().error, "workspace_statistics_refresh_too_frequent");
    // Ordinary reads stay available while refresh is throttled.
    assert.equal((await f.app.inject({ url: "/api/workspaces/stats" })).statusCode, 200);
    context.mock.timers.tick(issuePilotConfig.http.workspaceStatisticsRefreshIntervalMs);
    assert.equal((await f.app.inject({ url: "/api/workspaces/stats?refresh=true", headers: bootstrap })).statusCode, 200);
  } finally {
    await f.cleanup();
  }
});

test("gateway mode rejects API, SSE and MCP requests without a subject header; selectable mode keeps implicit selection", async () => {
  const gateway = await createApiFixture({ identity: "gateway" });
  try {
    await createService(gateway.app, "Gateway identity");
    const issue = await createIssue(gateway.app, "gateway-identity");
    for (const [method, url] of [
      ["GET", "/api/me"],
      ["GET", "/api/issues?status=open"],
      ["GET", `/api/issues/${issue.id}`],
      ["GET", `/api/issues/${issue.id}/agent-stream`],
      ["POST", "/mcp"],
      ["POST", "/mcp?client=fixture"],
    ] as const) {
      const response = await gateway.app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
      assert.equal(response.statusCode, 401, `${method} ${url}: ${response.body}`);
      assert.equal(response.json().error, "current_subject_required");
      assert.equal(response.headers["cache-control"], "private, no-store", url);
    }
    assert.equal((await gateway.app.inject({ url: "/api/me", headers: { "x-issue-pilot-subject": "" } })).statusCode, 401);
    assert.equal((await gateway.app.inject({ url: "/api/me", headers: bootstrap })).statusCode, 200);
    assert.equal((await gateway.app.inject({ url: "/health" })).statusCode, 200);
  } finally {
    await gateway.cleanup();
  }
  const selectable = await createApiFixture({ identity: "selectable" });
  try {
    const me = await selectable.app.inject({ url: "/api/me" });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().subject, issuePilotConfig.bootstrapUser.subject);
  } finally {
    await selectable.cleanup();
  }
});

test("API and MCP responses with query strings are private and uncached", async () => {
  const f = await createApiFixture();
  try {
    const mcp = await f.app.inject({ method: "GET", url: "/mcp?probe=1" });
    assert.equal(mcp.statusCode, 405);
    assert.equal(mcp.headers["cache-control"], "private, no-store");
    assert.equal(mcp.headers.pragma, "no-cache");
    assert.equal((await f.app.inject({ url: "/api/issues?probe=1" })).headers["cache-control"], "private, no-store");
    assert.equal((await f.app.inject({ url: "/health" })).headers["cache-control"], undefined);
  } finally {
    await f.cleanup();
  }
});
