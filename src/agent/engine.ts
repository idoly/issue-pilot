import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import type { RunEvent } from "./events.ts";
import { CodeServer } from "../workspace/code-server.ts";
import type { openDatabase } from "../db/client.ts";
import {
  agentSessions,
  issueAgentResults,
  environments,
  issueAttachments,
  issueRepositories,
  issueWorkspaces,
  issues,
  serviceDeployments,
  serviceRepositories,
  services,
} from "../db/schema.ts";
import { configuredCapabilities } from "../shared/capabilities.ts";
import { Worktrees } from "../workspace/git.ts";
import { createIssuePolicy, type IssuePolicy } from "../pi/policy.ts";
import { registerIssuePilotExtension, type IssueCompletion } from "../pi/extension.ts";
import { Coordinator } from "./coordinator.ts";
import { continuationPrompt, initialPrompt, promptWithRuntimeTime } from "./prompts.ts";

type Database = ReturnType<typeof openDatabase>["db"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface ManagedSession {
  session: AgentSession;
  policy: IssuePolicy;
  completion: IssueCompletion | null;
  manager: SessionManager;
  unsubscribe: () => void;
}

export class AgentEngine {
  private readonly queue = new Coordinator();
  private readonly runCounts = new Map<string, number>();
  private readonly worktrees: Worktrees;
  private readonly codeServer: CodeServer;
  private readonly stateRoot: string;
  private readonly db: Database;
  private readonly publish: ((event: RunEvent) => void) | undefined;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly modelRuntime: Promise<ModelRuntime>;

  constructor(db: Database, stateRoot = ".issue-pilot", publish?: (event: RunEvent) => void) {
    this.db = db;
    this.stateRoot = path.resolve(stateRoot);
    this.worktrees = new Worktrees(this.stateRoot);
    this.codeServer = new CodeServer(this.stateRoot);
    this.publish = publish;
    this.modelRuntime = ModelRuntime.create();
  }

  enqueue(issueId: string, latestMessage?: string, displayMessage = false): void {
    this.schedule(issueId, () => this.run(issueId, latestMessage, displayMessage));
  }

  isRunning(issueId: string): boolean {
    return (this.runCounts.get(issueId) ?? 0) > 0;
  }

  async invalidatePolicy(issueId: string): Promise<boolean> {
    await this.disposeSession(issueId);
    return true;
  }

  async send(issueId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("agent_message_required");
    const userMessage = message.trim();
    const managed = this.sessions.get(issueId);
    if (!managed) {
      this.enqueue(issueId, userMessage, true);
      return;
    }
    this.publishUserMessage(issueId, managed.manager, userMessage);
    if (managed.session.isStreaming) await managed.session.steer(promptWithRuntimeTime(userMessage));
    else this.schedule(issueId, () => this.promptExisting(issueId, managed, userMessage));
  }

  async abort(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed) return false;
    await managed.session.abort();
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((issueId) => this.disposeSession(issueId)));
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
    void this.queue.run(issueId, operation).catch(async (error) => {
      try {
        await this.db.transaction(async (transaction) => {
          await transaction.update(issueWorkspaces).set({
            status: "failed",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          }).where(eq(issueWorkspaces.issueId, issueId));
          await transaction.update(issues).set({ status: "open", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), ne(issues.status, "resolved")));
        });
        this.publishStatus(issueId, "error");
      } catch {
        // A reporting write must not turn a handled background failure into an unhandled rejection.
      }
    }).finally(() => {
      const remaining = (this.runCounts.get(issueId) ?? 1) - 1;
      if (remaining > 0) this.runCounts.set(issueId, remaining);
      else this.runCounts.delete(issueId);
    });
  }

  private async run(issueId: string, latestMessage?: string, displayMessage = false): Promise<void> {
    const [issue] = await this.db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    const currentMessage = latestMessage?.trim() || undefined;
    await this.db.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));

    const [service] = await this.db.select({
      id: services.id,
      key: services.key,
      name: services.name,
      description: services.description,
      deploymentId: serviceDeployments.id,
      baseBranch: serviceDeployments.baseBranch,
      deploymentConfig: serviceDeployments.config,
      environmentKey: environments.key,
      environmentKind: environments.kind,
    }).from(services)
      .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, issue.environmentId)))
      .innerJoin(environments, eq(environments.id, issue.environmentId))
      .where(eq(services.id, issue.serviceId))
      .limit(1);
    if (!service) throw new Error("issue_service_deployment_not_found");
    if (service.environmentKind !== "production" && service.environmentKind !== "test" && service.environmentKind !== "development") throw new Error("unsupported_issue_environment_kind");
    const worktreeMode = service.environmentKind === "development" && issue.type === "incident"
      ? "hotfix" as const
      : service.environmentKind === "development" && issue.type === "request"
        ? "feature" as const
        : "detached" as const;

    const [repositoryRows, existingRepositoryRows, attachmentRows] = await Promise.all([
      this.db.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id)),
      this.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
      this.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
    ]);
    if (!repositoryRows.length) {
      await this.db.delete(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      throw new Error("selected_service_has_no_repository");
    }
    const existingRepositoryByUrl = new Map(existingRepositoryRows.map((repository) => [repository.url, repository]));
    await this.db.delete(issueRepositories).where(and(
      eq(issueRepositories.issueId, issue.id),
      notInArray(issueRepositories.url, repositoryRows.map((repository) => repository.url)),
    ));

    const prepared: Array<{ repository: (typeof repositoryRows)[number]; workspace: Awaited<ReturnType<Worktrees["prepare"]>> }> = [];
    for (const repository of repositoryRows) {
      const existingRepository = existingRepositoryByUrl.get(repository.url);
      const workspace = await this.worktrees.prepare({
        issueId: issue.key,
        repositoryId: repository.id,
        url: repository.url,
        baseBranch: service.baseBranch,
        mode: worktreeMode,
        ...(worktreeMode !== "detached" && existingRepository?.workingBranch ? { workingBranch: existingRepository.workingBranch } : {}),
        ...(existingRepository?.localPath ? { existingWorkspacePath: existingRepository.localPath } : {}),
        ...(existingRepository?.commitBefore ? { existingBaseCommit: existingRepository.commitBefore } : {}),
      });
      prepared.push({ repository, workspace });
      await this.db.insert(issueRepositories).values({
        issueId: issue.id,
        url: repository.url,
        baseBranch: workspace.baseBranch,
        workingBranch: workspace.workingBranch,
        localPath: workspace.workspacePath,
        commitBefore: workspace.baseCommit,
      }).onConflictDoUpdate({
        target: [issueRepositories.issueId, issueRepositories.url],
        set: {
          baseBranch: workspace.baseBranch,
          workingBranch: workspace.workingBranch,
          localPath: workspace.workspacePath,
          commitBefore: existingRepository?.commitBefore ?? workspace.baseCommit,
          updatedAt: new Date(),
        },
      });
    }

    const workspaceRoot = path.resolve(this.stateRoot, "workspaces", issue.key.toLowerCase());
    const sessionDirectory = path.resolve(this.stateRoot, "sessions", issue.key);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    const nacosScope = this.nacosScope(service.deploymentId, service.deploymentConfig);
    const dbScope = this.dbScope(service.deploymentId, service.deploymentConfig);
    const slsScope = this.slsScope(service.deploymentId, service.deploymentConfig);
    const browserScope = this.browserScope(service.deploymentId, service.deploymentConfig);
    const redisScope = this.redisScope(service.deploymentId, service.deploymentConfig);
    const esScope = this.esScope(service.deploymentId, service.deploymentConfig);
    const mqScope = this.mqScope(service.deploymentId, service.deploymentConfig);
    const policy = createIssuePolicy({
      model: this.modelScope(service.deploymentConfig),
      issueKey: issue.key,
      issueType: issue.type,
      workspaceRoot,
      attachments: attachmentRows.map((attachment) => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size, sha256: attachment.sha256, attachmentPath: attachment.objectKey })),
      service: {
        serviceKey: service.key,
        environmentKey: service.environmentKey,
        environmentKind: service.environmentKind,
        capabilities: configuredCapabilities(service.deploymentConfig),
        ...(nacosScope ? { nacos: nacosScope } : {}),
        ...(dbScope ? { db: dbScope } : {}),
        ...(slsScope ? { sls: slsScope } : {}),
        ...(browserScope ? { browser: browserScope } : {}),
        ...(redisScope ? { redis: redisScope } : {}),
        ...(esScope ? { es: esScope } : {}),
        ...(mqScope ? { mq: mqScope } : {}),
        repositories: prepared.map(({ workspace }) => ({ codeAccess: worktreeMode === "detached" ? "read" : "write", repositoryPath: workspace.workspacePath, baseCommit: workspace.baseCommit })),
      },
    });
    await writeFile(path.join(workspaceRoot, ".issue-pilot.code-workspace"), JSON.stringify({
      folders: prepared.map(({ repository, workspace }) => ({ name: this.repositoryLabel(repository.url), path: path.relative(workspaceRoot, workspace.workspacePath) })),
      settings: {
        "git.autoRepositoryDetection": true,
        "files.watcherExclude": { "**/node_modules/**": true, "**/.git/objects/**": true },
        "search.exclude": { "**/node_modules": true },
      },
    }, null, 2), "utf8");
    let codeServerUrl: string | null = null;
    try {
      codeServerUrl = await this.codeServer.ensure(issue.key, workspaceRoot);
    } catch {
      codeServerUrl = null;
    }
    const [binding] = await this.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await exists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, binding.workspacePath)
      : SessionManager.create(workspaceRoot, sessionDirectory);
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");
    if (displayMessage && currentMessage) this.publishUserMessage(issue.id, manager, currentMessage);

    await this.disposeSession(issue.id);
    const managed = await this.createManagedSession(issue.id, workspaceRoot, policy, service.deploymentConfig, manager);
    managed.completion = null;
    this.sessions.set(issue.id, managed);
    const sessionFile = managed.session.sessionFile;
    if (!sessionFile) throw new Error("failed_to_create_agent_session");
    await chmod(sessionFile, 0o600);
    await this.db.insert(agentSessions).values({ issueId: issue.id, piSessionId: managed.session.sessionId, sessionFile, workspacePath: workspaceRoot }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { piSessionId: managed.session.sessionId, sessionFile, workspacePath: workspaceRoot, updatedAt: new Date() },
    });
    await this.db.update(issueWorkspaces).set({ status: "running", codeServerUrl, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    await this.db.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issue.id), ne(issues.status, "resolved")));

    const repositoryContexts = prepared.map(({ repository, workspace }) => ({ url: repository.url, branch: workspace.workingBranch ?? workspace.baseBranch, path: workspace.workspacePath, readOnly: worktreeMode === "detached" }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, currentMessage)
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}) });
    await managed.session.prompt(prompt);
    await this.finalizeRun(issue.id, issue.type, managed);

  }

  private async createManagedSession(issueId: string, workspaceRoot: string, policy: IssuePolicy, deploymentConfig: Record<string, unknown>, manager: SessionManager): Promise<ManagedSession> {
    const modelRuntime = await this.modelRuntime;
    const model = modelRuntime.getModel(policy.model.provider, policy.model.modelId);
    if (!model) throw new Error(`issue_pilot_model_not_found:${policy.model.provider}/${policy.model.modelId}`);

    const extension: InlineExtension = {
      name: "issue-pilot-runtime",
      factory: (pi) => registerIssuePilotExtension(pi, {
        policy,
        deploymentConfig: structuredClone(deploymentConfig),
        onComplete: async (completion) => {
          const current = this.sessions.get(issueId);
          if (current) current.completion = completion;
          await this.db.insert(issueAgentResults).values({
            issueId, outcome: completion.outcome, summary: completion.summary, rootCause: completion.rootCause ?? null,
            evidence: completion.evidence, changes: completion.changes, verification: completion.verification, risks: completion.risks, policyVersion: policy.version,
          }).onConflictDoUpdate({
            target: issueAgentResults.issueId,
            set: {
              outcome: completion.outcome, summary: completion.summary, rootCause: completion.rootCause ?? null,
              evidence: completion.evidence, changes: completion.changes, verification: completion.verification, risks: completion.risks,
              policyVersion: policy.version, updatedAt: new Date(),
            },
          });
        },
      }),
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      retry: { enabled: true, maxRetries: 3 },
    });
    const loader = new DefaultResourceLoader({
      cwd: workspaceRoot,
      agentDir: path.join(this.stateRoot, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
      systemPrompt: "You are the Issue Pilot engineering agent. Work only within the immutable issue run policy and finish by calling complete_issue.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: path.join(this.stateRoot, "agent"),
      modelRuntime,
      model,
      thinkingLevel: policy.model.thinkingLevel,
      sessionManager: manager,
      settingsManager,
      resourceLoader: loader,
      noTools: "builtin",
      tools: policy.tools,
    });
    const unsubscribe = session.subscribe((event) => {
      const createdAt = new Date().toISOString();
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n").trim();
        if (text) this.publish?.({ id: randomUUID(), issueId, kind: "assistant", message: text, createdAt });
      } else if (event.type === "tool_execution_start" && event.toolName !== "complete_issue") {
        this.publish?.({ id: randomUUID(), issueId, kind: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, arguments: event.args, createdAt });
      } else if (event.type === "tool_execution_end" && event.toolName !== "complete_issue") {
        this.publish?.({ id: randomUUID(), issueId, kind: "tool_result", toolCallId: event.toolCallId, toolName: event.toolName, result: { content: event.result.content, details: event.result.details }, isError: event.isError, createdAt });
      }
    });
    return { session, policy, completion: null, manager, unsubscribe };
  }

  private async promptExisting(issueId: string, managed: ManagedSession, message: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), ne(issues.status, "resolved")));
    });
    managed.completion = null;
    await managed.session.prompt(promptWithRuntimeTime(message));
    const [issue] = await this.db.select({ type: issues.type }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    await this.finalizeRun(issueId, issue.type, managed);
  }

  private async finalizeRun(issueId: string, issueType: string, managed: ManagedSession): Promise<void> {
    if (!managed.completion) throw new Error("issue_result_not_submitted");
    if (issueType === "smart_analysis") {
      const classifiedType = this.classifiedType(managed.session.messages);
      if (classifiedType) await this.db.update(issues).set({ type: classifiedType, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issueId));
    }
    await this.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "pending", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
    });
    this.publishStatus(issueId, "complete");
  }

  private async disposeSession(issueId: string): Promise<void> {
    const managed = this.sessions.get(issueId);
    if (!managed) return;
    this.sessions.delete(issueId);
    if (managed.session.isStreaming) await managed.session.abort();
    managed.unsubscribe();
    managed.session.dispose();
  }

  private modelScope(config: Record<string, unknown>): IssuePolicy["model"] {
    const configured = config.agent;
    const value = configured && typeof configured === "object" ? configured as Record<string, unknown> : {};
    const provider = typeof value.provider === "string" && value.provider ? value.provider : process.env.ISSUE_PILOT_PROVIDER ?? process.env.PI_PROVIDER;
    const modelId = typeof value.model === "string" && value.model ? value.model : process.env.ISSUE_PILOT_MODEL ?? process.env.PI_MODEL;
    if (!provider || !modelId) throw new Error("issue_pilot_model_not_configured");
    return { provider, modelId, thinkingLevel: this.thinkingLevel(typeof value.thinkingLevel === "string" ? value.thinkingLevel : process.env.ISSUE_PILOT_REASONING ?? process.env.PI_REASONING_LEVEL) };
  }

  private nacosScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string; serverUrl: string; namespace: string; group: string } | undefined {
    const value = config.nacos;
    if (!value || typeof value !== "object") return undefined;
    const scope = value as Record<string, unknown>;
    if (typeof scope.serverUrl !== "string" || typeof scope.namespace !== "string" || typeof scope.group !== "string") return undefined;
    return { deploymentId, serverUrl: scope.serverUrl, namespace: scope.namespace, group: scope.group };
  }

  private dbScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string } | undefined {
    return config.db && typeof config.db === "object" ? { deploymentId } : undefined;
  }

  private slsScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string; region: string; project: string; logstores: string[] } | undefined {
    const value = config.sls;
    if (!value || typeof value !== "object") return undefined;
    const scope = value as Record<string, unknown>;
    if (typeof scope.region !== "string" || typeof scope.project !== "string" || !Array.isArray(scope.logstores) || !scope.logstores.every((entry) => typeof entry === "string")) return undefined;
    return { deploymentId, region: scope.region, project: scope.project, logstores: scope.logstores as string[] };
  }

  private redisScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string } | undefined {
    return config.redis && typeof config.redis === "object" ? { deploymentId } : undefined;
  }

  private esScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string } | undefined {
    return config.es && typeof config.es === "object" ? { deploymentId } : undefined;
  }

  private mqScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string; virtualHost: string } | undefined {
    const value = config.mq;
    if (!value || typeof value !== "object") return undefined;
    const scope = value as Record<string, unknown>;
    if (typeof scope.virtualHost !== "string") return undefined;
    return { deploymentId, virtualHost: scope.virtualHost };
  }

  private browserScope(deploymentId: string, config: Record<string, unknown>): { deploymentId: string; baseUrl: string } | undefined {
    const value = config.playwright;
    if (!value || typeof value !== "object") return undefined;
    const baseUrl = (value as Record<string, unknown>).baseUrl;
    if (typeof baseUrl !== "string") return undefined;
    let url: URL;
    try { url = new URL(baseUrl); } catch { return undefined; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
    return { deploymentId, baseUrl: url.href };
  }

  private publishUserMessage(issueId: string, manager: SessionManager, message: string): void {
    const id = manager.appendCustomEntry("issue-pilot-user", { message });
    this.publish?.({ id, issueId, kind: "user", message, createdAt: new Date().toISOString() });
  }

  private publishStatus(issueId: string, status: "complete" | "error"): void {
    this.publish?.({ id: randomUUID(), issueId, kind: "status", status, createdAt: new Date().toISOString() });
  }

  private repositoryLabel(url: string): string {
    const label = url.replace(/[?#].*$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "repository";
    return label.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "repository";
  }

  private thinkingLevel(value: string | undefined): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : "medium";
  }

  private classifiedType(messages: unknown[]): "incident" | "request" | "question" | undefined {
    const matches = [...JSON.stringify(messages).matchAll(/ISSUE_TYPE:\s*(incident|request|question)\b/gi)];
    return matches.at(-1)?.[1]?.toLowerCase() as "incident" | "request" | "question" | undefined;
  }

}
