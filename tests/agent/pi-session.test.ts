import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { Model } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { sessionToolAllowlist, type AgentSessionContext } from "../../src/agent/context.ts";
import { AgentResponseWatchdog, createPrivateSessionManager, gitIdentityEnvironment, PiSessionRuntime } from "../../src/agent/pi-session.ts";
import { hostMcpPid } from "../helpers/mcp-process.ts";
import { IssueWorkFileStore } from "../../src/workspace/work-files.ts";
import type { PiModelRuntime } from "../../src/agent/model-runtime.ts";

test("creates a private Pi session file before the first Agent prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-session-"));
  try {
    const workspace = join(root, "workspace");
    const sessionDirectory = join(root, "sessions");
    await mkdir(workspace);
    await mkdir(sessionDirectory, { mode: 0o700 });

    const manager = await createPrivateSessionManager(workspace, sessionDirectory);
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);

    const [header] = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(header.type, "session");
    assert.equal(header.id, manager.getSessionId());

    manager.appendCustomEntry("issue-pilot-user", { message: "hello" });
    const reopened = SessionManager.open(sessionFile, sessionDirectory, workspace);
    assert.deepEqual(reopened.getEntries().map((entry) => entry.type), ["custom"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function localMcp(root: string) {
  return [{ id: "local", name: "Local", url: "", authorization: "", transport: "stdio" as const, enabled: true, stdio: { command: process.execPath, args: [fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url))], env: { MCP_FIXTURE_PID_FILE: join(root, "pid") } } }];
}

async function waitForMcp(managed: Awaited<ReturnType<PiSessionRuntime["start"]>>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const tools = managed.session.getAllTools().filter(tool => tool.name.startsWith("mcp__"));
    if (tools.length) return tools;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("mcp_tools_not_ready");
}

function context(options: { writable: boolean; capability?: "dms" }): AgentSessionContext {
  return {
    issueKey: "ISSUE-20260808-001",
    serviceKey: "orders",
    environmentKey: options.writable ? "dev" : "prod",
    model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
    capabilities: options.capability ? [options.capability] : [],
    codemode: "off",
    canModifyCode: options.writable,
  };
}

const model: Model<"openai-responses"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 8_000,
};

function modelRuntime(available = true, refreshes?: unknown[]): ModelRuntime {
  return {
    async refresh(options: unknown) {
      refreshes?.push(options);
      return { aborted: false, errors: new Map() };
    },
    getModel() { return model; },
    getAvailableSnapshot() { return available ? [model] : []; },
  } as unknown as ModelRuntime;
}

function sharedModelRuntime(runtime: ModelRuntime): PiModelRuntime {
  return { async load() { return runtime; }, async close() {} };
}

test("times out only while waiting for model output", async () => {
  let timeouts = 0;
  const watchdog = new AgentResponseWatchdog(20, () => { timeouts += 1; });
  watchdog.start();
  watchdog.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timeouts, 0);
  watchdog.observe({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [] }, isError: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(timeouts, 1);
  watchdog.stop();
  assert.throws(() => new AgentResponseWatchdog(0, () => undefined), /invalid_model_response_idle_timeout/);
});

test("maps the current user to Git author and committer environment", () => {
  assert.deepEqual(gitIdentityEnvironment({ name: " 严欣 ", email: " yx4821@example.test " }), {
    GIT_AUTHOR_NAME: "严欣",
    GIT_AUTHOR_EMAIL: "yx4821@example.test",
    GIT_COMMITTER_NAME: "严欣",
    GIT_COMMITTER_EMAIL: "yx4821@example.test",
  });
  assert.deepEqual(gitIdentityEnvironment(), {});
  assert.throws(() => gitIdentityEnvironment({ name: "", email: "user@example.test" }), /invalid_git_commit_identity/);
});

test("uses native coding tools independently of repository access policy", () => {
  assert.deepEqual(sessionToolAllowlist(context({ writable: false, capability: "dms" })), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
});

test("does not expose a publication tool in any Issue context", () => {
  assert.deepEqual(sessionToolAllowlist(context({ writable: true })), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(sessionToolAllowlist(context({ writable: false })), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("starts an SDK session with only context-selected tools and explicit resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const workspaceRoot = join(root, "workspace");
  const sessionDirectory = join(root, "sessions");
  await Promise.all([mkdir(workspaceRoot), mkdir(sessionDirectory)]);
  const manager = await createPrivateSessionManager(workspaceRoot, sessionDirectory);
  const refreshes: unknown[] = [];
  const runtime = new PiSessionRuntime(sharedModelRuntime(modelRuntime(true, refreshes)));
  try {
    const managed = await runtime.start({
      manager,
      context: context({ writable: false }),
      deploymentConfig: {},
      workspaceRoot,
      systemPrompt: "Issue Pilot test context.",
      onEvent: () => undefined,
    });
    assert.deepEqual(refreshes, [{ providers: ["test-provider"], allowNetwork: false }]);
    assert.deepEqual(managed.session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    assert.equal(managed.session.model?.id, "test-model");
    assert.equal(managed.session.thinkingLevel, "medium");
    assert.match(managed.session.systemPrompt, /Issue Pilot test context/);
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an export writer does not register a separate publication tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-output-"));
  const sessionDirectory = join(root, "sessions");
  await mkdir(sessionDirectory);
  const manager = await createPrivateSessionManager(root, sessionDirectory);
  const runtime = new PiSessionRuntime(sharedModelRuntime(modelRuntime()));
  try {
    const managed = await runtime.start({
      manager,
      context: context({ writable: false }),
      deploymentConfig: {},
      workspaceRoot: root,
      workFiles: new IssueWorkFileStore(root, "ISSUE-20260929-001"),
      systemPrompt: "",
      onEvent: () => undefined,
    });
    assert.deepEqual(managed.session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const cleanupFails of [false, true]) test(`disposes an SDK session and stdio process when stop fails (cleanup=${cleanupFails})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const manager = await createPrivateSessionManager(root, root);
  const managed = await new PiSessionRuntime(sharedModelRuntime(modelRuntime())).start({
    manager,
    context: context({ writable: false }),
    deploymentConfig: {},
    workspaceRoot: root,
    agentDirectory: root,
    mcpConfigurations: localMcp(root),
    systemPrompt: "",
    onEvent: () => undefined,
  });
  await waitForMcp(managed);
  await readFile(join(root, "pid"), "utf8");
  const child = await hostMcpPid(join(root, "pid"));
  let disposed = false;
  const session = managed.session as AgentSession & { abort: () => Promise<void>; dispose: () => void };
  const dispose = session.dispose.bind(session);
  const abortError = new Error("abort_failed");
  const shutdownError = new Error("shutdown_failed");
  const disposeError = new Error("dispose_failed");
  Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
  session.abort = async () => { throw abortError; };
  if (cleanupFails) {
    const emit = session.extensionRunner.emit.bind(session.extensionRunner);
    session.extensionRunner.emit = async event => {
      const result = await emit(event);
      if (event.type === "session_shutdown") throw shutdownError;
      return result;
    };
  }
  session.dispose = () => { disposed = true; dispose(); if (cleanupFails) throw disposeError; };
  try {
    await assert.rejects(managed.stop(), error => {
      if (cleanupFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "pi_session_stop_failed");
        assert.deepEqual(error.errors, [abortError, shutdownError, disposeError]);
      } else assert.equal(error, abortError);
      return true;
    });
    assert.equal(disposed, true);
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves startup and disposal failures while releasing the SDK session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-start-cleanup-"));
  const startupError = new Error("fixture_bind_failed");
  const disposalError = new Error("fixture_disposal_failed");
  let disposed = false;
  t.mock.method(AgentSession.prototype, "bindExtensions", async function (this: AgentSession) {
    const dispose = this.dispose.bind(this);
    this.dispose = () => { dispose(); disposed = true; throw disposalError; };
    throw startupError;
  });
  try {
    await assert.rejects(new PiSessionRuntime(sharedModelRuntime(modelRuntime())).start({
      manager: await createPrivateSessionManager(root, root),
      context: context({ writable: false }),
      deploymentConfig: {}, workspaceRoot: root, agentDirectory: root,
      systemPrompt: "", onEvent: () => undefined,
    }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "pi_session_start_cleanup_failed");
      assert.deepEqual(error.errors, [startupError, disposalError]);
      return true;
    });
    assert.equal(disposed, true);
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

for (const environment of ["prod", "test", "dev"] as const) test(`exposes non-read-only MCP tools in ${environment} sessions`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-mcp-tools-"));
  let managed: Awaited<ReturnType<PiSessionRuntime["start"]>> | undefined;
  try {
    managed = await new PiSessionRuntime(sharedModelRuntime(modelRuntime())).start({
      manager: await createPrivateSessionManager(root, root),
      context: { ...context({ writable: environment === "dev" }), environmentKey: environment },
      deploymentConfig: {}, workspaceRoot: root,
      mcpConfigurations: localMcp(root),
      systemPrompt: "", onEvent: () => undefined,
    });
    const tools = await waitForMcp(managed);
    assert.ok(tools.some(tool => tool.name === "mcp__local__write"));
    assert.ok(managed.session.getActiveToolNames().includes("mcp__local__write"));
    assert.equal(managed.session.getActiveToolNames().includes("service_query"), false);
  } finally { await managed?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("does not start stdio processes when Agent identity validation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-mcp-start-"));
  try {
    await assert.rejects(new PiSessionRuntime(sharedModelRuntime(modelRuntime())).start({
      manager: await createPrivateSessionManager(root, root), context: context({ writable: false }), deploymentConfig: {}, workspaceRoot: root, mcpConfigurations: localMcp(root), gitIdentity: { name: "", email: "test@example.test" }, systemPrompt: "", onEvent: () => undefined,
    }), /invalid_git_commit_identity/);
    await assert.rejects(readFile(join(root, "pid")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects configured models that are not currently available", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const manager = await createPrivateSessionManager(root, root);
  try {
    await assert.rejects(new PiSessionRuntime(sharedModelRuntime(modelRuntime(false))).start({
      manager,
      context: context({ writable: false }),
      deploymentConfig: {},
      workspaceRoot: root,
      systemPrompt: "",
      onEvent: () => undefined,
    }), /configured_model_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
