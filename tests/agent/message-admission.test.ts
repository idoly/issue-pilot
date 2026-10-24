import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { AgentEngine } from "../../src/agent/engine.ts";
import type { PiSessionRuntime, StartPiSessionOptions } from "../../src/agent/pi-session.ts";
import type { IssueProjectManager, PreparedIssueProject } from "../../src/workspace/project.ts";
import { sessionTranscript } from "../../src/agent/events.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, globalAgentConfiguration, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../../src/db/schema.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-admission-"));
  const file = path.join(root, "issues.db");
  const database = await openApplicationDatabase(file);
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "test"));
    const [service] = await database.db.insert(services).values({ key: "admit", name: "Admission" }).returning();
    assert.ok(environment && service);
    await database.db.insert(subjects).values({ subject: "admit-owner", role: "developer" });
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: environment.id, config: {} }).returning();
    assert.ok(deployment);
    const [issue] = await database.db.insert(issues).values({ key: "ISSUE-20261023-921", title: "Admission", type: "smart_analysis", serviceId: service.id, environmentId: environment.id, reporterSubject: "admit-owner" }).returning();
    assert.ok(issue);
    await database.db.insert(issueWorkspaces).values({ issueId: issue.id });
    await claimIssueRoot(root, issue.key);
    return { root, file, database, issue, deployment };
  } catch (error) {
    await database.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("preserves accepted text and images after a process dies before the round starts", { timeout: 15_000 }, async () => {
  const { root, file, database, issue } = await fixture();
  await database.close();
  const child = fork(fileURLToPath(new URL("../helpers/agent-admission-process.ts", import.meta.url)), [root, issue.id], {
    execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr!.on("data", chunk => { diagnostics += chunk.toString(); });
  const exited = once(child, "exit");
  try {
    const accepted = once(child, "message").then(([message]) => {
      assert.deepEqual(message, { type: "accepted" });
    });
    await Promise.race([accepted, exited.then(() => { throw new Error(`admission_child_exited:${diagnostics}`); })]);
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    const reopened = await openApplicationDatabase(file);
    const engine = new AgentEngine(reopened.db, root);
    try {
      const [binding] = await reopened.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
      assert.ok(binding, "acceptance must have a persisted session binding");
      assert.equal((await stat(binding.sessionFile)).mode & 0o777, 0o600);
      const manager = SessionManager.open(binding.sessionFile);
      assert.deepEqual(sessionTranscript(manager, issue.id).map(item => item.event), [{ type: "issue_user", message: "Keep this accepted input after a crash", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }]);
      assert.equal(manager.buildSessionContext().messages.length, 0);
      assert.equal(engine.isRunning(issue.id), false, "reopening does not replay model work");
    } finally { await engine.close(); await reopened.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("uses one session branch for concurrent admissions and dispatches each message once", async () => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched: Array<{ message: string | undefined; record: boolean | undefined }> = [];
  (engine as unknown as { run(issueId: string, message?: string, record?: boolean): Promise<void> }).run = async (_issueId, message, record) => {
    dispatched.push({ message, record });
    await gate;
  };
  try {
    await Promise.all([engine.send(issue.id, "first"), engine.send(issue.id, "second")]);
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.ok(binding);
    const manager = SessionManager.open(binding.sessionFile);
    assert.equal(manager.getEntries().length, 2);
    assert.equal(manager.getBranch().length, 2);
    assert.deepEqual(sessionTranscript(manager, issue.id).map(item => item.event), [{ type: "issue_user", message: "first" }, { type: "issue_user", message: "second" }]);
    assert.equal((await readdir(path.dirname(binding.sessionFile))).filter(name => name.startsWith(".session-")).length, 1);
    release();
    await engine.close();
    assert.deepEqual(dispatched, [{ message: "first", record: false }, { message: "second", record: false }]);
  } finally { release(); await engine.close(); await database.close(); await rm(root, { recursive: true, force: true }); }
});

test("keeps admissions and executed rounds on the same branch during session startup", async (t) => {
  const { root, database, issue, deployment } = await fixture();
  const engine = new AgentEngine(database.db, root);
  const internal = engine as unknown as { projectManager: IssueProjectManager; piRuntime: PiSessionRuntime };
  let started!: () => void;
  let release!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = [];
  try {
    await database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, "admit-owner"));
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "fixture", model: "fixture", thinkingLevel: "off", codemode: "off", runtime: {} });
    const work = issueRoot(root, issue.key);
    const project: PreparedIssueProject = { deployment, runtimeRoot: work, workspaceRoot: work, repositories: [], relatedIssueKeys: [], runtimeReady: true };
    t.mock.method(internal.projectManager, "prepare", async () => project);
    t.mock.method(internal.piRuntime, "start", async (options: StartPiSessionOptions) => {
      options.manager.appendCustomEntry("fixture-start", {});
      started();
      await gate;
      return {
        // Engine only consumes the public manager surface from the SDK session here.
        session: { sessionManager: options.manager } as AgentSession,
        streaming: false, setGitIdentity() {}, async stop() {},
        async prompt(message: string) {
          prompts.push(message);
          options.manager.appendMessage({ role: "user", content: message, timestamp: Date.now() });
        },
      };
    });
    await engine.send(issue.id, "first");
    await starting;
    const second = engine.send(issue.id, "second");
    release();
    await second;
    await engine.close();
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.ok(binding);
    const manager = SessionManager.open(binding.sessionFile);
    assert.equal(manager.getBranch().length, manager.getEntries().length);
    assert.deepEqual(sessionTranscript(manager, issue.id).map(item => item.event), [{ type: "issue_user", message: "first" }, { type: "issue_user", message: "second" }]);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /first/);
    assert.match(prompts[1]!, /second/);
  } finally {
    release();
    await engine.close();
    t.mock.restoreAll();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a missing journal binding instead of silently starting another conversation", async () => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched: Array<string | undefined> = [];
  (engine as unknown as { run(issueId: string, message?: string): Promise<void> }).run = async (_issueId, message) => {
    dispatched.push(message);
    await gate;
  };
  try {
    await engine.send(issue.id, "first");
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.ok(binding);
    const preserved = path.join(root, "preserved-session.jsonl");
    const original = await readFile(binding.sessionFile);
    await rename(binding.sessionFile, preserved);
    await assert.rejects(engine.send(issue.id, "must not replace history"), { message: "agent_session_file_missing" });
    const [unchanged] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.deepEqual(unchanged, binding);
    assert.deepEqual(await readFile(preserved), original);
    assert.equal((await readdir(path.dirname(binding.sessionFile))).filter(name => name.startsWith(".session-")).length, 0);
    release();
    await engine.close();
    assert.deepEqual(dispatched, ["first"]);
  } finally { release(); await engine.close(); await database.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects a partial journal write before admission and preserves the incomplete file on retry", async (t) => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched: Array<string | undefined> = [];
  (engine as unknown as { run(issueId: string, message?: string): Promise<void> }).run = async (_issueId, message) => {
    dispatched.push(message);
    await gate;
  };
  try {
    await engine.send(issue.id, "first");
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.ok(binding);
    const failure = Object.assign(new Error("fixture_disk_full"), { code: "ENOSPC" });
    const append = fs.appendFileSync;
    const failAppend: typeof fs.appendFileSync = (file, data, options) => {
      if (file !== binding.sessionFile) return append(file, data, options);
      append(file, typeof data === "string" ? data.slice(0, 12) : data.subarray(0, 12), options);
      throw failure;
    };
    t.mock.method(fs, "appendFileSync", failAppend);
    syncBuiltinESMExports();
    await assert.rejects(engine.send(issue.id, "not accepted"), error => error === failure);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const damaged = await readFile(binding.sessionFile);
    await assert.rejects(engine.send(issue.id, "retry"), { message: "agent_session_file_incomplete" });
    assert.deepEqual(await readFile(binding.sessionFile), damaged);
    release();
    await engine.close();
    assert.deepEqual(dispatched, ["first"]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    release();
    await engine.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
