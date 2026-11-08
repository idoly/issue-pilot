import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, open, rm, writeFile, type FileHandle } from "node:fs/promises";

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

import { applicationParameters } from "../configuration/parameters.ts";
import type { AgentRuntimeConfiguration, DeploymentConfig } from "../domain/contracts.ts";
import type { McpConfiguration } from "../mcp/client.ts";
import { createIssueCodemodeExtension } from "./codemode-extension.ts";
import { createIssueMcpExtension } from "../mcp/pi-extension.ts";
import { assertIssueLaunchEnvironment, prepareIssueCommand, type PreparedIssueCommand } from "./issue-sandbox.ts";
import { assertIssueHardlinks, issueNativeTools } from "./native-tools.ts";
import type { IssueWorkFileStore } from "../workspace/work-files.ts";
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
  stateRoot?: string;
  agentDirectory?: string;
  runtime?: AgentRuntimeConfiguration;
  deploymentConfig: DeploymentConfig;
  workspaceRoot: string;
  readRoots?: string[];
  /** SQLite-selected personal or shared key; AgentEngine always supplies it, only injected runtimes omit it. */
  modelApiKey?: string;
  gitEnvironment?: Record<string, string>;
  gitAccess?: "write" | "read";
  gitReadRoots?: readonly string[];
  gitIdentity?: GitCommitIdentity;
  serviceScopes?: ServiceToolScope[];
  workspaceTool?: ToolDefinition<any, any, any>;
  mcpConfigurations?: McpConfiguration[];
  workFiles?: IssueWorkFileStore;
  systemPrompt: string;
  modelResponseIdleMs?: number;
  onEvent: (event: JsonAgentSessionEvent) => void;
}

export interface ManagedPiSession {
  readonly session: AgentSession;
  readonly streaming: boolean;
  setGitIdentity(identity: GitCommitIdentity): void;
  prompt(message: string, images?: ImageContent[], command?: string, signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}

export async function createPrivateSessionManager(cwd: string, sessionDirectory: string): Promise<SessionManager> {
  const manager = SessionManager.create(cwd, sessionDirectory);
  const generatedFile = manager.getSessionFile();
  const sessionFile = generatedFile ? path.join(sessionDirectory, `.session-${path.basename(generatedFile)}`) : undefined;
  const header = manager.getHeader();
  if (!sessionFile || !header) throw new Error("failed_to_initialize_agent_session");

  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    manager.setSessionFile(sessionFile);
  } catch (error) {
    try {
      await rm(sessionFile, { force: true });
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "agent_session_file_cleanup_failed");
    }
    throw error;
  }
  return manager;
}

/**
 * A bound session is one nonempty regular file of complete JSONL records whose first record is the session header.
 * Pi skips malformed lines and replaces a session without a header, so both are refused here instead.
 * Validated bytes are remembered per file: appends are the only normal way a session grows, so each open
 * only parses the new tail instead of re-reading a transcript that can reach tens of megabytes.
 */
const validatedSessions = new Map<string, { dev: number; ino: number; size: number; mtimeMs: number; sessionId: string; head: string; tail: string }>();
const validatedSessionsLimit = 256;

const sampleByteLimit = 4096;
/** Digest the first and last few KiB of a prefix; cheap evidence that an appended file was not rewritten. */
async function sampleBytes(descriptor: FileHandle, size: number): Promise<{ head: string; tail: string }> {
  const readAt = async (position: number) => {
    const buffer = Buffer.alloc(Math.min(sampleByteLimit, size));
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead);
  };
  return {
    head: createHash("sha256")
      .update(await readAt(0))
      .digest("hex"),
    tail: createHash("sha256")
      .update(await readAt(Math.max(0, size - sampleByteLimit)))
      .digest("hex"),
  };
}

async function prefixMatches(file: string, size: number, head: string, tail: string): Promise<boolean> {
  const descriptor = await open(file, "r");
  try {
    const sample = await sampleBytes(descriptor, size);
    return sample.head === head && sample.tail === tail;
  } finally {
    await descriptor.close();
  }
}

/** Read line 1 only; an appended session must still carry the header this process validated. */
async function headerMatches(descriptor: FileHandle, sessionId: string): Promise<boolean> {
  const buffer = Buffer.alloc(4096);
  const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0);
  const line = buffer
    .subarray(0, bytesRead)
    .toString("utf8")
    .split("\n", 1)[0]!
    .replace(/^\uFEFF/, "");
  try {
    const header = JSON.parse(line) as { type?: unknown; id?: unknown };
    return header.type === "session" && header.id === sessionId;
  } catch {
    return false;
  }
}

export async function assertSessionFileComplete(file: string): Promise<void> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || !metadata.size) throw new Error("agent_session_file_incomplete");
  const cached = validatedSessions.get(file);
  const unchanged = cached && cached.dev === metadata.dev && cached.ino === metadata.ino && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs;
  if (unchanged) return;
  // Same inode and a growing file: the earlier prefix was already validated and ends at a newline.
  // Growing on the same inode is only an append if the validated prefix is unchanged; a warm cache must not
  // hide an in-place rewrite that keeps the header and byte count intact.
  const growing = Boolean(cached && cached.dev === metadata.dev && cached.ino === metadata.ino && metadata.size > cached.size);
  const incremental = growing && (await prefixMatches(file, cached!.size, cached!.head, cached!.tail));
  const start = incremental ? cached!.size : 0;
  const descriptor = await open(file, "r");
  try {
    const current = await descriptor.stat(),
      tail = Buffer.alloc(1);
    await descriptor.read(tail, 0, 1, current.size - 1);
    if (tail[0] !== 0x0a) throw new Error("agent_session_file_incomplete");
    // A larger file on the same inode could still have been rewritten: the header must remain this session's.
    if (incremental && !(await headerMatches(descriptor, cached!.sessionId))) throw new Error("agent_session_file_incomplete");
    let first = start === 0;
    let sessionId = cached?.sessionId ?? "";
    for await (const raw of descriptor.readLines({ encoding: "utf8", autoClose: false, start })) {
      // Pi trims a leading UTF-8 BOM; accept the same files it accepts.
      const line = first ? raw.replace(/^\uFEFF/, "") : raw;
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error("agent_session_file_incomplete");
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("agent_session_file_incomplete");
      if (first) {
        const header = record as { type?: unknown; id?: unknown };
        if (header.type !== "session" || typeof header.id !== "string") throw new Error("agent_session_file_incomplete");
        sessionId = header.id;
      }
      first = false;
    }
    if (first) throw new Error("agent_session_file_incomplete");
    validatedSessions.delete(file);
    // A rewritten file must not swap in another session's transcript under the same binding.
    if (cached && cached.dev === current.dev && cached.ino === current.ino && sessionId !== cached.sessionId) throw new Error("agent_session_file_incomplete");
    const sample = await sampleBytes(descriptor, current.size);
    validatedSessions.set(file, { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs, sessionId, ...sample });
    if (validatedSessions.size > validatedSessionsLimit) {
      const oldest = validatedSessions.keys().next().value;
      if (oldest !== undefined) validatedSessions.delete(oldest);
    }
  } finally {
    await descriptor.close();
  }
}

const mcpResourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

const applicationExtensionPaths = new Set(["<inline:issue-pilot-codemode>", "<inline:issue-pilot-mcp>"]);
const protectedToolNames = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "codemode", "service_query", "workspace", "output"];

/** Operator extensions may add tools but never take application tool names, MCP names or each other's names. */
function assertExtensionToolNames(extensions: ReadonlyArray<{ path: string; tools: ReadonlyMap<string, { definition: { name: string } }> }>): void {
  const reserved = new Set(protectedToolNames);
  for (const extension of extensions) {
    if (applicationExtensionPaths.has(extension.path)) continue;
    for (const { definition } of extension.tools.values()) {
      if (reserved.has(definition.name) || definition.name.startsWith("mcp__") || mcpResourceTools.includes(definition.name)) throw new Error("agent_extension_tool_conflict");
      reserved.add(definition.name);
    }
  }
}

type JsonMessageUpdateEvent = Extract<JsonAgentSessionEvent, { type: "message_update" }>;

export class AgentResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly activeTools = new Set<string>();
  private readonly idleMs: () => number;
  private readonly onTimeout: () => void;

  /** A function is read on every arm so a changed application parameter reaches existing sessions. */
  constructor(idleMs: number | (() => number), onTimeout: () => void) {
    if (typeof idleMs === "number" && (!Number.isSafeInteger(idleMs) || idleMs <= 0)) throw new Error("invalid_model_response_idle_timeout");
    this.idleMs = typeof idleMs === "number" ? () => idleMs : idleMs;
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
    }, this.idleMs());
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
  const { context, deploymentConfig, workspaceRoot, workFiles, gitEnvironment, serviceScopes } = options;
  const tools = createCapabilityTools(context, deploymentConfig, { workFiles, serviceScopes });
  tools.unshift(
    ...issueNativeTools(
      {
        writeRoot: workspaceRoot,
        ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
        gitAccess: options.gitAccess ?? (context.canModifyCode ? "write" : "read"),
        readRoots: [...(options.readRoots ?? []), ...(options.gitReadRoots ?? []), options.agentDirectory ?? getAgentDir()],
        networkDomains: options.runtime?.networkAllowedDomains ?? [],
      },
      () => ({
        AI_AGENT: "pi",
        PI_CODING_AGENT: "true",
        GIT_OPTIONAL_LOCKS: "0",
        ISSUE_PILOT_IMAGE_AUTO_RESIZE: String(settings.getImageAutoResize()),
        PI_MODEL_IMAGE_RESIZE: JSON.stringify(model?.inputLimits?.images?.resize ?? null),
        PI_MODEL_INPUT: JSON.stringify(model?.input ?? ["text", "image"]),
        PI_SESSION_ID: options.manager.getSessionId(),
        PI_SESSION_FILE: options.manager.getSessionFile() ?? "",
        PI_PROVIDER: context.model.provider,
        PI_MODEL: context.model.modelId,
        PI_REASONING_LEVEL: context.model.thinkingLevel,
        ...(settings.getShellPath() ? { ISSUE_PILOT_SHELL_PATH: settings.getShellPath()! } : {}),
        ...(settings.getShellCommandPrefix() ? { ISSUE_PILOT_SHELL_PREFIX: settings.getShellCommandPrefix()! } : {}),
        ...gitEnvironment,
        ...identityEnvironment(),
      }),
    ),
  );
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
  const failures: unknown[] = [];
  try {
    if (!session.isIdle) await session.abort();
  } catch (error) {
    failures.push(error);
  }
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } catch (error) {
    failures.push(error);
  }
  try {
    session.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "pi_session_stop_failed");
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
    const keyed = options.modelApiKey ? createPiModelRuntime(options.agentDirectory ?? getAgentDir(), { provider: options.context.model.provider, apiKey: options.modelApiKey }) : undefined;
    const cleanup = async () => {
      const failures: unknown[] = [];
      for (const command of commands)
        try {
          await command.cleanup();
        } catch (error) {
          failures.push(error);
        }
      try {
        await keyed?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, "pi_runtime_cleanup_failed");
    };
    try {
      const managed = await this.startWithRuntime(options, keyed ?? this.#modelRuntime, commands);
      let stopping: Promise<void> | undefined,
        stopped = false;
      return {
        ...managed,
        get streaming() {
          return managed.streaming;
        },
        stop: () =>
          stopped
            ? Promise.resolve()
            : (stopping ??= (async () => {
                const failures: unknown[] = [];
                try {
                  try {
                    await managed.stop();
                  } catch (error) {
                    failures.push(error);
                  }
                  try {
                    await cleanup();
                  } catch (error) {
                    failures.push(error);
                  }
                  if (failures.length === 1) throw failures[0];
                  if (failures.length) throw new AggregateError(failures, "pi_runtime_stop_failed");
                } finally {
                  stopped = true;
                }
              })()),
      };
    } catch (error) {
      try {
        await cleanup();
      } catch (failure) {
        throw new AggregateError([error, failure], "pi_runtime_start_cleanup_failed");
      }
      throw error;
    }
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
    const settingsManager = SettingsManager.inMemory(
      {
        ...globalSettings,
        ...configuration.settings,
        codemode: { ...globalSettings.codemode, ...configuration.settings?.codemode, mode: context.codemode === "only" ? "only" : "on" },
      },
      { projectTrusted: false },
    );
    const mcpConfigurations: McpConfiguration[] = [];
    for (const configuration of options.mcpConfigurations ?? []) {
      if (!configuration.enabled || configuration.transport !== "stdio" || !configuration.stdio) {
        mcpConfigurations.push(configuration);
        continue;
      }
      assertIssueLaunchEnvironment(configuration.stdio.env ?? {});
      const cwd = path.resolve(workspaceRoot, configuration.stdio.cwd ?? ".");
      const prepared = await prepareIssueCommand(
        {
          writeRoot: workspaceRoot,
          ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
          gitAccess: "read",
          readRoots: options.readRoots ?? [],
          networkDomains: options.runtime?.networkAllowedDomains ?? [],
        },
        [configuration.stdio.command, ...configuration.stdio.args],
        cwd,
      );
      commands.push(prepared);
      mcpConfigurations.push({
        ...configuration,
        stdio: {
          ...configuration.stdio,
          command: prepared.argv[0]!,
          args: prepared.argv.slice(1),
          cwd,
          env: { ...configuration.stdio.env, NPM_CONFIG_CACHE: path.join(workspaceRoot, ".npm-cache"), TMPDIR: workspaceRoot },
        },
      });
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
      appendSystemPromptOverride: (base) => [...base, options.systemPrompt],
    });
    await resourceLoader.reload();
    const extensions = resourceLoader.getExtensions();
    if (extensions.errors.length) throw new Error("agent_extension_load_failed");
    if (resourceLoader.getSkills().diagnostics.some((diagnostic) => diagnostic.type === "error")) throw new Error("agent_skill_load_failed");
    if (resourceLoader.getPrompts().diagnostics.some((diagnostic) => diagnostic.type === "error")) throw new Error("agent_prompt_load_failed");
    const extensionTools = extensions.extensions
      .filter((extension) => extension.path !== "<inline:issue-pilot-codemode>")
      .flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
    assertExtensionToolNames(extensions.extensions);

    let activeSession: AgentSession | undefined;
    try {
      const requiredTools = [...sessionToolAllowlist(context), ...(options.workspaceTool ? [options.workspaceTool.name] : [])];
      const expectedTools = [
        ...requiredTools,
        ...extensionTools.filter((tool) => tool.defaultActive !== false && (!tool.exposure || tool.exposure === "direct" || tool.exposure === "model-only")).map((tool) => tool.name),
      ];
      const allowedTools = [...requiredTools, ...extensionTools.filter((tool) => tool.exposure !== "hidden").map((tool) => tool.name), "mcp__*", ...mcpResourceTools];
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
      // Extensions may register tools while binding (for example in session_start); recheck protected names.
      assertExtensionToolNames(resourceLoader.getExtensions().extensions);
      let rejectIdle: ((error: Error) => void) | undefined;
      let modelResponseFailed = false;
      const watchdog = new AgentResponseWatchdog(options.modelResponseIdleMs ?? (() => applicationParameters().modelResponseIdleMs), () => {
        const error = new Error("model_response_idle_timeout");
        rejectIdle?.(error);
        void session.abort().catch(() => undefined);
      });
      const unsubscribe = session.subscribe((event) => {
        const wireEvent = toWireEvent(event);
        if (wireEvent.type === "message_end" && wireEvent.message.role === "assistant") modelResponseFailed = wireEvent.message.stopReason === "error";
        else if (wireEvent.type === "agent_settled" && wireEvent.aborted) modelResponseFailed = false;
        watchdog.observe(wireEvent);
        options.onEvent(wireEvent);
      });
      let stop: Promise<void> | undefined,
        stopped = false;
      return {
        session,
        get streaming() {
          return session.isStreaming;
        },
        setGitIdentity: (identity) => {
          identityEnvironment = gitIdentityEnvironment(identity);
        },
        prompt: async (message, images = [], command, signal) => {
          signal?.throwIfAborted();
          modelResponseFailed = false;
          if (command) await session.sendCustomMessage({ customType: "issue-context", content: message, display: false }, { triggerTurn: false });
          const idle = new Promise<never>((_resolve, reject) => {
            rejectIdle = reject;
          });
          const abort = () => {
            void session.abort().catch((error: unknown) => rejectIdle?.(error instanceof Error ? error : new Error("agent_abort_failed")));
          };
          signal?.throwIfAborted();
          signal?.addEventListener("abort", abort, { once: true });
          watchdog.start();
          try {
            await Promise.race([session.prompt(command ?? message, images.length ? { images } : undefined), idle]);
            // Pi resolves after its retry policy settles, including terminal model errors.
            if (modelResponseFailed) throw new Error("model_response_failed");
          } finally {
            signal?.removeEventListener("abort", abort);
            rejectIdle = undefined;
            watchdog.stop();
          }
        },
        stop: () =>
          stopped
            ? Promise.resolve()
            : (stop ??= (async () => {
                try {
                  watchdog.stop();
                  unsubscribe();
                  await abortAndDispose(session);
                } finally {
                  stopped = true;
                }
              })()),
      };
    } catch (error) {
      if (activeSession) {
        try {
          await abortAndDispose(activeSession);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "pi_session_start_cleanup_failed");
        }
      }
      throw error;
    }
  }
}
