import { writeFile } from "node:fs/promises";

import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type JsonAgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createCapabilityTools } from "../pi/tools.ts";
import { piToolAllowlist, type IssuePolicy } from "../pi/policy.ts";

const isWindows = process.platform === "win32";
const pathSeparator = isWindows ? ";" : ":";

export interface StartPiSessionOptions {
  manager: SessionManager;
  policy: IssuePolicy;
  deploymentConfig: Record<string, unknown>;
  workspaceRoot: string;
  executableRoot?: string;
  systemPrompt: string;
  onEvent: (event: JsonAgentSessionEvent) => void;
}

export interface ManagedPiSession {
  readonly session: AgentSession;
  readonly streaming: boolean;
  prompt(message: string): Promise<void>;
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

function toWireEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
  if (event.type !== "message_update" || !("partial" in event.assistantMessageEvent)) return event;
  const assistantMessageEvent = { ...event.assistantMessageEvent };
  delete (assistantMessageEvent as { partial?: unknown }).partial;
  return { ...event, assistantMessageEvent } as JsonAgentSessionEvent;
}

function sessionTools(policy: IssuePolicy, deploymentConfig: Record<string, unknown>, workspaceRoot: string, executableRoot?: string): ToolDefinition<any, any, any>[] {
  const tools = createCapabilityTools(policy, deploymentConfig);
  if (!piToolAllowlist(policy).includes("bash")) return tools;
  if (!executableRoot) throw new Error("project_wrapper_root_required");
  tools.unshift(createBashToolDefinition(workspaceRoot, {
    spawnHook: (context) => ({
      ...context,
      env: {
        ...context.env,
        AI_AGENT: "pi",
        PI_CODING_AGENT: "true",
        PATH: `${executableRoot}${pathSeparator}${context.env.PATH ?? ""}`,
      },
    }),
  }));
  return tools;
}

function assertSessionState(session: AgentSession, policy: IssuePolicy, expectedSessionId: string, expectedTools: string[]) {
  const model = session.model;
  if (session.sessionId !== expectedSessionId) throw new Error("pi_session_id_mismatch");
  if (!model || model.provider !== policy.model.provider || model.id !== policy.model.modelId) throw new Error("pi_session_model_mismatch");
  if (session.thinkingLevel !== policy.model.thinkingLevel) throw new Error("pi_session_thinking_level_mismatch");
  const active = [...session.getActiveToolNames()].sort();
  const expected = [...expectedTools].sort();
  if (active.length !== expected.length || active.some((name, index) => name !== expected[index])) throw new Error("pi_session_tools_mismatch");
}

async function abortAndDispose(session: AgentSession): Promise<void> {
  try {
    if (session.isStreaming) await session.abort();
  } finally {
    session.dispose();
  }
}

export class PiSessionRuntime {
  readonly #modelRuntime: Promise<ModelRuntime>;

  constructor(modelRuntime = ModelRuntime.create({ allowModelNetwork: false })) {
    this.#modelRuntime = modelRuntime;
  }

  async start(options: StartPiSessionOptions): Promise<ManagedPiSession> {
    const { policy, workspaceRoot } = options;
    const modelRuntime = await this.#modelRuntime;
    await modelRuntime.refresh();
    const model = modelRuntime.getModel(policy.model.provider, policy.model.modelId);
    if (!model) throw new Error(`configured_model_not_found:${policy.model.provider}/${policy.model.modelId}`);
    const available = await modelRuntime.getAvailable(policy.model.provider);
    if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
      throw new Error(`configured_model_unavailable:${model.provider}/${model.id}`);
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true },
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: getAgentDir(),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
      appendSystemPrompt: [options.systemPrompt],
    });
    await resourceLoader.reload();

    const expectedTools = piToolAllowlist(policy);
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: getAgentDir(),
      modelRuntime,
      model,
      thinkingLevel: policy.model.thinkingLevel,
      tools: expectedTools,
      customTools: sessionTools(policy, options.deploymentConfig, workspaceRoot, options.executableRoot),
      sessionManager: options.manager,
      settingsManager,
      resourceLoader,
    });
    try {
      assertSessionState(session, policy, options.manager.getSessionId(), expectedTools);
    } catch (error) {
      await abortAndDispose(session);
      throw error;
    }
    const unsubscribe = session.subscribe((event) => options.onEvent(toWireEvent(event)));
    let stopped = false;

    return {
      session,
      get streaming() {
        return session.isStreaming;
      },
      prompt: (message) => session.prompt(message),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        await abortAndDispose(session);
      },
    };
  }
}
