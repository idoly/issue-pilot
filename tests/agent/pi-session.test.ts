import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { sessionToolAllowlist, type AgentSessionContext } from "../../src/agent/context.ts";
import { AgentResponseWatchdog, createPrivateSessionManager, gitIdentityEnvironment, PiSessionRuntime } from "../../src/agent/pi-session.ts";
import type { PiModelRuntime } from "../../src/pi/models.ts";

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

function context(options: { writable: boolean; capability?: "db" }): AgentSessionContext {
  return {
    issueKey: "ISSUE-20260808-001",
    serviceKey: "orders",
    environmentKey: options.writable ? "dev" : "prod",
    model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
    capabilities: options.capability ? [options.capability] : [],
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

test("limits read-only deployments to non-mutating Pi tools", () => {
  assert.deepEqual(sessionToolAllowlist(context({ writable: false, capability: "db" })), ["read", "grep", "find", "ls", "db"]);
});

test("enables Pi mutation tools only for writable development contexts", () => {
  assert.deepEqual(sessionToolAllowlist(context({ writable: true })), [
    "read", "bash", "edit", "write", "grep", "find", "ls",
  ]);
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
    assert.deepEqual(managed.session.getActiveToolNames(), ["read", "grep", "find", "ls"]);
    assert.equal(managed.session.model?.id, "test-model");
    assert.equal(managed.session.thinkingLevel, "medium");
    assert.match(managed.session.agent.state.systemPrompt, /Issue Pilot test context/);
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposes an SDK session even when abort fails during stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const manager = await createPrivateSessionManager(root, root);
  const managed = await new PiSessionRuntime(sharedModelRuntime(modelRuntime())).start({
    manager,
    context: context({ writable: false }),
    deploymentConfig: {},
    workspaceRoot: root,
    systemPrompt: "",
    onEvent: () => undefined,
  });
  let disposed = false;
  const session = managed.session as AgentSession & { abort: () => Promise<void>; dispose: () => void };
  const dispose = session.dispose.bind(session);
  Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
  session.abort = async () => { throw new Error("abort_failed"); };
  session.dispose = () => { disposed = true; dispose(); };
  try {
    await assert.rejects(managed.stop(), /abort_failed/);
    assert.equal(disposed, true);
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
