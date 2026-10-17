import { writeFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type JsonAgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { DeploymentConfig } from "../domain/contracts.ts";
import type { SpreadsheetAttachment } from "../outputs/spreadsheet.ts";
import { createMcpToolBindings, type McpConfiguration, type McpToolBinding } from "../mcp/client.ts";
import { IssueOutputStore } from "../outputs/store.ts";
import { createPiModelRuntime, type PiModelRuntime } from "../pi/models.ts";
import { createCapabilityTools, type ServiceToolScope, type ServiceMcpToolScope } from "../pi/tools.ts";
import { sessionToolAllowlist, type AgentSessionContext } from "./context.ts";
import { createDocumentReadTool } from "./document-read-tool.ts";
import { SandboxToolSession } from "./sandbox-tool.ts";
import { PodmanSandbox, type SandboxFactory } from "../sandbox/runtime.ts";
import { createOutputTool } from "./output-tool.ts";

const isWindows = process.platform === "win32";
const pathSeparator = isWindows ? ";" : ":";

export interface GitCommitIdentity {
  name: string;
  email: string;
}

export interface StartPiSessionOptions {
  manager: SessionManager;
  context: AgentSessionContext;
  deploymentConfig: DeploymentConfig;
  workspaceRoot: string;
  executableRoot?: string;
  modelApiKey?: string;
  gitEnvironment?: Record<string, string>;
  gitIdentity?: GitCommitIdentity;
  serviceScopes?: ServiceToolScope[];
  workspaceTool?: ToolDefinition<any, any, any>;
  mcpScopes?: Array<{ environmentKey: string; serviceKey: string; serviceName: string; configurations: McpConfiguration[] }>;
  outputStore?: IssueOutputStore;
  spreadsheetAttachments?: { attachmentRoot: string; attachments: SpreadsheetAttachment[] };
  systemPrompt: string;
  codemode?: boolean;
  modelResponseIdleMs?: number;
  onEvent: (event: JsonAgentSessionEvent) => void;
}

export interface ManagedPiSession {
  readonly session: AgentSession;
  readonly streaming: boolean;
  setGitIdentity(identity: GitCommitIdentity): void;
  prompt(message: string, images?: ImageContent[]): Promise<void>;
  stop(): Promise<void>;
}

export async function createPrivateSessionManager(cwd: string, sessionDirectory: string): Promise<SessionManager> {
  const manager = SessionManager.create(cwd, sessionDirectory);
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader();
  if (!sessionFile || !header) throw new Error("failed_to_initialize_agent_session");

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  manager.setSessionFile(sessionFile);
  return manager;
}

type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

export class AgentResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly activeTools = new Set<string>();
  private readonly idleMs: number;
  private readonly onTimeout: () => void;

  constructor(idleMs: number, onTimeout: () => void) {
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) throw new Error("invalid_model_response_idle_timeout");
    this.idleMs = idleMs;
    this.onTimeout = onTimeout;
  }

  start(): void {
    this.arm();
  }

  observe(event: JsonAgentSessionEvent): void {
    if (event.type === "agent_start") this.arm();
    else if (event.type === "message_start" && event.message.role === "assistant") this.arm();
    else if (event.type === "message_update") this.arm();
    else if (event.type === "message_end") this.clear();
    else if (event.type === "tool_execution_start") {
      this.activeTools.add(event.toolCallId);
      this.clear();
    } else if (event.type === "tool_execution_end") {
      this.activeTools.delete(event.toolCallId);
      if (!this.activeTools.size) this.arm();
    } else if (event.type === "agent_end" || event.type === "agent_settled") this.stop();
  }

  stop(): void {
    this.activeTools.clear();
    this.clear();
  }

  private arm(): void {
    this.clear();
    if (this.activeTools.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTimeout();
    }, this.idleMs);
    this.timer.unref?.();
  }

  private clear(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function toWireEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  if (event.type !== "message_update") return event as JsonAgentSessionEvent;
  if (event.message.role !== "assistant") throw new Error("invalid_assistant_update_event");
  const assistantMessageEvent = { ...event.assistantMessageEvent };
  delete (assistantMessageEvent as { partial?: unknown }).partial;
  return {
    type: "message_update",
    usage: event.message.usage,
    assistantMessageEvent: assistantMessageEvent as JsonMessageUpdateEvent["assistantMessageEvent"],
  };
}

export function gitIdentityEnvironment(identity?: GitCommitIdentity): Record<string, string> {
  if (!identity) return {};
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (!name || !email || name.includes("\0") || email.includes("\0")) throw new Error("invalid_git_commit_identity");
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function sessionTools(context: AgentSessionContext, deploymentConfig: DeploymentConfig, workspaceRoot: string, gitIdentity: () => GitCommitIdentity | undefined, outputStore?: IssueOutputStore, executableRoot?: string, gitEnvironment?: Record<string, string>, spreadsheetAttachments?: StartPiSessionOptions["spreadsheetAttachments"], serviceScopes?: ServiceToolScope[], mcpScopes?: ServiceMcpToolScope[]): ToolDefinition<any, any, any>[] {
  const tools = createCapabilityTools(context, deploymentConfig, { outputStore, serviceScopes, mcpScopes });
  tools.unshift(createDocumentReadTool(workspaceRoot));
  if (context.canWriteOutputs) {
    if (!outputStore) throw new Error("issue_output_store_required");
    tools.unshift(createOutputTool(outputStore, spreadsheetAttachments));
  }
  if (!sessionToolAllowlist(context).includes("bash")) return tools;
  if (!executableRoot) throw new Error("project_wrapper_root_required");
  tools.unshift(createBashToolDefinition(workspaceRoot, {
    spawnHook: (context) => ({
      ...context,
      env: {
        ...context.env,
        AI_AGENT: "pi",
        PI_CODING_AGENT: "true",
        PATH: `${executableRoot}${pathSeparator}${context.env.PATH ?? ""}`,
        ...gitEnvironment,
        ...gitIdentityEnvironment(gitIdentity()),
      },
    }),
  }));
  return tools;
}

function assertSessionState(session: AgentSession, context: AgentSessionContext, expectedSessionId: string, expectedTools: string[]) {
  const model = session.model;
  if (session.sessionId !== expectedSessionId) throw new Error("pi_session_id_mismatch");
  if (!model || model.provider !== context.model.provider || model.id !== context.model.modelId) throw new Error("pi_session_model_mismatch");
  if (session.thinkingLevel !== context.model.thinkingLevel) throw new Error("pi_session_thinking_level_mismatch");
  const active = [...session.getActiveToolNames()].sort();
  const expected = [...expectedTools].sort();
  if (active.length !== expected.length || active.some((name, index) => name !== expected[index])) throw new Error("pi_session_tools_mismatch");
}

async function abortAndDispose(session: AgentSession): Promise<void> {
  try {
    if (!session.isIdle) await session.abort();
  } finally {
    session.dispose();
  }
}

export class PiSessionRuntime {
  readonly #modelRuntime: PiModelRuntime;
  readonly #ownsModelRuntime: boolean;
  readonly #sandboxFactory: SandboxFactory | undefined;

  constructor(modelRuntime?: PiModelRuntime, sandboxFactory?: SandboxFactory) {
    this.#modelRuntime = modelRuntime ?? createPiModelRuntime();
    this.#ownsModelRuntime = modelRuntime === undefined;
    this.#sandboxFactory = sandboxFactory;
  }

  async close(): Promise<void> {
    try { if (this.#ownsModelRuntime) await this.#modelRuntime.close(); }
    finally { await PodmanSandbox.cleanupPending(); }
  }

  async start(options: StartPiSessionOptions): Promise<ManagedPiSession> {
    if (!options.modelApiKey) return this.startWithRuntime(options, this.#modelRuntime);
    const personal = createPiModelRuntime(getAgentDir(), { provider: options.context.model.provider, apiKey: options.modelApiKey });
    try {
      const managed = await this.startWithRuntime(options, personal);
      return { ...managed, get streaming() { return managed.streaming; }, stop: async () => { try { await managed.stop(); } finally { await personal.close(); } } };
    } catch (error) { await personal.close(); throw error; }
  }

  private async startWithRuntime(options: StartPiSessionOptions, runtime: PiModelRuntime): Promise<ManagedPiSession> {
    const { context, workspaceRoot } = options;
    const modelRuntime = await runtime.load();
    await modelRuntime.refresh({ providers: [context.model.provider], allowNetwork: false });
    const model = modelRuntime.getModel(context.model.provider, context.model.modelId);
    if (!model) throw new Error(`configured_model_not_found:${context.model.provider}/${context.model.modelId}`);
    if (!modelRuntime.getAvailableSnapshot().some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`configured_model_unavailable:${model.provider}/${model.id}`);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const codemode = options.codemode ?? issuePilotConfig.runtime.agent.codemode;
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      extensionFactories: codemode ? [createCodemodeExtension({ mode: "on", models: false })] : [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [options.systemPrompt],
    });
    await resourceLoader.reload();

    const discovered = new Map<string, Promise<McpToolBinding[]>>();
    const mcpScopes = await Promise.all((options.mcpScopes ?? []).map(async scope => ({
      environmentKey: scope.environmentKey, serviceKey: scope.serviceKey, serviceName: scope.serviceName,
      tools: (await Promise.all(scope.configurations.map(configuration => {
        const writable = context.canModifyCode && scope.environmentKey === "dev";
        const key = `${configuration.id}:${writable}`;
        if (!discovered.has(key)) discovered.set(key, createMcpToolBindings([configuration], writable));
        return discovered.get(key)!;
      }))).flat(),
    })));
    const expectedTools = [...(codemode ? ["codemode"] : []), ...sessionToolAllowlist(context), ...(!context.capabilities.length && mcpScopes.some(scope => scope.tools.length) ? ["service_query"] : []), ...(options.workspaceTool ? [options.workspaceTool.name] : [])];
    let gitIdentity = options.gitIdentity;
    gitIdentityEnvironment(gitIdentity);
    const sandbox = new SandboxToolSession(context.canWriteOutputs ? options.outputStore : undefined, this.#sandboxFactory);
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: getAgentDir(),
      modelRuntime,
      model,
      thinkingLevel: context.model.thinkingLevel,
      tools: expectedTools,
      customTools: [sandbox.tool, ...sessionTools(context, options.deploymentConfig, workspaceRoot, () => gitIdentity, options.outputStore, options.executableRoot, options.gitEnvironment, options.spreadsheetAttachments, options.serviceScopes, mcpScopes), ...(options.workspaceTool ? [options.workspaceTool] : [])],
      sessionManager: options.manager,
      settingsManager,
      resourceLoader,
    });
    try {
      await session.bindExtensions({});
      assertSessionState(session, context, options.manager.getSessionId(), expectedTools);
    } catch (error) {
      try { await abortAndDispose(session); } finally { await sandbox.close(); }
      throw error;
    }
    let rejectIdle: ((error: Error) => void) | undefined;
    const watchdog = new AgentResponseWatchdog(options.modelResponseIdleMs ?? issuePilotConfig.runtime.agent.modelResponseIdleMs, () => {
      const error = new Error("model_response_idle_timeout");
      rejectIdle?.(error);
      void session.abort().catch(() => undefined);
    });
    const unsubscribe = session.subscribe((event) => {
      const wireEvent = toWireEvent(event);
      watchdog.observe(wireEvent);
      options.onEvent(wireEvent);
    });
    let stopped = false;

    return {
      session,
      get streaming() {
        return session.isStreaming;
      },
      setGitIdentity: (identity) => {
        gitIdentityEnvironment(identity);
        gitIdentity = identity;
      },
      prompt: async (message, images = []) => {
        const idle = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
        watchdog.start();
        try { await Promise.race([session.prompt(message, images.length ? { images } : undefined), idle]); }
        finally { rejectIdle = undefined; watchdog.stop(); await sandbox.finishRun(); }
      },
      stop: async () => {
        if (stopped) { await sandbox.close(); return; }
        stopped = true;
        watchdog.stop();
        unsubscribe();
        try { await abortAndDispose(session); } finally { await sandbox.close(); }
      },
    };
  }
}
