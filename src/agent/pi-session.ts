import path from "node:path";
import { writeFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
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
import type { AgentRuntimeConfiguration, DeploymentConfig } from "../domain/contracts.ts";
import type { McpConfiguration } from "../mcp/client.ts";
import { createIssueCodemodeExtension } from "./codemode-extension.ts";
import { createIssueMcpExtension } from "../mcp/pi-extension.ts";
import { assertIssueLaunchEnvironment, prepareIssueCommand, type PreparedIssueCommand } from "./issue-sandbox.ts";
import { assertIssueHardlinks, issueNativeTools } from "./native-tools.ts";
import { IssueOutputStore } from "../outputs/store.ts";
import { createPiModelRuntime, type PiModelRuntime } from "./model-runtime.ts";
import { createCapabilityTools, type ServiceToolScope } from "./service-query-tool.ts";
import { sessionToolAllowlist, type AgentSessionContext } from "./context.ts";

export interface GitCommitIdentity {
  name: string;
  email: string;
}

export interface StartPiSessionOptions {
  manager: SessionManager;
  context: AgentSessionContext;
  agentDirectory?: string;
  runtime?: AgentRuntimeConfiguration;
  deploymentConfig: DeploymentConfig;
  workspaceRoot: string;
  readRoots?: string[];
  modelApiKey?: string;
  gitEnvironment?: Record<string, string>;
  gitIdentity?: GitCommitIdentity;
  serviceScopes?: ServiceToolScope[];
  workspaceTool?: ToolDefinition<any, any, any>;
  mcpConfigurations?: McpConfiguration[];
  outputStore?: IssueOutputStore;
  systemPrompt: string;
  modelResponseIdleMs?: number;
  onEvent: (event: JsonAgentSessionEvent) => void;
}

export interface ManagedPiSession {
  readonly session: AgentSession;
  readonly streaming: boolean;
  setGitIdentity(identity: GitCommitIdentity): void;
  prompt(message: string, images?: ImageContent[], command?: string): Promise<void>;
  stop(): Promise<void>;
}

export async function createPrivateSessionManager(cwd: string, sessionDirectory: string): Promise<SessionManager> {
  const manager = SessionManager.create(cwd, sessionDirectory);
  const generatedFile = manager.getSessionFile();
  const sessionFile = generatedFile ? path.join(sessionDirectory, `.session-${path.basename(generatedFile)}`) : undefined;
  const header = manager.getHeader();
  if (!sessionFile || !header) throw new Error("failed_to_initialize_agent_session");

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  manager.setSessionFile(sessionFile);
  return manager;
}

const mcpResourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

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
    else if (event.type === "message_end" && event.message.role === "assistant") this.clear();
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

function sessionTools(options: StartPiSessionOptions, identityEnvironment: () => Record<string, string>, settings: SettingsManager, model: AgentSession["model"]): ToolDefinition<any, any, any>[] {
  const { context, deploymentConfig, workspaceRoot, outputStore, gitEnvironment, serviceScopes } = options;
  const tools = createCapabilityTools(context, deploymentConfig, { outputStore, serviceScopes });
  tools.unshift(...issueNativeTools({ writeRoot: workspaceRoot, readRoots: [...(options.readRoots ?? []), options.agentDirectory ?? getAgentDir()], networkDomains: options.runtime?.networkAllowedDomains ?? [] }, () => ({
    AI_AGENT: "pi", PI_CODING_AGENT: "true", GIT_OPTIONAL_LOCKS: "0",
    PI_MODEL_INPUT: JSON.stringify(model?.input ?? ["text", "image"]),
    PI_SESSION_ID: options.manager.getSessionId(), PI_SESSION_FILE: options.manager.getSessionFile() ?? "", PI_PROVIDER: context.model.provider, PI_MODEL: context.model.modelId, PI_REASONING_LEVEL: context.model.thinkingLevel,
    PATH: [path.resolve(import.meta.dirname, "../../.venv/bin"), process.env.PATH].filter(Boolean).join(path.delimiter),
    ...(settings.getShellPath() ? { ISSUE_PILOT_SHELL_PATH: settings.getShellPath()! } : {}),
    ...(settings.getShellCommandPrefix() ? { ISSUE_PILOT_SHELL_PREFIX: settings.getShellCommandPrefix()! } : {}),
    ...gitEnvironment, ...identityEnvironment(),
  })));
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
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally { session.dispose(); }
  }
}

export class PiSessionRuntime {
  readonly #modelRuntime: PiModelRuntime;
  readonly #ownsModelRuntime: boolean;

  constructor(modelRuntime?: PiModelRuntime) {
    this.#modelRuntime = modelRuntime ?? createPiModelRuntime();
    this.#ownsModelRuntime = modelRuntime === undefined;
  }

  async close(): Promise<void> {
    if (this.#ownsModelRuntime) await this.#modelRuntime.close();
  }

  async start(options: StartPiSessionOptions): Promise<ManagedPiSession> {
    const commands: PreparedIssueCommand[] = [];
    const personal = options.modelApiKey ? createPiModelRuntime(getAgentDir(), { provider: options.context.model.provider, apiKey: options.modelApiKey }) : undefined;
    const cleanup = async () => {
      const failures: unknown[] = [];
      for (const command of commands) try { await command.cleanup(); } catch (error) { failures.push(error); }
      try { await personal?.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "pi_runtime_cleanup_failed");
    };
    try {
      const managed = await this.startWithRuntime(options, personal ?? this.#modelRuntime, commands);
      let stopping: Promise<void> | undefined, stopped = false;
      return { ...managed, get streaming() { return managed.streaming; }, stop: () => stopped ? Promise.resolve() : stopping ??= (async () => {
        const failures: unknown[] = [];
        try {
          try { await managed.stop(); } catch (error) { failures.push(error); }
          try { await cleanup(); } catch (error) { failures.push(error); }
          if (failures.length === 1) throw failures[0];
          if (failures.length) throw new AggregateError(failures, "pi_runtime_stop_failed");
        } finally { stopped = true; }
      })() };
    } catch (error) { try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], "pi_runtime_start_cleanup_failed"); } throw error; }
  }

  private async startWithRuntime(options: StartPiSessionOptions, runtime: PiModelRuntime, commands: PreparedIssueCommand[]): Promise<ManagedPiSession> {
    const { context, workspaceRoot, runtime: configuration = {} } = options;
    await assertIssueHardlinks(workspaceRoot);
    const modelRuntime = await runtime.load();
    await modelRuntime.refresh({ providers: [context.model.provider], allowNetwork: false });
    const model = modelRuntime.getModel(context.model.provider, context.model.modelId);
    if (!model) throw new Error(`configured_model_not_found:${context.model.provider}/${context.model.modelId}`);
    if (!modelRuntime.getAvailableSnapshot().some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`configured_model_unavailable:${model.provider}/${model.id}`);
    }

    const agentDirectory = options.agentDirectory ?? getAgentDir();
    const globalSettings = SettingsManager.create(agentDirectory, agentDirectory, { projectTrusted: false }).getSettings();
    const settingsManager = SettingsManager.inMemory({
      ...globalSettings,
      ...configuration.settings,
      codemode: { ...globalSettings.codemode, ...configuration.settings?.codemode, mode: context.codemode === "only" ? "only" : "on" },
    }, { projectTrusted: false });
    const mcpConfigurations: McpConfiguration[] = [];
    for (const configuration of options.mcpConfigurations ?? []) {
      if (!configuration.enabled || configuration.transport !== "stdio" || !configuration.stdio) { mcpConfigurations.push(configuration); continue; }
      assertIssueLaunchEnvironment(configuration.stdio.env ?? {});
      const cwd = path.resolve(workspaceRoot, configuration.stdio.cwd ?? ".");
      const prepared = await prepareIssueCommand({ writeRoot: workspaceRoot, readRoots: options.readRoots ?? [], networkDomains: options.runtime?.networkAllowedDomains ?? [] }, [configuration.stdio.command, ...configuration.stdio.args], cwd);
      commands.push(prepared);
      mcpConfigurations.push({ ...configuration, stdio: { ...configuration.stdio, command: prepared.argv[0]!, args: prepared.argv.slice(1), cwd, env: { ...configuration.stdio.env, NPM_CONFIG_CACHE: path.join(workspaceRoot, ".npm-cache"), TMPDIR: workspaceRoot } } });
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDirectory,
      agentDir: agentDirectory,
      settingsManager,
      extensionFactories: [
        ...(context.codemode === "off" ? [] : [{ name: "issue-pilot-codemode", factory: createIssueCodemodeExtension(workspaceRoot) }]),
        { name: "issue-pilot-mcp", factory: createIssueMcpExtension(mcpConfigurations, context.codemode, workspaceRoot) },
      ],
      noThemes: true,
      appendSystemPromptOverride: base => [...base, options.systemPrompt],
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    if (extensions.errors.length) throw new Error("agent_extension_load_failed");
    if (resourceLoader.getSkills().diagnostics.some(diagnostic => diagnostic.type === "error")) throw new Error("agent_skill_load_failed");
    if (resourceLoader.getPrompts().diagnostics.some(diagnostic => diagnostic.type === "error")) throw new Error("agent_prompt_load_failed");
    const extensionTools = extensions.extensions.filter(extension => extension.path !== "<inline:issue-pilot-codemode>").flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
    const reserved = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "service_query", "workspace", "output"]);
    for (const tool of extensionTools) {
      if (reserved.has(tool.name) || tool.name.startsWith("mcp__") || mcpResourceTools.includes(tool.name)) throw new Error("agent_extension_tool_conflict");
      reserved.add(tool.name);
    }

    let activeSession: AgentSession | undefined;
    try {
      const requiredTools = [...sessionToolAllowlist(context), ...(options.workspaceTool ? [options.workspaceTool.name] : [])];
      const expectedTools = [...requiredTools, ...extensionTools.filter(tool => tool.defaultActive !== false && (!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only")).map(tool => tool.name)];
      const allowedTools = [...requiredTools, ...extensionTools.filter(tool => tool.exposure !== "hidden").map(tool => tool.name), "mcp__*", ...mcpResourceTools];
      let identityEnvironment = gitIdentityEnvironment(options.gitIdentity);
      const { session } = await createAgentSession({
        cwd: workspaceRoot,
        agentDir: agentDirectory,
        modelRuntime,
        model,
        thinkingLevel: context.model.thinkingLevel,
        tools: allowedTools,
        customTools: [...sessionTools(options, () => identityEnvironment, settingsManager, model), ...(options.workspaceTool ? [options.workspaceTool] : [])],
        sessionManager: options.manager,
        settingsManager,
        resourceLoader,
      });
      activeSession = session;
      session.setActiveToolsByName(expectedTools);
      assertSessionState(session, context, options.manager.getSessionId(), expectedTools);
      await session.bindExtensions({});
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
      let stop: Promise<void> | undefined, stopped = false;
      return {
        session,
        get streaming() { return session.isStreaming; },
        setGitIdentity: (identity) => { identityEnvironment = gitIdentityEnvironment(identity); },
        prompt: async (message, images = [], command) => {
          if (command) await session.sendCustomMessage({ customType: "issue-context", content: message, display: false }, { triggerTurn: false });
          const idle = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
          watchdog.start();
          try { await Promise.race([session.prompt(command ?? message, images.length ? { images } : undefined), idle]); }
          finally { rejectIdle = undefined; watchdog.stop(); }
        },
        stop: () => stopped ? Promise.resolve() : stop ??= (async () => {
          try { watchdog.stop(); unsubscribe(); await abortAndDispose(session); }
          finally { stopped = true; }
        })(),
      };
    } catch (error) {
      if (activeSession) await abortAndDispose(activeSession);
      throw error;
    }
  }
}
