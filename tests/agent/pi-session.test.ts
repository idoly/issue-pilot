import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";

import { createPrivateSessionManager, PiSessionRuntime } from "../../src/agent/pi-session.ts";
import { createIssuePolicy, piToolAllowlist, type IssuePolicy } from "../../src/pi/policy.ts";

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

function policy(options: { writable: boolean; capability?: "db" }): IssuePolicy {
  const capability = options.capability;
  return createIssuePolicy({
    issueKey: "ISSUE-20260808-001",
    issueType: options.writable ? "defect_fix" : "data_processing",
    workspaceRoot: "/tmp/issue-workspace",
    model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
    service: {
      serviceKey: "orders",
      environmentKey: options.writable ? "dev" : "prod",
      environmentKind: options.writable ? "dev" : "prod",
      capabilities: capability ? [capability] : [],
      ...(capability === "db" ? { db: { deploymentId: "deployment-1" } } : {}),
      repositories: [{ codeAccess: options.writable ? "write" : "read", repositoryPath: "/tmp/issue-workspace/orders", baseCommit: "abc123" }],
    },
  });
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

function modelRuntime(available = true): ModelRuntime {
  return {
    async refresh() { return { aborted: false, errors: new Map() }; },
    getModel() { return model; },
    async getAvailable() { return available ? [model] : []; },
  } as unknown as ModelRuntime;
}

test("limits read-only deployments to non-mutating Pi tools", () => {
  assert.deepEqual(piToolAllowlist(policy({ writable: false, capability: "db" })), ["read", "grep", "find", "ls", "db"]);
});

test("enables only Pi mutation tools for writable development policies without capabilities", () => {
  assert.deepEqual(piToolAllowlist(policy({ writable: true })), [
    "read", "bash", "edit", "write", "grep", "find", "ls",
  ]);
});

test("starts an SDK session with only policy-selected tools and explicit resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const workspaceRoot = join(root, "workspace");
  const sessionDirectory = join(root, "sessions");
  await Promise.all([mkdir(workspaceRoot), mkdir(sessionDirectory)]);
  const manager = await createPrivateSessionManager(workspaceRoot, sessionDirectory);
  const runtime = new PiSessionRuntime(Promise.resolve(modelRuntime()));
  try {
    const managed = await runtime.start({
      manager,
      policy: policy({ writable: false }),
      deploymentConfig: {},
      workspaceRoot,
      systemPrompt: "Issue Pilot test policy.",
      onEvent: () => undefined,
    });
    assert.deepEqual(managed.session.getActiveToolNames(), ["read", "grep", "find", "ls"]);
    assert.equal(managed.session.model?.id, "test-model");
    assert.equal(managed.session.thinkingLevel, "medium");
    assert.match(managed.session.agent.state.systemPrompt, /Issue Pilot test policy/);
    await managed.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposes an SDK session even when abort fails during stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-pi-sdk-"));
  const manager = await createPrivateSessionManager(root, root);
  const managed = await new PiSessionRuntime(Promise.resolve(modelRuntime())).start({
    manager,
    policy: policy({ writable: false }),
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
    await assert.rejects(new PiSessionRuntime(Promise.resolve(modelRuntime(false))).start({
      manager,
      policy: policy({ writable: false }),
      deploymentConfig: {},
      workspaceRoot: root,
      systemPrompt: "",
      onEvent: () => undefined,
    }), /configured_model_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
