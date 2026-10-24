import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentEngine } from "../../src/agent/engine.ts";
import { appendQueuedAgentMessage, pendingAgentMessages } from "../../src/agent/message-delivery.ts";
import { createPrivateSessionManager, type PiSessionRuntime, type StartPiSessionOptions } from "../../src/agent/pi-session.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, globalAgentConfiguration, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import type { IssueProjectManager, PreparedIssueProject } from "../../src/workspace/project.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";

async function fixture(t: TestContext, blockFirst = false) {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-message-recovery-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "test"));
  const [service] = await database.db.insert(services).values({ key: "recover", name: "Recovery" }).returning();
  assert.ok(environment && service);
  await database.db.insert(subjects).values({ subject: "recovery-owner", role: "product" });
  const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: environment.id, config: {} }).returning();
  const [issue] = await database.db.insert(issues).values({ key: "ISSUE-20261023-931", title: "Recovery fixture", type: "smart_analysis", serviceId: service.id, environmentId: environment.id, reporterSubject: "recovery-owner" }).returning();
  assert.ok(deployment && issue);
  await database.db.insert(issueWorkspaces).values({ issueId: issue.id });
  await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "fixture", model: "fixture", thinkingLevel: "off", codemode: "off", runtime: {} });
  await claimIssueRoot(root, issue.key);
  const work = issueRoot(root, issue.key);
  const manager = await createPrivateSessionManager(work, work);
  await database.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: manager.getSessionFile()!, workspacePath: work });
  const engine = new AgentEngine(database.db, root);
  const internal = engine as unknown as { projectManager: IssueProjectManager; piRuntime: PiSessionRuntime };
  const project: PreparedIssueProject = { deployment, runtimeRoot: work, workspaceRoot: work, repositories: [], relatedIssueKeys: [], runtimeReady: true };
  t.mock.method(internal.projectManager, "prepare", async () => project);
  let started!: () => void;
  let release = () => {};
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const gate = blockFirst ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  const deliveries: Array<{ message: string; images: ImageContent[]; pendingBeforePrompt: string[] }> = [];
  t.mock.method(internal.piRuntime, "start", async (options: StartPiSessionOptions) => ({
    session: { sessionManager: options.manager } as AgentSession,
    streaming: false, setGitIdentity() {}, async stop() {},
    async prompt(message: string, images: ImageContent[] = []) {
      const persisted = SessionManager.open(options.manager.getSessionFile()!);
      deliveries.push({ message, images, pendingBeforePrompt: pendingAgentMessages(persisted).map(input => input.id) });
      if (deliveries.length === 1) { started(); await gate; }
      options.manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
    },
  }));
  return { root, database, issue, manager, engine, deliveries, firstStarted, release,
    async cleanup() { release(); await engine.close(); t.mock.restoreAll(); await database.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function idle(engine: AgentEngine, issueId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!engine.isRunning(issueId)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("recovery_round_not_idle");
}

test("explicit retry recovers unstarted text and images without recording another visible user message", async (t) => {
  const f = await fixture(t);
  try {
    const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
    appendQueuedAgentMessage(f.manager, f.issue, "Recover this unstarted input", images);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.deliveries.length, 0, "opening an Engine does not automatically resume work");
    f.engine.enqueue(f.issue.id);
    await f.engine.close();
    assert.equal(f.deliveries.length, 1);
    assert.match(f.deliveries[0]!.message, /Recover this unstarted input/);
    assert.deepEqual(f.deliveries[0]!.images, images);
    assert.deepEqual(f.deliveries[0]!.pendingBeforePrompt, [], "delivery must be recorded on disk before model dispatch");
    const manager = SessionManager.open(f.manager.getSessionFile()!);
    assert.deepEqual(pendingAgentMessages(manager), []);
    assert.equal(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "issue-pilot-user").length, 1);
  } finally { await f.cleanup(); }
});

for (const phase of ["queued", "started"] as const) test(`process death after the ${phase} checkpoint preserves conservative retry behavior`, { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const child = fork(fileURLToPath(new URL("../helpers/agent-delivery-process.ts", import.meta.url)), [f.manager.getSessionFile()!, f.issue.serviceId, f.issue.environmentId, phase], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr!.on("data", data => { diagnostics += data.toString(); });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child, "message").then(([message]) => { assert.deepEqual(message, { type: "checkpoint", phase }); }),
      exited.then(() => { throw new Error(`delivery_child_exited:${diagnostics}`); }),
    ]);
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    assert.equal(f.deliveries.length, 0);
    f.engine.enqueue(f.issue.id);
    await f.engine.close();
    assert.equal(f.deliveries.length, 1);
    if (phase === "queued") {
      assert.match(f.deliveries[0]!.message, /Crash-boundary input/);
      assert.deepEqual(f.deliveries[0]!.images, [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
    } else {
      assert.doesNotMatch(f.deliveries[0]!.message, /Crash-boundary input/);
      assert.deepEqual(f.deliveries[0]!.images, []);
    }
    assert.deepEqual(pendingAgentMessages(SessionManager.open(f.manager.getSessionFile()!)), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await exited; } finally { await f.cleanup(); }
  }
});

test("a preparation failure leaves the input pending for a later explicit retry", async (t) => {
  const f = await fixture(t);
  try {
    appendQueuedAgentMessage(f.manager, f.issue, "Retry after preparation fails", []);
    const internal = f.engine as unknown as { projectManager: IssueProjectManager };
    const failure = t.mock.method(internal.projectManager, "prepare", async () => { throw new Error("fixture_prepare_failed"); });
    f.engine.enqueue(f.issue.id);
    await idle(f.engine, f.issue.id);
    assert.equal(f.deliveries.length, 0);
    assert.equal(pendingAgentMessages(SessionManager.open(f.manager.getSessionFile()!)).length, 1);
    failure.mock.restore();
    f.engine.enqueue(f.issue.id);
    await f.engine.close();
    assert.equal(f.deliveries.length, 1);
    assert.match(f.deliveries[0]!.message, /Retry after preparation fails/);
  } finally { await f.cleanup(); }
});

test("recovers queued messages in order alongside a newly admitted message and drains them on close", async (t) => {
  const f = await fixture(t, true);
  try {
    appendQueuedAgentMessage(f.manager, f.issue, "First recovered input", []);
    appendQueuedAgentMessage(f.manager, f.issue, "Second recovered input", []);
    f.engine.enqueue(f.issue.id);
    await f.firstStarted;
    await f.engine.send(f.issue.id, "New admitted input");
    f.release();
    await f.engine.close();
    assert.equal(f.deliveries.length, 3);
    for (const [index, expected] of ["First recovered input", "Second recovered input", "New admitted input"].entries()) assert.ok(f.deliveries[index]!.message.includes(expected));
    const manager = SessionManager.open(f.manager.getSessionFile()!);
    assert.equal(manager.getBranch().length, manager.getEntries().length);
    assert.deepEqual(pendingAgentMessages(manager), []);
  } finally { await f.cleanup(); }
});

test("scope changes reject stale queued intent before model work and leave new scope input usable", async (t) => {
  const f = await fixture(t);
  try {
    appendQueuedAgentMessage(f.manager, { serviceId: "previous-service", environmentId: f.issue.environmentId }, "Old scope request", []);
    f.engine.enqueue(f.issue.id);
    await idle(f.engine, f.issue.id);
    assert.equal(f.deliveries.length, 0);
    const [workspace] = await f.database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, f.issue.id));
    assert.equal(workspace?.lastError, "agent_message_scope_changed");
    await f.engine.send(f.issue.id, "New scope request");
    await f.engine.close();
    assert.equal(f.deliveries.length, 1);
    assert.match(f.deliveries[0]!.message, /New scope request/);
    assert.doesNotMatch(f.deliveries[0]!.message, /Old scope request/);
  } finally { await f.cleanup(); }
});
