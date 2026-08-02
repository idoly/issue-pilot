import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { createAgentSession, type AgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { PublicAgentEvent } from "./agent-event-broker.ts";
import { prepareCodeTerminalFiles } from "./code-terminal-files.ts";
import { CodeServerWorkspaceManager } from "./code-server-workspaces.ts";
import type { createDatabase } from "./db/client.ts";
import {
  issueAgentEvents,
  issueAgentSessions,
  issueComments,
  issueEvidence,
  issueRepositories,
  issueServiceModules,
  issueServices,
  issueWorkspaces,
  issues,
  serviceModules,
  serviceRepositories,
  services,
} from "./db/schema.ts";
import { GitWorkspaceManager } from "./git-workspaces.ts";
import { IssueRunCoordinator } from "./session-service.ts";

type Database = ReturnType<typeof createDatabase>["db"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface PiConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export class DatabaseIssueAgentRunner {
  private readonly coordinator = new IssueRunCoordinator();
  private readonly activeSessions = new Map<string, AgentSession>();
  private readonly scheduledRuns = new Map<string, number>();
  private readonly workspaces: GitWorkspaceManager;
  private readonly codeServerWorkspaces: CodeServerWorkspaceManager;
  private readonly stateRoot: string;
  private readonly db: Database;
  private modelRuntime?: ModelRuntime;
  private readonly publishEvent: ((event: PublicAgentEvent) => void) | undefined;

  constructor(db: Database, stateRoot = ".issue-agent", publishEvent?: (event: PublicAgentEvent) => void) {
    this.db = db;
    this.stateRoot = path.resolve(stateRoot);
    this.workspaces = new GitWorkspaceManager(this.stateRoot);
    this.codeServerWorkspaces = new CodeServerWorkspaceManager(this.stateRoot);
    this.publishEvent = publishEvent;
  }

  enqueue(issueId: string, triggerCommentId?: string): void {
    this.schedule(issueId, () => this.run(issueId, triggerCommentId));
  }

  isRunning(issueId: string): boolean {
    return (this.scheduledRuns.get(issueId) ?? 0) > 0;
  }

  async steerDirect(issueId: string, message: string, behavior: "steer" | "followUp" = "followUp"): Promise<boolean> {
    const session = this.activeSessions.get(issueId);
    if (!session?.isStreaming) return false;
    if (behavior === "followUp") await session.followUp(message);
    else await session.steer(message);
    return true;
  }

  async abortDirect(issueId: string): Promise<boolean> {
    const session = this.activeSessions.get(issueId);
    if (!session?.isStreaming) return false;
    await session.abort();
    return true;
  }

  enqueueDirect(issueId: string, message: string): void {
    this.schedule(issueId, () => this.run(issueId, undefined, message));
  }

  async getConversation(issueId: string): Promise<PiConversationMessage[]> {
    const [binding] = await this.db.select().from(issueAgentSessions).where(eq(issueAgentSessions.issueId, issueId)).limit(1);
    if (!binding || !await exists(binding.sessionFile)) return [];
    const manager = SessionManager.open(binding.sessionFile, path.dirname(binding.sessionFile), binding.workspacePath);
    const entries = manager.buildContextEntries();
    const markerIndex = entries.findIndex((entry) => entry.type === "custom" && entry.customType === "issue-agent-web-conversation");
    if (markerIndex < 0) return [];
    return entries.slice(markerIndex + 1).flatMap((entry) => {
      if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
      const content = entry.message.content;
      const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      if (!text.trim()) return [];
      return [{ id: entry.id, role: entry.message.role, text: this.redactAssistantText(text), createdAt: entry.timestamp }];
    });
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.scheduledRuns.set(issueId, (this.scheduledRuns.get(issueId) ?? 0) + 1);
    void this.coordinator.run(issueId, operation).catch(async (error) => {
      await this.db.update(issueWorkspaces).set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000),
        updatedAt: new Date(),
      }).where(eq(issueWorkspaces.issueId, issueId));
      await this.appendAgentEvent(issueId, "error", "pi 处理失败");
    }).finally(() => {
      const remaining = (this.scheduledRuns.get(issueId) ?? 1) - 1;
      if (remaining > 0) this.scheduledRuns.set(issueId, remaining);
      else this.scheduledRuns.delete(issueId);
    });
  }

  private async run(issueId: string, triggerCommentId?: string, directMessage?: string): Promise<void> {
    const [issue] = await this.db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    await this.db.delete(issueAgentEvents).where(eq(issueAgentEvents.issueId, issue.id));
    await this.appendAgentEvent(issue.id, "status", "准备工单仓库");
    await this.db.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));

    const linkedServices = await this.db.select({ id: services.id, key: services.key, name: services.name })
      .from(issueServices)
      .innerJoin(services, eq(issueServices.serviceId, services.id))
      .where(eq(issueServices.issueId, issue.id));
    const serviceIds = linkedServices.map((service) => service.id);
    const serviceById = new Map(linkedServices.map((service) => [service.id, service]));
    const [repositoryRows, selectedModuleRows, existingRepositoryRows] = await Promise.all([
      serviceIds.length ? this.db.select().from(serviceRepositories).where(inArray(serviceRepositories.serviceId, serviceIds)) : [],
      this.db.select({ serviceId: serviceModules.serviceId, id: serviceModules.id, name: serviceModules.name, path: serviceModules.path })
        .from(issueServiceModules)
        .innerJoin(serviceModules, eq(issueServiceModules.moduleId, serviceModules.id))
        .where(eq(issueServiceModules.issueId, issue.id)),
      this.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    const existingRepositoryByUrl = new Map(existingRepositoryRows.map((repository) => [repository.url, repository]));
    const modulesByService = new Map<string, typeof selectedModuleRows>();
    for (const module of selectedModuleRows) modulesByService.set(module.serviceId, [...(modulesByService.get(module.serviceId) ?? []), module]);
    const repositoriesByUrl = new Map<string, {
      repository: (typeof repositoryRows)[number];
      modules: Array<{ serviceKey: string; serviceName: string; moduleName: string | null; modulePath: string | null }>;
    }>();
    for (const repository of repositoryRows) {
      const service = serviceById.get(repository.serviceId);
      if (!service) continue;
      const selectedModules = modulesByService.get(service.id) ?? [];
      const scopes = selectedModules.length
        ? selectedModules.map((module) => ({ serviceKey: service.key, serviceName: service.name, moduleName: module.name, modulePath: module.path }))
        : [{ serviceKey: service.key, serviceName: service.name, moduleName: null, modulePath: null }];
      const existing = repositoriesByUrl.get(repository.url);
      if (existing) {
        if (existing.repository.defaultBranch !== repository.defaultBranch) throw new Error("selected_services_repository_branch_conflict");
        existing.modules.push(...scopes);
      } else {
        repositoriesByUrl.set(repository.url, { repository, modules: scopes });
      }
    }
    const repositories = [...repositoriesByUrl.values()];
    if (!repositories.length) {
      await this.db.delete(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      throw new Error("selected_services_have_no_repository");
    }
    await this.db.delete(issueRepositories).where(and(
      eq(issueRepositories.issueId, issue.id),
      notInArray(issueRepositories.url, repositories.map(({ repository }) => repository.url)),
    ));

    const prepared = [];
    for (const { repository, modules } of repositories) {
      const existingRepository = existingRepositoryByUrl.get(repository.url);
      const workspace = await this.workspaces.prepare({
        issueId: issue.key,
        repositoryId: repository.id,
        url: repository.url,
        baseBranch: repository.defaultBranch,
        preferredBaseBranch: "prod",
        ...(existingRepository?.workingBranch ? { workingBranch: existingRepository.workingBranch } : {}),
        ...(existingRepository?.localPath ? { existingWorkspacePath: existingRepository.localPath } : {}),
      });
      prepared.push({ repository, workspace, modules });
      await this.appendAgentEvent(issue.id, "repository", `仓库 ${this.repositoryLabel(repository.url)} 已就绪`);
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
          commitBefore: workspace.baseCommit,
          updatedAt: new Date(),
        },
      });
    }

    const workspaceRoot = path.resolve(this.stateRoot, "workspaces", issue.key.toLowerCase());
    const sessionDirectory = path.resolve(this.stateRoot, "sessions", issue.key);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(path.join(workspaceRoot, ".issue-pilot.code-workspace"), JSON.stringify({
      folders: prepared.map(({ repository, workspace }) => ({ name: this.repositoryLabel(repository.url), path: path.relative(workspaceRoot, workspace.workspacePath) })),
      settings: {
        "git.autoRepositoryDetection": true,
        "files.watcherExclude": { "**/node_modules/**": true, "**/.git/objects/**": true },
        "search.exclude": { "**/node_modules": true },
      },
    }, null, 2), "utf8");
    await prepareCodeTerminalFiles(issue.key, workspaceRoot);
    let codeServerUrl: string | null = null;
    try {
      codeServerUrl = await this.codeServerWorkspaces.ensure(issue.key, workspaceRoot);
      await this.appendAgentEvent(issue.id, "workspace", "code-server 工作区已就绪");
    } catch {
      await this.appendAgentEvent(issue.id, "error", "code-server 工作区启动失败");
    }
    const [binding] = await this.db.select().from(issueAgentSessions).where(eq(issueAgentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await exists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, binding.workspacePath)
      : SessionManager.create(workspaceRoot, sessionDirectory);
    const directConversation = directMessage !== undefined;
    if (directConversation && !manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "issue-agent-web-conversation")) {
      manager.appendCustomEntry("issue-agent-web-conversation", { startedAt: new Date().toISOString() });
    }

    await this.appendAgentEvent(issue.id, "session", binding ? "恢复持久化 pi session" : "创建持久化 pi session");
    const modelRuntime = await this.getModelRuntime();
    const provider = process.env.ISSUE_AGENT_PROVIDER ?? process.env.PI_PROVIDER;
    const modelId = process.env.ISSUE_AGENT_MODEL ?? process.env.PI_MODEL;
    const model = provider && modelId ? modelRuntime.getModel(provider, modelId) : undefined;
    if (!model) throw new Error("issue_agent_model_not_configured");
    const thinkingLevel = this.thinkingLevel(process.env.ISSUE_AGENT_REASONING ?? process.env.PI_REASONING_LEVEL);
    const { session } = await createAgentSession({
      cwd: workspaceRoot,
      agentDir: process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
      modelRuntime,
      model,
      thinkingLevel,
      sessionManager: manager,
    });
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      session.dispose();
      throw new Error("failed_to_create_agent_session");
    }
    await this.db.insert(issueAgentSessions).values({
      issueId: issue.id,
      piSessionId: manager.getSessionId(),
      sessionFile,
      workspacePath: workspaceRoot,
    }).onConflictDoUpdate({
      target: issueAgentSessions.issueId,
      set: { piSessionId: manager.getSessionId(), sessionFile, workspacePath: workspaceRoot, updatedAt: new Date() },
    });
    await this.db.update(issueWorkspaces).set({ status: "running", codeServerUrl, branchCreated: true, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    if (!directConversation) await this.db.update(issues).set({ status: "in_progress", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(eq(issues.id, issue.id));

    const [triggerComment] = triggerCommentId
      ? await this.db.select().from(issueComments).where(and(eq(issueComments.id, triggerCommentId), eq(issueComments.issueId, issue.id))).limit(1)
      : [];
    if (triggerCommentId && !triggerComment) throw new Error("issue_comment_not_found");

    let eventWrites: Promise<void> = Promise.resolve();
    const emit = (kind: string, message: string) => {
      eventWrites = eventWrites.then(() => this.appendAgentEvent(issue.id, kind, message));
    };
    let assistantBuffer = "";
    const flushAssistantLines = (flushAll = false) => {
      const boundary = flushAll ? assistantBuffer.length : assistantBuffer.lastIndexOf("\n") + 1;
      if (boundary <= 0) return;
      const text = assistantBuffer.slice(0, boundary);
      assistantBuffer = assistantBuffer.slice(boundary);
      this.publishTransientEvent(issue.id, "assistant_delta", this.redactAssistantText(text));
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") {
        this.publishTransientEvent(issue.id, "response_start", "");
        emit("agent", "pi agent 已启动");
      }
      else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        assistantBuffer += event.assistantMessageEvent.delta;
        flushAssistantLines();
      }
      else if (event.type === "turn_start") emit("turn", "开始模型处理轮次");
      else if (event.type === "tool_execution_start") emit("tool", `运行工具 ${this.toolLabel(event.toolName)}`);
      else if (event.type === "tool_execution_end") emit(event.isError ? "error" : "tool", `工具 ${this.toolLabel(event.toolName)} ${event.isError ? "失败" : "完成"}`);
      else if (event.type === "auto_retry_start") emit("retry", `模型请求重试 ${event.attempt}/${event.maxAttempts}`);
      else if (event.type === "agent_end") {
        flushAssistantLines(true);
        emit("agent", "pi agent 已完成处理");
      }
    });

    this.activeSessions.set(issue.id, session);
    try {
      await session.prompt(directMessage ?? this.prompt(issue.key, issue.title, issue.description, issue.type, prepared.map(({ repository, workspace, modules }) => ({ url: repository.url, branch: workspace.workingBranch, path: workspace.workspacePath, modules })), triggerComment?.body));
      if (!directConversation && issue.type === "smart_analysis") {
        const classifiedType = this.classifiedType(session.messages);
        if (classifiedType) await this.db.update(issues).set({ type: classifiedType, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      }
      const answer = this.assistantText(session.messages);
      if (!directConversation && answer) await this.db.insert(issueComments).values({ issueId: issue.id, authorSubject: "issue-agent", body: answer });
      emit("complete", directConversation ? "pi 回答已保存到 session" : "回答已写入工单");
      await eventWrites;
      if (!directConversation) await this.db.insert(issueEvidence).values({
        issueId: issue.id,
        source: "code",
        summary: triggerComment ? "智能体已回复工单对话。" : "智能体已完成首轮代码分析、处理与验证。",
        createdBy: "issue-agent",
      });
      await this.db.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    } finally {
      if (this.activeSessions.get(issue.id) === session) this.activeSessions.delete(issue.id);
      unsubscribe();
      await eventWrites;
      session.dispose();
    }
  }

  private publishTransientEvent(issueId: string, kind: string, message: string): void {
    this.publishEvent?.({ id: randomUUID(), issueId, kind, message, createdAt: new Date().toISOString() });
  }

  private redactAssistantText(text: string): string {
    return text
      .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .replace(/((?:password|passwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, "[REDACTED_JWT]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]")
      .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@");
  }

  private async appendAgentEvent(issueId: string, kind: string, message: string): Promise<void> {
    const [event] = await this.db.insert(issueAgentEvents).values({ issueId, kind: kind.slice(0, 50), message: message.slice(0, 500) }).returning();
    if (event) this.publishEvent?.({ id: event.id, issueId: event.issueId, kind: event.kind, message: event.message, createdAt: event.createdAt.toISOString() });
  }

  private repositoryLabel(url: string): string {
    const label = url.replace(/[?#].*$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "repository";
    return label.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "repository";
  }

  private toolLabel(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "tool";
  }

  private async getModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntime ??= await ModelRuntime.create({
      authPath: path.join(process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "auth.json"),
      modelsPath: path.join(process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "models.json"),
    });
    return this.modelRuntime;
  }

  private thinkingLevel(value: string | undefined): ThinkingLevel {
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : "medium";
  }

  private assistantText(messages: unknown[]): string {
    for (const message of [...messages].reverse()) {
      if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" || !("content" in message)) continue;
      const content = message.content;
      if (typeof content === "string") return content.trim();
      if (Array.isArray(content)) {
        const text = content.flatMap((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
        if (text) return text;
      }
    }
    return "";
  }

  private classifiedType(messages: unknown[]): "incident" | "request" | "task" | "problem" | "question" | undefined {
    const matches = [...JSON.stringify(messages).matchAll(/ISSUE_TYPE:\s*(incident|request|task|problem|question)\b/gi)];
    return matches.at(-1)?.[1]?.toLowerCase() as "incident" | "request" | "task" | "problem" | "question" | undefined;
  }

  private prompt(issueKey: string, title: string, description: string, issueType: string, repositories: Array<{
    url: string;
    branch: string;
    path: string;
    modules: Array<{ serviceKey: string; serviceName: string; moduleName: string | null; modulePath: string | null }>;
  }>, userMessage?: string): string {
    return [
      userMessage ? `Continue handling engineering issue ${issueKey} and answer the latest user message.` : `Handle engineering issue ${issueKey}: ${title}`,
      `Configured issue type: ${issueType}`,
      ...(issueType === "smart_analysis" ? [
        "First classify this issue as exactly one of: incident (defect fix), request (temporary requirement), task (data processing), problem (root-cause investigation), or question (technical consultation). Then follow the corresponding handling approach. In the final response, write the classification marker named ISSUE_TYPE followed by a colon and the selected lowercase value.",
      ] : []),
      "",
      "Issue description:",
      description || "No description was provided.",
      ...(userMessage ? ["", "Latest user message:", userMessage, "", "Answer the latest user message directly after using the issue session and repository context as needed."] : []),
      "",
      "Prepared repositories:",
      ...repositories.map((repository) => [
        `- ${repository.url}`,
        `  workspace: ${repository.path}`,
        `  branch: ${repository.branch}`,
        "  service module scopes:",
        ...repository.modules.map((module) => `    - ${module.serviceKey} (${module.serviceName})${module.moduleName ? ` / ${module.moduleName}` : ""}: ${module.modulePath ?? ". (repository root)"}`),
      ].join("\n")),
      "",
      "Only the repositories and service module scopes listed above belong to the current issue context. Focus code search, edits, builds, and tests on the configured module paths unless evidence requires inspecting a dependency. Ignore any retired workspace directories from earlier service selections.",
      "Inspect the relevant code and establish the cause before editing. If the cause is a code-logic defect, implement the smallest correct fix in the prepared local issue branch and run appropriate tests. The branch is based on the latest origin/prod when that branch exists.",
      "Never push commits or branches to any remote, never create a merge request, and never run git push. Keep every code change local in the prepared issue branch for human review.",
      "Do not expose credentials, raw production logs, or database rows. Focus changes on the configured issue scope and preserve unrelated user changes.",
    ].join("\n");
  }
}
