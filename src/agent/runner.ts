import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { RunEvent } from "./events.ts";
import { prepareTerminalFiles } from "../workspace/terminal-files.ts";
import { CodeServer } from "../workspace/code-server.ts";
import { PtySessions } from "../workspace/pty.ts";
import type { openDatabase } from "../db/client.ts";
import {
  agentEvents,
  agentSessions,
  deploymentCapabilities,
  environments,
  issueComments,
  issueEvidence,
  issueHistory,
  issueRepositories,
  issueServiceModules,
  issueServices,
  issueWorkspaces,
  issues,
  serviceDeployments,
  serviceModules,
  serviceRelationModules,
  serviceRelations,
  serviceRepositories,
  services,
} from "../db/schema.ts";
import { Worktrees } from "../workspace/git.ts";
import { Coordinator } from "./coordinator.ts";

type Database = ReturnType<typeof openDatabase>["db"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface ScopeCandidate {
  serviceId: string;
  serviceKey: string;
  serviceName: string;
  serviceDescription: string;
  sourceServiceKeys: string[];
  wholeServiceAllowed: boolean;
  modules: Array<{ id: string; name: string; path: string; description: string }>;
}

export class Runner {
  private readonly queue = new Coordinator();
  private readonly runCounts = new Map<string, number>();
  private readonly worktrees: Worktrees;
  private readonly codeServer: CodeServer;
  private readonly stateRoot: string;
  private readonly db: Database;
  private readonly publish: ((event: RunEvent) => void) | undefined;
  private readonly ptys: PtySessions;

  constructor(db: Database, ptys: PtySessions, stateRoot = ".issue-pilot", publish?: (event: RunEvent) => void) {
    this.db = db;
    this.stateRoot = path.resolve(stateRoot);
    this.worktrees = new Worktrees(this.stateRoot);
    this.codeServer = new CodeServer(this.stateRoot);
    this.publish = publish;
    this.ptys = ptys;
  }

  enqueue(issueId: string, triggerCommentId?: string): void {
    this.schedule(issueId, () => this.run(issueId, triggerCommentId));
  }

  isRunning(issueId: string): boolean {
    return (this.runCounts.get(issueId) ?? 0) > 0;
  }

  async steerDirect(issueId: string, message: string, _behavior: "steer" | "followUp" = "followUp"): Promise<boolean> {
    return this.ptys.sendPrompt(issueId, message);
  }

  async abortDirect(issueId: string): Promise<boolean> {
    return this.ptys.abort(issueId);
  }

  enqueueDirect(issueId: string, message: string): void {
    this.schedule(issueId, () => this.run(issueId, undefined, message));
  }

  async getScopeCandidates(issueId: string): Promise<ScopeCandidate[]> {
    const [issue] = await this.db.select({ id: issues.id, environmentId: issues.environmentId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) return [];
    const [linkedServices, selectedModules] = await Promise.all([
      this.db.select({ id: services.id, key: services.key, name: services.name, description: services.description }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, issueId)),
      this.db.select({ serviceId: serviceModules.serviceId, id: serviceModules.id, name: serviceModules.name, path: serviceModules.path, description: serviceModules.description }).from(issueServiceModules).innerJoin(serviceModules, eq(issueServiceModules.moduleId, serviceModules.id)).where(eq(issueServiceModules.issueId, issueId)),
    ]);
    return this.loadExpandedScope(issue.id, issue.environmentId, linkedServices, selectedModules);
  }

  async getConversation(issueId: string): Promise<ConversationMessage[]> {
    const [binding] = await this.db.select().from(agentSessions).where(eq(agentSessions.issueId, issueId)).limit(1);
    if (!binding || !await exists(binding.sessionFile)) return [];
    const manager = SessionManager.open(binding.sessionFile, path.dirname(binding.sessionFile), binding.workspacePath);
    const entries = manager.buildContextEntries();
    const markerIndex = entries.findIndex((entry) => entry.type === "custom" && entry.customType === "issue-pilot-web-conversation");
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
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
    void this.queue.run(issueId, operation).catch(async (error) => {
      await this.db.update(issueWorkspaces).set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000),
        updatedAt: new Date(),
      }).where(eq(issueWorkspaces.issueId, issueId));
      await this.appendAgentEvent(issueId, "error", "pi 处理失败");
    }).finally(() => {
      const remaining = (this.runCounts.get(issueId) ?? 1) - 1;
      if (remaining > 0) this.runCounts.set(issueId, remaining);
      else this.runCounts.delete(issueId);
    });
  }

  private async run(issueId: string, triggerCommentId?: string, directMessage?: string): Promise<void> {
    const [issue] = await this.db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    await this.db.delete(agentEvents).where(eq(agentEvents.issueId, issue.id));
    await this.appendAgentEvent(issue.id, "status", "准备工单仓库");
    await this.db.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));

    const linkedServices = await this.db.select({
      id: services.id,
      key: services.key,
      name: services.name,
      description: services.description,
      deploymentId: serviceDeployments.id,
      baseBranch: serviceDeployments.baseBranch,
    }).from(issueServices)
      .innerJoin(services, eq(issueServices.serviceId, services.id))
      .innerJoin(serviceDeployments, eq(issueServices.deploymentId, serviceDeployments.id))
      .where(eq(issueServices.issueId, issue.id));
    const serviceIds = linkedServices.map((service) => service.id);
    const serviceById = new Map(linkedServices.map((service) => [service.id, service]));
    const [repositoryRows, selectedModuleRows, existingRepositoryRows] = await Promise.all([
      serviceIds.length ? this.db.select().from(serviceRepositories).where(inArray(serviceRepositories.serviceId, serviceIds)) : [],
      this.db.select({ serviceId: serviceModules.serviceId, id: serviceModules.id, name: serviceModules.name, path: serviceModules.path, description: serviceModules.description })
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
      baseBranch: string;
      modules: Array<{ serviceKey: string; serviceName: string; moduleName: string | null; modulePath: string | null; moduleDescription: string | null }>;
    }>();
    for (const repository of repositoryRows) {
      const service = serviceById.get(repository.serviceId);
      if (!service) continue;
      const selectedModules = modulesByService.get(service.id) ?? [];
      const scopes = selectedModules.length
        ? selectedModules.map((module) => ({ serviceKey: service.key, serviceName: service.name, moduleName: module.name, modulePath: module.path, moduleDescription: module.description }))
        : [{ serviceKey: service.key, serviceName: service.name, moduleName: null, modulePath: null, moduleDescription: null }];
      const baseBranch = service.baseBranch;
      const existing = repositoriesByUrl.get(repository.url);
      if (existing) {
        if (existing.baseBranch !== baseBranch) throw new Error("selected_services_repository_branch_conflict");
        existing.modules.push(...scopes);
      } else {
        repositoriesByUrl.set(repository.url, { repository, baseBranch, modules: scopes });
      }
    }
    const scopeCandidates = await this.loadExpandedScope(issue.id, issue.environmentId, linkedServices, selectedModuleRows);
    const candidateByService = new Map(scopeCandidates.map((candidate) => [candidate.serviceId, candidate]));
    const candidateRepositories = candidateByService.size && issue.environmentId
      ? await this.db.select({ repository: serviceRepositories, baseBranch: serviceDeployments.baseBranch })
        .from(serviceRepositories)
        .innerJoin(serviceDeployments, eq(serviceDeployments.serviceId, serviceRepositories.serviceId))
        .where(and(inArray(serviceRepositories.serviceId, [...candidateByService.keys()]), eq(serviceDeployments.environmentId, issue.environmentId)))
      : [];
    for (const { repository, baseBranch } of candidateRepositories) {
      const candidate = candidateByService.get(repository.serviceId)!;
      const scopes = candidate.wholeServiceAllowed
        ? [{ serviceKey: candidate.serviceKey, serviceName: candidate.serviceName, moduleName: null, modulePath: null, moduleDescription: null }]
        : candidate.modules.map((module) => ({ serviceKey: candidate.serviceKey, serviceName: candidate.serviceName, moduleName: module.name, modulePath: module.path, moduleDescription: module.description }));
      const existing = repositoriesByUrl.get(repository.url);
      if (existing) {
        if (existing.baseBranch !== baseBranch) throw new Error("selected_services_repository_branch_conflict");
        existing.modules.push(...scopes);
      } else repositoriesByUrl.set(repository.url, { repository, baseBranch, modules: scopes });
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

    const prepared: Array<{
      repository: (typeof repositoryRows)[number];
      workspace: Awaited<ReturnType<Worktrees["prepare"]>>;
      modules: (typeof repositories)[number]["modules"];
    }> = [];
    for (const { repository, baseBranch, modules } of repositories) {
      const existingRepository = existingRepositoryByUrl.get(repository.url);
      const workspace = await this.worktrees.prepare({
        issueId: issue.key,
        repositoryId: repository.id,
        url: repository.url,
        baseBranch: existingRepository?.baseBranch ?? baseBranch,
        ...(existingRepository?.workingBranch ? { workingBranch: existingRepository.workingBranch } : {}),
        ...(existingRepository?.localPath ? { existingWorkspacePath: existingRepository.localPath } : {}),
        ...(existingRepository?.commitBefore ? { existingBaseCommit: existingRepository.commitBefore } : {}),
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
          commitBefore: existingRepository?.commitBefore ?? workspace.baseCommit,
          updatedAt: new Date(),
        },
      });
    }

    const workspaceRoot = path.resolve(this.stateRoot, "workspaces", issue.key.toLowerCase());
    const sessionDirectory = path.resolve(this.stateRoot, "sessions", issue.key);
    const capabilityDirectory = path.resolve(this.stateRoot, "capabilities");
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true });
    await mkdir(capabilityDirectory, { recursive: true, mode: 0o700 });
    const scopedServiceIds = [...new Set([...serviceIds, ...candidateByService.keys()])];
    const scopedDeployments = issue.environmentId && scopedServiceIds.length
      ? await this.db.select({
        id: serviceDeployments.id,
        serviceId: serviceDeployments.serviceId,
        serviceKey: services.key,
        environmentKey: environments.key,
        environmentKind: environments.kind,
      }).from(serviceDeployments)
        .innerJoin(services, eq(serviceDeployments.serviceId, services.id))
        .innerJoin(environments, eq(serviceDeployments.environmentId, environments.id))
        .where(and(inArray(serviceDeployments.serviceId, scopedServiceIds), eq(serviceDeployments.environmentId, issue.environmentId)))
      : [];
    const capabilityRows = scopedDeployments.length
      ? await this.db.select().from(deploymentCapabilities).where(inArray(deploymentCapabilities.deploymentId, scopedDeployments.map((deployment) => deployment.id)))
      : [];
    const capabilityServices = scopedDeployments.flatMap((deployment) => {
      const preparedRepository = prepared.find(({ modules }) => modules.some((module) => module.serviceKey === deployment.serviceKey));
      if (!preparedRepository) return [];
      return [{
        serviceKey: deployment.serviceKey,
        environmentKey: deployment.environmentKey,
        environmentKind: deployment.environmentKind,
        repositoryPath: preparedRepository.workspace.workspacePath,
        baseCommit: preparedRepository.workspace.baseCommit,
        modulePaths: preparedRepository.modules.filter((module) => module.serviceKey === deployment.serviceKey).flatMap((module) => module.modulePath ? [module.modulePath] : []),
        capabilities: capabilityRows.filter((row) => row.deploymentId === deployment.id).map((row) => row.capability),
      }];
    });
    const capabilityFile = path.join(capabilityDirectory, `${issue.key.toLowerCase()}.json`);
    await writeFile(capabilityFile, JSON.stringify({ issueKey: issue.key, services: capabilityServices }), { encoding: "utf8", mode: 0o600 });
    await chmod(capabilityFile, 0o600);
    await writeFile(path.join(workspaceRoot, ".issue-pilot.code-workspace"), JSON.stringify({
      folders: prepared.map(({ repository, workspace }) => ({ name: this.repositoryLabel(repository.url), path: path.relative(workspaceRoot, workspace.workspacePath) })),
      settings: {
        "git.autoRepositoryDetection": true,
        "files.watcherExclude": { "**/node_modules/**": true, "**/.git/objects/**": true },
        "search.exclude": { "**/node_modules": true },
      },
    }, null, 2), "utf8");
    await prepareTerminalFiles(issue.key, workspaceRoot);
    let codeServerUrl: string | null = null;
    try {
      codeServerUrl = await this.codeServer.ensure(issue.key, workspaceRoot);
      await this.appendAgentEvent(issue.id, "workspace", "code-server 工作区已就绪");
    } catch {
      await this.appendAgentEvent(issue.id, "error", "code-server 工作区启动失败");
    }
    const [binding] = await this.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await exists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, binding.workspacePath)
      : SessionManager.create(workspaceRoot, sessionDirectory);
    const directConversation = directMessage !== undefined;
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");
    if (!this.ptys.has(issue.id) && !manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "issue-pilot-web-conversation")) {
      manager.appendCustomEntry("issue-pilot-web-conversation", { startedAt: new Date().toISOString() });
    }

    await this.appendAgentEvent(issue.id, "session", binding ? "恢复持久化 pi session" : "创建持久化 pi session");
    const provider = process.env.ISSUE_PILOT_PROVIDER ?? process.env.PI_PROVIDER;
    const model = process.env.ISSUE_PILOT_MODEL ?? process.env.PI_MODEL;
    if (!provider || !model) throw new Error("issue_pilot_model_not_configured");
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_create_agent_session");
    await this.db.insert(agentSessions).values({
      issueId: issue.id,
      piSessionId: manager.getSessionId(),
      sessionFile,
      workspacePath: workspaceRoot,
    }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { piSessionId: manager.getSessionId(), sessionFile, workspacePath: workspaceRoot, updatedAt: new Date() },
    });
    await this.db.update(issueWorkspaces).set({ status: "running", codeServerUrl, branchCreated: true, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    if (!directConversation) await this.db.update(issues).set({ status: "in_progress", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(eq(issues.id, issue.id));

    const [triggerComment] = triggerCommentId
      ? await this.db.select().from(issueComments).where(and(eq(issueComments.id, triggerCommentId), eq(issueComments.issueId, issue.id))).limit(1)
      : [];
    if (triggerCommentId && !triggerComment) throw new Error("issue_comment_not_found");

    const serviceContexts = [...linkedServices, ...scopeCandidates.map((candidate) => ({ id: candidate.serviceId, key: candidate.serviceKey, name: candidate.serviceName, description: candidate.serviceDescription }))];
    const repositoryContexts = prepared.map(({ repository, workspace, modules }) => ({ url: repository.url, branch: workspace.workingBranch, path: workspace.workspacePath, modules }));
    const latestMessage = directMessage ?? triggerComment?.body;
    const prompt = hadMessages
      ? this.continuationPrompt(issue.key, repositoryContexts, latestMessage)
      : this.prompt(issue.key, issue.title, issue.description, issue.type, repositoryContexts, serviceContexts, latestMessage);

    await this.appendAgentEvent(issue.id, "agent", "pi CLI 已在交互终端启动");
    await this.ptys.execute({ issueId: issue.id, issueKey: issue.key, sessionFile, workspacePath: workspaceRoot }, {
      prompt,
      provider,
      model,
      thinking: this.thinkingLevel(process.env.ISSUE_PILOT_REASONING ?? process.env.PI_REASONING_LEVEL),
    });
    await this.appendAgentEvent(issue.id, "agent", "pi CLI 已完成当前处理并等待交互");

    const completedManager = SessionManager.open(sessionFile, sessionDirectory, workspaceRoot);
    const messages = completedManager.buildContextEntries().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    if (!directConversation && issue.type === "smart_analysis") {
      const classifiedType = this.classifiedType(messages);
      if (classifiedType) await this.db.update(issues).set({ type: classifiedType, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    }
    const answer = this.assistantText(messages);
    if (!directConversation && answer) await this.db.insert(issueComments).values({ issueId: issue.id, authorSubject: "issue-pilot", body: answer });
    await this.appendAgentEvent(issue.id, "complete", directConversation ? "pi 回答已保存到 session" : "回答已写入工单");
    if (!directConversation) await this.db.insert(issueEvidence).values({
      issueId: issue.id,
      source: "code",
      summary: triggerComment ? "智能体已回复工单对话。" : "智能体已完成首轮代码分析、处理与验证。",
      createdBy: "issue-pilot",
    });
    await this.db.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
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
    const [event] = await this.db.insert(agentEvents).values({ issueId, kind: kind.slice(0, 50), message: message.slice(0, 500) }).returning();
    if (event) this.publish?.({ id: event.id, issueId: event.issueId, kind: event.kind, message: event.message, createdAt: event.createdAt.toISOString() });
  }

  private repositoryLabel(url: string): string {
    const label = url.replace(/[?#].*$/, "").replace(/\.git$/, "").split(/[/:]/).filter(Boolean).at(-1) ?? "repository";
    return label.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "repository";
  }

  private thinkingLevel(value: string | undefined): string {
    return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : "medium";
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

  private async loadExpandedScope(
    issueId: string,
    environmentId: string | null,
    linkedServices: Array<{ id: string; key: string; name: string; description?: string }>,
    selectedModules: Array<{ serviceId: string; id: string; name: string; path: string; description?: string }>,
  ): Promise<ScopeCandidate[]> {
    const expandedServices = new Map(linkedServices.map((service) => [service.id, service]));
    const modulesByService = new Map<string, Map<string, (typeof selectedModules)[number]>>();
    for (const module of selectedModules) {
      const modules = modulesByService.get(module.serviceId) ?? new Map();
      modules.set(module.id, module);
      modulesByService.set(module.serviceId, modules);
    }
    const discovered = new Map<string, ScopeCandidate>();
    for (let depth = 0; depth < 100; depth += 1) {
      const candidates = await this.loadScopeCandidates(environmentId, [...expandedServices.values()], [...modulesByService.values()].flatMap((modules) => [...modules.values()]));
      let changed = false;
      for (const candidate of candidates) {
        const externalSourceKeys = candidate.sourceServiceKeys.filter((key) => key !== candidate.serviceKey);
        const previous = discovered.get(candidate.serviceId);
        if (!previous) discovered.set(candidate.serviceId, { ...candidate, sourceServiceKeys: externalSourceKeys, modules: [...candidate.modules] });
        else {
          previous.sourceServiceKeys = [...new Set([...previous.sourceServiceKeys, ...externalSourceKeys])].sort();
          previous.wholeServiceAllowed ||= candidate.wholeServiceAllowed;
          const modules = new Map(previous.modules.map((module) => [module.id, module]));
          for (const module of candidate.modules) modules.set(module.id, module);
          previous.modules = [...modules.values()].sort((left, right) => left.path.localeCompare(right.path));
        }
        if (!expandedServices.has(candidate.serviceId)) {
          expandedServices.set(candidate.serviceId, { id: candidate.serviceId, key: candidate.serviceKey, name: candidate.serviceName, description: candidate.serviceDescription });
          changed = true;
        }
        if (candidate.wholeServiceAllowed) {
          if (modulesByService.delete(candidate.serviceId)) changed = true;
        } else if (!modulesByService.has(candidate.serviceId)) {
          modulesByService.set(candidate.serviceId, new Map(candidate.modules.map((module) => [module.id, { serviceId: candidate.serviceId, id: module.id, name: module.name, path: module.path, description: module.description }])));
          changed = candidate.modules.length > 0 || changed;
        } else {
          const selected = modulesByService.get(candidate.serviceId)!;
          for (const module of candidate.modules) {
            if (!selected.has(module.id)) {
              selected.set(module.id, { serviceId: candidate.serviceId, id: module.id, name: module.name, path: module.path, description: module.description });
              changed = true;
            }
          }
        }
      }
      if (!changed) break;
    }
    return [...discovered.values()].sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  }

  private async loadScopeCandidates(
    environmentId: string | null,
    linkedServices: Array<{ id: string; key: string; name: string; description?: string }>,
    selectedModules: Array<{ serviceId: string; id: string; name: string; path: string }>,
  ): Promise<ScopeCandidate[]> {
    if (!environmentId || !linkedServices.length) return [];
    const sourceServiceIds = linkedServices.map((service) => service.id);
    const selectedByService = new Map<string, Set<string>>();
    for (const module of selectedModules) {
      const selected = selectedByService.get(module.serviceId) ?? new Set<string>();
      selected.add(module.id);
      selectedByService.set(module.serviceId, selected);
    }
    const serviceLevelRelations = await this.db.select().from(serviceRelations).where(inArray(serviceRelations.sourceServiceId, sourceServiceIds));
    const targetServiceIds = [...new Set(serviceLevelRelations.map((relation) => relation.targetServiceId))];
    if (!targetServiceIds.length) return [];
    const [targets, serviceLevelModules, targetModules] = await Promise.all([
      this.db.select({ id: services.id, key: services.key, name: services.name, description: services.description })
        .from(services)
        .innerJoin(serviceDeployments, eq(serviceDeployments.serviceId, services.id))
        .where(and(inArray(services.id, targetServiceIds), eq(serviceDeployments.environmentId, environmentId))),
      this.db.select().from(serviceRelationModules).where(inArray(serviceRelationModules.sourceServiceId, sourceServiceIds)),
      this.db.select().from(serviceModules).where(inArray(serviceModules.serviceId, targetServiceIds)),
    ]);
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const sourceById = new Map(linkedServices.map((service) => [service.id, service]));
    const currentServiceIds = new Set(sourceServiceIds);
    const wholeServiceIds = new Set(linkedServices.filter((service) => !selectedByService.has(service.id)).map((service) => service.id));
    const modulesByTarget = new Map<string, typeof targetModules>();
    for (const module of targetModules) modulesByTarget.set(module.serviceId, [...(modulesByTarget.get(module.serviceId) ?? []), module]);
    const candidates = new Map<string, { sourceKeys: Set<string>; wholeServiceAllowed: boolean; moduleIds: Set<string> }>();
    const addModule = (serviceId: string, moduleId: string, sourceKey: string) => {
      if (!targetById.has(serviceId) || wholeServiceIds.has(serviceId) || selectedByService.get(serviceId)?.has(moduleId)) return;
      const candidate = candidates.get(serviceId) ?? { sourceKeys: new Set<string>(), wholeServiceAllowed: false, moduleIds: new Set<string>() };
      candidate.sourceKeys.add(sourceKey);
      candidate.moduleIds.add(moduleId);
      candidates.set(serviceId, candidate);
    };
    for (const relation of serviceLevelRelations) {
      if (!targetById.has(relation.targetServiceId) || wholeServiceIds.has(relation.targetServiceId)) continue;
      const sourceKey = sourceById.get(relation.sourceServiceId)?.key;
      if (!sourceKey) continue;
      const configuredModules = serviceLevelModules.filter((module) => module.sourceServiceId === relation.sourceServiceId && module.targetServiceId === relation.targetServiceId);
      if (!configuredModules.length && !currentServiceIds.has(relation.targetServiceId)) {
        const candidate = candidates.get(relation.targetServiceId) ?? { sourceKeys: new Set<string>(), wholeServiceAllowed: false, moduleIds: new Set<string>() };
        candidate.sourceKeys.add(sourceKey);
        candidate.wholeServiceAllowed = true;
        candidates.set(relation.targetServiceId, candidate);
      } else {
        for (const module of configuredModules) addModule(relation.targetServiceId, module.moduleId, sourceKey);
      }
    }
    return [...candidates.entries()].map(([serviceId, candidate]) => {
      const service = targetById.get(serviceId)!;
      const availableModules = modulesByTarget.get(serviceId) ?? [];
      const modules = (candidate.wholeServiceAllowed ? availableModules : availableModules.filter((module) => candidate.moduleIds.has(module.id)))
        .map((module) => ({ id: module.id, name: module.name, path: module.path, description: module.description }))
        .sort((left, right) => left.path.localeCompare(right.path));
      return { serviceId, serviceKey: service.key, serviceName: service.name, serviceDescription: service.description, sourceServiceKeys: [...candidate.sourceKeys].sort(), wholeServiceAllowed: candidate.wholeServiceAllowed, modules };
    }).sort((left, right) => left.serviceKey.localeCompare(right.serviceKey));
  }

  private continuationPrompt(issueKey: string, repositories: Array<{
    url: string;
    branch: string;
    path: string;
    modules: Array<{ serviceKey: string; serviceName: string; moduleName: string | null; modulePath: string | null; moduleDescription: string | null }>;
  }>, userMessage?: string): string {
    return [
      `Continue handling engineering issue ${issueKey} in the existing persistent session.`,
      ...(userMessage ? ["", "Latest user message:", userMessage] : []),
      "",
      "Current prepared repository scope:",
      ...repositories.map((repository) => [
        `- ${repository.url}`,
        `  workspace: ${repository.path}`,
        `  branch: ${repository.branch}`,
        ...repository.modules.map((module) => `  - ${module.serviceKey} (${module.serviceName})${module.moduleName ? ` / ${module.moduleName}` : ""}: ${module.modulePath ?? ". (repository root)"}`),
      ].join("\n")),
      "",
      "Use the project descriptions and investigation findings already present in this session. Re-read repository files only where the latest message or refreshed scope requires it.",
      "Never push commits or branches to any remote, and do not expose credentials or raw logs. Return bounded database_read query results verbatim when they are relevant to the issue.",
    ].join("\n");
  }

  private prompt(issueKey: string, title: string, description: string, issueType: string, repositories: Array<{
    url: string;
    branch: string;
    path: string;
    modules: Array<{ serviceKey: string; serviceName: string; moduleName: string | null; modulePath: string | null; moduleDescription: string | null }>;
  }>, serviceContexts: Array<{ key: string; name: string; description?: string }>, userMessage?: string): string {
    return [
      userMessage ? `Continue handling engineering issue ${issueKey} and answer the latest user message.` : `Handle engineering issue ${issueKey}: ${title}`,
      `Configured issue type: ${issueType}`,
      ...(issueType === "smart_analysis" ? [
        "First classify this issue as exactly one of: incident (defect fix), request (temporary requirement), task (data processing), problem (root-cause investigation), or question (technical consultation). Then follow the corresponding handling approach. In the final response, write the classification marker named ISSUE_TYPE followed by a colon and the selected lowercase value.",
      ] : []),
      "",
      "Issue description:",
      description || "No description was provided.",
      "",
      "Service context (required reading before investigating or changing a module):",
      ...serviceContexts.map((service) => `- ${service.key} (${service.name})\n${service.description?.trim() || "  No service description was provided."}`),
      ...(userMessage ? ["", "Latest user message:", userMessage, "", "Answer the latest user message directly after using the issue session and repository context as needed."] : []),
      "",
      "Prepared repositories:",
      ...repositories.map((repository) => [
        `- ${repository.url}`,
        `  workspace: ${repository.path}`,
        `  branch: ${repository.branch}`,
        "  service module scopes:",
        ...repository.modules.map((module) => [
          `    - ${module.serviceKey} (${module.serviceName})${module.moduleName ? ` / ${module.moduleName}` : ""}: ${module.modulePath ?? ". (repository root)"}`,
          ...(module.moduleDescription?.trim() ? [`      module context: ${module.moduleDescription.trim()}`] : []),
        ].join("\n")),
      ].join("\n")),
      "",
      "The prepared repositories include the full configured dependency chain for this issue. Focus code search, edits, builds, and tests on the listed service module scopes and ignore retired workspace directories.",
      "Inspect the relevant code and establish the cause before editing. If the cause is a code-logic defect, implement the smallest correct fix in the prepared local issue branch and run appropriate tests. The branch is based on the latest origin/prod when that branch exists.",
      "Never push commits or branches to any remote, never create a merge request, and never run git push. Keep every code change local in the prepared issue branch for human review.",
      "Do not expose credentials or raw production logs. Return bounded database_read query results verbatim when they are relevant to the issue. Focus changes on the configured issue scope and preserve unrelated user changes.",
    ].join("\n");
  }
}
