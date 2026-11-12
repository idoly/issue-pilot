import { agentMessageReceipt, pendingAgentMessages } from "../../src/agent/message-delivery.ts";
import { buildApi } from "../../src/http/api.ts";
import { resetIssueSession } from "../../src/agent/session-reset.ts";
import { modelCatalog } from "../http/fixture.ts";
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
import { assertSessionFileComplete, createPrivateSessionManager, type ManagedPiSession, type PiSessionRuntime, type StartPiSessionOptions } from "../../src/agent/pi-session.ts";
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
    const [issue] = await database.db
      .insert(issues)
      .values({ key: "ISSUE-20261023-921", title: "Admission", type: "smart_analysis", serviceId: service.id, environmentId: environment.id, reporterSubject: "admit-owner" })
      .returning();
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
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr!.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    const accepted = once(child, "message").then(([message]) => {
      assert.deepEqual(message, { type: "accepted" });
    });
    await Promise.race([
      accepted,
      exited.then(() => {
        throw new Error(`admission_child_exited:${diagnostics}`);
      }),
    ]);
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
      assert.deepEqual(
        sessionTranscript(manager, issue.id).map((item) => item.event),
        [{ type: "issue_user", message: "Keep this accepted input after a crash", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }],
      );
      assert.equal(manager.buildSessionContext().messages.length, 0);
      assert.equal(engine.isRunning(issue.id), false, "reopening does not replay model work");
    } finally {
      await engine.close();
      await reopened.close();
    }
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
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched: Array<{ message: string | undefined }> = [];
  (engine as unknown as { run(issueId: string, message?: string): Promise<void> }).run = async (_issueId, message) => {
    dispatched.push({ message });
    await gate;
  };
  try {
    await Promise.all([engine.send(issue.id, "first"), engine.send(issue.id, "second")]);
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    assert.ok(binding);
    const manager = SessionManager.open(binding.sessionFile);
    assert.equal(manager.getEntries().length, 2);
    assert.equal(manager.getBranch().length, 2);
    assert.deepEqual(
      sessionTranscript(manager, issue.id).map((item) => item.event),
      [
        { type: "issue_user", message: "first" },
        { type: "issue_user", message: "second" },
      ],
    );
    assert.equal((await readdir(path.dirname(binding.sessionFile))).filter((name) => name.startsWith(".session-")).length, 1);
    release();
    await engine.close();
    assert.deepEqual(dispatched, [{ message: "first" }, { message: "second" }]);
  } finally {
    release();
    await engine.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps admissions and executed rounds on the same branch during session startup", async (t) => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  const internal = engine as unknown as { projectManager: IssueProjectManager; piRuntime: PiSessionRuntime };
  let started!: () => void;
  let release!: () => void;
  const starting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompts: string[] = [];
  try {
    await database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, "admit-owner"));
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "fixture", model: "fixture", thinkingLevel: "off", codemode: "off", runtime: {}, apiKey: "fixture-key" });
    const work = issueRoot(root, issue.key);
    const project: PreparedIssueProject = { runtimeRoot: work, repositories: [], relatedIssueKeys: [], readRoots: [], runtimeReady: true };
    t.mock.method(internal.projectManager, "prepare", async () => project);
    t.mock.method(internal.piRuntime, "start", async (options: StartPiSessionOptions) => {
      options.manager.appendCustomEntry("fixture-start", {});
      started();
      await gate;
      return {
        // Engine only consumes the public manager surface from the SDK session here.
        session: { sessionManager: options.manager } as AgentSession,
        streaming: false,
        setGitIdentity() {},
        async stop() {},
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
    assert.deepEqual(
      sessionTranscript(manager, issue.id).map((item) => item.event),
      [
        { type: "issue_user", message: "first" },
        { type: "issue_user", message: "second" },
      ],
    );
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
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
    assert.equal((await readdir(path.dirname(binding.sessionFile))).filter((name) => name.startsWith(".session-")).length, 0);
    release();
    await engine.close();
    assert.deepEqual(dispatched, ["first"]);
  } finally {
    release();
    await engine.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a partial journal write before admission and preserves the incomplete file on retry", async (t) => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
    await assert.rejects(engine.send(issue.id, "not accepted"), (error) => error === failure);
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

for (const damage of ["interior", "header"] as const)
  test(`refuses a session file with a damaged ${damage} line instead of dropping records or rebinding`, async () => {
    const { root, database, issue } = await fixture();
    const engine = new AgentEngine(database.db, root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (engine as unknown as { run(issueId: string, message?: string): Promise<void> }).run = async () => {
      await gate;
    };
    try {
      await engine.send(issue.id, "first");
      const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
      assert.ok(binding);
      const original = await readFile(binding.sessionFile, "utf8");
      // A partial append merges with the next record into one malformed line that still ends with a newline;
      // the header case rewrites line 1. Both were accepted by the former last-byte check.
      const damaged =
        damage === "interior"
          ? `${original}{"type":"custom","partial\n{"type":"custom","customType":"issue-pilot-user","data":{"message":"merged"}}\n`
          : `not a session header\n${original.split("\n").slice(1).join("\n")}`;
      await fs.promises.writeFile(binding.sessionFile, damaged);
      const before = await readFile(binding.sessionFile);
      await assert.rejects(engine.send(issue.id, "must not drop history"), { message: "agent_session_file_incomplete" });
      const [unchanged] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
      assert.deepEqual(unchanged, binding);
      assert.deepEqual(await readFile(binding.sessionFile), before);
      assert.equal((await readdir(path.dirname(binding.sessionFile))).filter((name) => name.endsWith(".jsonl")).length, 1);
    } finally {
      release();
      await engine.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("accepts a session file with a leading UTF-8 byte order mark like Pi does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-session-bom-"));
  try {
    const file = path.join(root, ".session-bom.jsonl");
    await fs.promises.writeFile(file, `﻿${JSON.stringify({ type: "session", version: 3, id: "bom", timestamp: new Date().toISOString(), cwd: root })}\n`);
    await assertSessionFileComplete(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a cached session replaced with whitespace and accepts its restored contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-session-blank-"));
  try {
    const file = path.join(root, ".session-blank.jsonl");
    const original = `${JSON.stringify({ type: "session", version: 3, id: "blank", timestamp: new Date().toISOString(), cwd: root })}\n`;
    await fs.promises.writeFile(file, original);
    await assertSessionFileComplete(file);
    await fs.promises.writeFile(file, " \t\n".repeat(original.length));
    await assert.rejects(assertSessionFileComplete(file), { message: "agent_session_file_incomplete" });
    await fs.promises.writeFile(file, original);
    await assertSessionFileComplete(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeatedly refuses a rewritten session and accepts restoration followed by normal appends", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-session-rewrite-"));
  try {
    const file = path.join(root, ".session-rewrite.jsonl");
    const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root });
    const record = (id: string) => JSON.stringify({ type: "message", id, role: "user", content: "x", timestamp: new Date().toISOString() });
    const original = `${header("first")}\n${record("m1")}\n`;
    await fs.promises.writeFile(file, original);
    await assertSessionFileComplete(file);
    // Same inode, larger file, valid JSONL, but no longer the validated session: the append-only cache must not trust it.
    const rewritten = `${header("second")}\n${record("m1")}\n${record("m2")}\n`;
    await fs.promises.writeFile(file, rewritten);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(assertSessionFileComplete(file), { message: "agent_session_file_incomplete" });
      assert.equal(await readFile(file, "utf8"), rewritten);
    }
    await fs.promises.writeFile(file, original);
    await assertSessionFileComplete(file);
    await fs.promises.appendFile(file, `${record("m2")}\n`);
    await assertSessionFileComplete(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses an appended session whose validated prefix was rewritten in place", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-session-prefix-"));
  try {
    const file = path.join(root, ".session-prefix.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "prefix", timestamp: new Date().toISOString(), cwd: root });
    const record = JSON.stringify({ type: "custom", id: "second", value: 1 });
    await fs.promises.writeFile(file, `${header}\n${record}\n`);
    await assertSessionFileComplete(file);
    // Same inode and header, one byte changed inside the validated prefix, then a valid append.
    const corrupted = record.replace(":", " ");
    await fs.promises.writeFile(file, `${header}\n${corrupted}\n${JSON.stringify({ type: "custom", id: "third" })}\n`);
    await assert.rejects(assertSessionFileComplete(file), { message: "agent_session_file_incomplete" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const cached of [false, true])
  test(`missing durable Issue roots reject admission without changing bindings (cached: ${cached})`, async () => {
    const { root, database, issue } = await fixture();
    const engine = new AgentEngine(database.db, root);
    const internal = engine as unknown as { run(): Promise<void>; sessions: Map<string, unknown> };
    internal.run = async () => {};
    const directory = issueRoot(root, issue.key),
      preserved = path.join(root, "preserved-issue");
    let steered = false;
    try {
      await engine.send(issue.id, "accepted before loss");
      const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
      assert.ok(binding);
      const original = await readFile(binding.sessionFile);
      if (cached)
        internal.sessions.set(issue.id, {
          streaming: true,
          session: {
            sessionManager: SessionManager.open(binding.sessionFile),
            getSteeringMessages: () => [],
            steer: async () => {
              steered = true;
            },
          },
        });
      await rename(directory, preserved);
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(engine.send(issue.id, "must not recreate durable state"), { message: "issue_root_missing" });
        await assert.rejects(stat(directory), { code: "ENOENT" });
      }
      assert.equal(steered, false);
      assert.deepEqual((await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)))[0], binding);
      assert.deepEqual(await readFile(path.join(preserved, path.basename(binding.sessionFile))), original);
      internal.sessions.clear();
      await rename(preserved, directory);
      await engine.send(issue.id, "accepted after exact root restored");
      assert.equal(sessionTranscript(SessionManager.open(binding.sessionFile), issue.id).length, 2);
    } finally {
      internal.sessions.clear();
      await engine.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("durable request receipts deduplicate concurrent sends and survive process reopening without replay", async () => {
  const { root, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  const request = { id: "fixture-request", subject: "admit-owner" };
  const dispatched: string[] = [];
  (engine as unknown as { run(issueId: string, message: string): Promise<void> }).run = async (_issueId, message) => {
    dispatched.push(message);
  };
  try {
    await Promise.all([engine.send(issue.id, "exactly one admission", undefined, [], undefined, request), engine.send(issue.id, "exactly one admission", undefined, [], undefined, request)]);
    await engine.close();
    assert.deepEqual(dispatched, ["exactly one admission"]);
    const reopened = new AgentEngine(database.db, root);
    try {
      await reopened.send(issue.id, "exactly one admission", undefined, [], undefined, request);
      assert.equal(reopened.isRunning(issue.id), false);
      let authorizationChecks = 0;
      await assert.rejects(
        reopened.send(
          issue.id,
          "exactly one admission",
          undefined,
          [],
          async () => {
            if (++authorizationChecks === 2) throw new Error("identity_disabled_during_receipt_read");
          },
          request,
        ),
        /identity_disabled_during_receipt_read/,
      );

      assert.deepEqual(await reopened.messageReceipt(issue, request, async () => {}), { state: "queued" });
      assert.deepEqual(await reopened.messageReceipt(issue, { ...request, subject: "another-user" }, async () => {}), { state: "unknown" });
      await assert.rejects(reopened.send(issue.id, "different payload", undefined, [], undefined, request), /agent_message_id_conflict/);
      await assert.rejects(
        reopened.messageReceipt(issue, request, async () => {
          throw new Error("identity_disabled");
        }),
        /identity_disabled/,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await engine.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt reads protect session state without announcing an Agent run", async () => {
  const { root, database, issue } = await fixture();
  const runStates: string[] = [];
  const engine = new AgentEngine(database.db, root, ({ event }) => {
    if (event.type === "issue_run_state") runStates.push(event.state);
  });
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receipt = engine.messageReceipt(issue, { id: "missing", subject: "admit-owner" }, async () => {
    enter();
    await released;
  });
  try {
    await entered;
    assert.equal(engine.getRunState(issue.id), "idle");
    await assert.rejects(
      engine.runExclusive([issue.id], async () => assert.fail("session mutation overlapped receipt lookup")),
      /issue_already_running/,
    );
    let closed = false;
    const closing = engine.close().then(() => {
      closed = true;
    });
    // Give close time to finish if it forgot to wait for the admission queue.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    assert.deepEqual(await receipt, { state: "unknown" });
    await closing;
    assert.deepEqual(runStates, []);
  } finally {
    release();
    await Promise.allSettled([receipt, engine.close()]);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP receipts preserve sender identity and admission across session reset and resolution", async () => {
  const { root, file, database, issue } = await fixture();
  const engine = new AgentEngine(database.db, root);
  let dispatches = 0;
  (engine as unknown as { run(): Promise<void> }).run = async () => {
    dispatches++;
  };
  const app = await buildApi({ stateRoot: root, databaseFile: file, engine, modelCatalog, logger: false });
  const url = `/api/issues/${issue.key}/agent-messages`;
  const headers = { "x-issue-pilot-subject": "admit-owner", "x-issue-pilot-message-id": "request-1" };
  try {
    await database.db.insert(subjects).values({ subject: "other-sender", role: "product" });
    assert.equal((await app.inject({ method: "POST", url, headers: { ...headers, "x-issue-pilot-message-id": "bad id" }, payload: { message: "input" } })).statusCode, 400);
    for (let attempt = 0; attempt < 2; attempt++) {
      const accepted = await app.inject({ method: "POST", url, headers, payload: { message: "input" } });
      assert.equal(accepted.statusCode, 202, accepted.body);
    }
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { message: "changed" } })).statusCode, 409);
    const receipt = await app.inject({ method: "GET", url: url + "/request-1", headers });
    assert.deepEqual(receipt.json(), { state: "queued" });
    assert.deepEqual((await app.inject({ method: "GET", url: url + "/request-1", headers: { "x-issue-pilot-subject": "other-sender" } })).json(), { state: "unknown" });
    await (engine as unknown as { waitForIdle(): Promise<void> }).waitForIdle();
    const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id));
    const manager = SessionManager.open(binding!.sessionFile);
    await engine.runExclusive([issue.id], async (reservation) => {
      await reservation.closeSession(issue.id);
      await resetIssueSession(database.db, root, issue, "admit-owner", manager.getSessionId());
    });
    assert.deepEqual((await app.inject({ method: "GET", url: url + "/request-1", headers })).json(), { state: "queued" });
    await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, issue.id));
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { message: "input" } })).statusCode, 202);
    assert.equal((await app.inject({ method: "POST", url, headers: { ...headers, "x-issue-pilot-message-id": "new-request" }, payload: { message: "new input" } })).statusCode, 409);
    assert.equal(dispatches, 1);
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, "admit-owner"));
    assert.equal((await app.inject({ method: "GET", url: url + "/request-1", headers })).statusCode, 400);
  } finally {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["accepted", "late", "uncertain"] as const)
  test(`streaming admission is durable before ${outcome} steering and never duplicates its input`, async () => {
    const { root, database, issue } = await fixture();
    const directory = issueRoot(root, issue.key);
    const manager = await createPrivateSessionManager(directory, directory);
    await database.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: manager.getSessionFile()!, workspacePath: directory });
    const engine = new AgentEngine(database.db, root);
    const request = { id: "steering-request", subject: "admit-owner" };
    let streaming = true,
      queued = 0,
      steers = 0,
      dispatches = 0;
    const internal = engine as unknown as {
      sessions: Map<string, ManagedPiSession>;
      promptExisting(): Promise<void>;
      waitForIdle(): Promise<void>;
    };
    internal.promptExisting = async () => {
      dispatches++;
    };
    internal.sessions.set(issue.id, {
      get streaming() {
        return streaming;
      },
      setGitIdentity() {},
      async stop() {},
      session: {
        sessionManager: manager,
        getSteeringMessages: () => Array.from({ length: queued }, () => "steer"),
        clearQueue: () => {
          queued = 0;
        },
        async steer() {
          steers++;
          const persisted = SessionManager.open(manager.getSessionFile()!);
          assert.equal(agentMessageReceipt(persisted, request)?.state, "started");
          assert.equal(sessionTranscript(persisted, issue.id).length, 1);
          if (outcome === "uncertain") throw new Error("remote_delivery_uncertain");
          if (outcome === "late") {
            streaming = false;
            queued = 1;
          }
        },
      },
    } as unknown as ManagedPiSession);
    try {
      const sent = engine.send(issue.id, "original steer", undefined, [], undefined, request);
      if (outcome === "uncertain") await assert.rejects(sent, /remote_delivery_uncertain/);
      else await sent;
      await internal.waitForIdle();
      await engine.send(issue.id, "original steer", undefined, [], undefined, request);
      const persisted = SessionManager.open(manager.getSessionFile()!);
      assert.equal(steers, 1);
      assert.equal(dispatches, outcome === "late" ? 1 : 0);
      assert.equal(sessionTranscript(persisted, issue.id).length, 1);
      assert.equal(pendingAgentMessages(persisted).length, outcome === "late" ? 1 : 0);
    } finally {
      await engine.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
