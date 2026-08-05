import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, eq, notInArray, sql } from "drizzle-orm";
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
  issueAttachments,
  issueRepositories,
  issueWorkspaces,
  issues,
  serviceDeployments,
  serviceRepositories,
  services,
} from "../db/schema.ts";
import { Worktrees } from "../workspace/git.ts";
import { createIssuePolicy } from "../pi/policy.ts";
import { Coordinator } from "./coordinator.ts";
import { continuationPrompt, initialPrompt } from "./prompts.ts";

type Database = ReturnType<typeof openDatabase>["db"];

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

  enqueue(issueId: string, latestMessage?: string): void {
    this.schedule(issueId, () => this.run(issueId, latestMessage));
  }

  isRunning(issueId: string): boolean {
    return (this.runCounts.get(issueId) ?? 0) > 0;
  }

  async invalidatePolicy(issueId: string): Promise<boolean> {
    return this.ptys.releaseDetached(issueId);
  }

  async getTerminalTranscript(issueId: string) {
    const [binding] = await this.db.select().from(agentSessions).where(eq(agentSessions.issueId, issueId)).limit(1);
    return binding ? this.ptys.readTranscript(binding.sessionFile) : null;
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
    void this.queue.run(issueId, operation).catch(async (error) => {
      await this.db.transaction(async (transaction) => {
        await transaction.update(issueWorkspaces).set({
          status: "failed",
          lastError: error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000),
          updatedAt: new Date(),
        }).where(eq(issueWorkspaces.issueId, issueId));
        await transaction.update(issues).set({ status: "failed", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), notInArray(issues.status, ["resolved", "closed"])));
      });
      await this.appendAgentEvent(issueId, "error", "pi 处理失败");
    }).finally(() => {
      const remaining = (this.runCounts.get(issueId) ?? 1) - 1;
      if (remaining > 0) this.runCounts.set(issueId, remaining);
      else this.runCounts.delete(issueId);
    });
  }

  private async run(issueId: string, latestMessage?: string): Promise<void> {
    const [issue] = await this.db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    await this.db.delete(agentEvents).where(eq(agentEvents.issueId, issue.id));
    await this.appendAgentEvent(issue.id, "status", "准备工单仓库");
    await this.db.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));

    const [service] = await this.db.select({
      id: services.id,
      key: services.key,
      name: services.name,
      description: services.description,
      deploymentId: serviceDeployments.id,
      baseBranch: serviceDeployments.baseBranch,
      environmentKey: environments.key,
      environmentKind: environments.kind,
    }).from(services)
      .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, issue.environmentId)))
      .innerJoin(environments, eq(environments.id, issue.environmentId))
      .where(eq(services.id, issue.serviceId))
      .limit(1);
    if (!service) throw new Error("issue_service_deployment_not_found");
    if (service.environmentKind !== "production" && service.environmentKind !== "test") throw new Error("unsupported_issue_environment_kind");

    const [repositoryRows, existingRepositoryRows, capabilityRows, attachmentRows] = await Promise.all([
      this.db.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id)),
      this.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
      this.db.select().from(deploymentCapabilities).where(eq(deploymentCapabilities.deploymentId, service.deploymentId)),
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
        baseBranch: existingRepository?.baseBranch ?? service.baseBranch,
        ...(existingRepository?.workingBranch ? { workingBranch: existingRepository.workingBranch } : {}),
        ...(existingRepository?.localPath ? { existingWorkspacePath: existingRepository.localPath } : {}),
        ...(existingRepository?.commitBefore ? { existingBaseCommit: existingRepository.commitBefore } : {}),
      });
      prepared.push({ repository, workspace });
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
    const policy = createIssuePolicy({
      issueKey: issue.key,
      issueType: issue.type,
      workspaceRoot,
      attachments: attachmentRows.map((attachment) => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size, sha256: attachment.sha256, attachmentPath: attachment.objectKey })),
      service: {
        serviceKey: service.key,
        environmentKey: service.environmentKey,
        environmentKind: service.environmentKind,
        capabilities: capabilityRows.map((row) => row.capability),
        repositories: prepared.map(({ workspace }) => ({ codeAccess: "write", repositoryPath: workspace.workspacePath, baseCommit: workspace.baseCommit })),
      },
    });
    const serializedPolicy = JSON.stringify(policy);
    const policyHash = createHash("sha256").update(serializedPolicy).digest("hex");
    const capabilityFile = path.join(capabilityDirectory, `${issue.key.toLowerCase()}.json`);
    await writeFile(capabilityFile, serializedPolicy, { encoding: "utf8", mode: 0o600 });
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
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");

    await this.appendAgentEvent(issue.id, "session", binding ? "恢复持久化 pi session" : "创建持久化 pi session");
    const provider = process.env.ISSUE_PILOT_PROVIDER ?? process.env.PI_PROVIDER;
    const model = process.env.ISSUE_PILOT_MODEL ?? process.env.PI_MODEL;
    if (!provider || !model) throw new Error("issue_pilot_model_not_configured");
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_create_agent_session");
    await chmod(sessionFile, 0o600);
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
    await this.db.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issue.id), notInArray(issues.status, ["resolved", "closed"])));

    const repositoryContexts = prepared.map(({ repository, workspace }) => ({ url: repository.url, branch: workspace.workingBranch, path: workspace.workspacePath }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, latestMessage)
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, ...(latestMessage !== undefined ? { latestUpdate: latestMessage } : {}) });

    await this.appendAgentEvent(issue.id, "agent", "pi CLI 已在交互终端启动");
    await this.ptys.execute({ issueId: issue.id, issueKey: issue.key, sessionFile, workspacePath: workspaceRoot, policyHash, tools: policy.tools }, {
      prompt,
      provider,
      model,
      thinking: this.thinkingLevel(process.env.ISSUE_PILOT_REASONING ?? process.env.PI_REASONING_LEVEL),
    });
    await this.appendAgentEvent(issue.id, "agent", "pi CLI 已完成当前处理并等待交互");

    const completedManager = SessionManager.open(sessionFile, sessionDirectory, workspaceRoot);
    const messages = completedManager.buildContextEntries().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    if (issue.type === "smart_analysis") {
      const classifiedType = this.classifiedType(messages);
      if (classifiedType) await this.db.update(issues).set({ type: classifiedType, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    }
    await this.appendAgentEvent(issue.id, "complete", "pi 已完成当前处理");
    await this.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
      await transaction.update(issues).set({ status: "pending", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issue.id), eq(issues.status, "in_progress")));
    });
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

  private classifiedType(messages: unknown[]): "incident" | "request" | "question" | undefined {
    const matches = [...JSON.stringify(messages).matchAll(/ISSUE_TYPE:\s*(incident|request|question)\b/gi)];
    return matches.at(-1)?.[1]?.toLowerCase() as "incident" | "request" | "question" | undefined;
  }

}
