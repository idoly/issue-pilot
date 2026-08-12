import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import { and, eq, ne, notInArray } from "drizzle-orm";
import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { RunEvent } from "./events.ts";
import { createPrivateSessionManager, PiSessionRuntime, type ManagedPiSession } from "./pi-session.ts";
import { CodeServerManager } from "../workspace/code-server.ts";
import { loadDeploymentRepositories } from "../workspace/deployment.ts";
import { developmentWorktreeMode } from "../workspace/development.ts";
import { prepareProjectWrappers } from "../workspace/project-wrappers.ts";
import { assertManagedIssueWorkspaceLayout, classifyRepositoryState, issueAttachmentRoot, issueSessionRoot, issueWorkspaceRoot, pathExists } from "../workspace/state.ts";
import type { Database } from "../db/client.ts";
import {
  agentSessions,
  environments,
  issueRepositories,
  issueWorkspaces,
  issues,
  services,
} from "../db/schema.ts";
import { ENVIRONMENT_KINDS, errorMessage, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";
import { issueRepositoryWorkspaceNames, repositoryWorkspaceNames, WorktreeManager } from "../workspace/git.ts";
import { prepareIssueRuntime } from "../workspace/runtime.ts";
import { createDeploymentPolicy } from "../pi/policy.ts";
import { agentSystemPrompt, continuationPrompt, initialPrompt, promptWithRuntimeTime } from "./prompts.ts";


export interface AgentController {
  enqueue(issueId: string, message?: string, recordMessage?: boolean): void;
  send(issueId: string, message: string): Promise<void>;
  isRunning(issueId: string): boolean;
  closeSession(issueId: string): Promise<void>;
  close?(): Promise<void>;
}

class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.tails.get(key) ?? Promise.resolve();
    let complete!: () => void;
    const queued = new Promise<void>((resolve) => { complete = resolve; });
    const queueTail = preceding.catch(() => undefined).then(() => queued);
    this.tails.set(key, queueTail);
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      complete();
      if (this.tails.get(key) === queueTail) this.tails.delete(key);
    }
  }
}

export function repositoryPreparationMode(environmentKind: EnvironmentKind, issueType: IssueType): "shared" | "hotfix" | "feature" {
  return environmentKind === "dev" ? developmentWorktreeMode(issueType) : "shared";
}

export class AgentEngine implements AgentController {
  private readonly issueQueue = new KeyedSerialQueue();
  private readonly runCounts = new Map<string, number>();
  private readonly worktreeManager: WorktreeManager;
  private readonly codeServerManager: CodeServerManager;
  private readonly stateRoot: string;
  private readonly database: Database;
  private readonly publish: ((event: RunEvent) => void) | undefined;
  private readonly sessions = new Map<string, ManagedPiSession>();
  private readonly sharedReadOnlySessions = new Set<string>();
  private readonly piRuntime = new PiSessionRuntime();

  constructor(database: Database, stateRoot = ".issue-pilot", publish?: (event: RunEvent) => void) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.worktreeManager = new WorktreeManager(this.stateRoot);
    this.codeServerManager = new CodeServerManager(this.stateRoot);
    this.publish = publish;
  }

  enqueue(issueId: string, latestMessage?: string, displayMessage = false): void {
    this.schedule(issueId, () => this.run(issueId, latestMessage, displayMessage));
  }

  isRunning(issueId: string): boolean {
    return (this.runCounts.get(issueId) ?? 0) > 0;
  }

  async closeSession(issueId: string): Promise<void> {
    await this.stopSession(issueId);
  }

  async send(issueId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("agent_message_required");
    if (message.length > issuePilotConfig.limits.agentMessageChars) throw new Error("invalid_agent_message");
    const userMessage = message.trim();
    const managed = this.sessions.get(issueId);
    if (!managed || (this.sharedReadOnlySessions.has(issueId) && !managed.streaming)) {
      if (managed) await this.stopSession(issueId);
      this.enqueue(issueId, userMessage, true);
      return;
    }
    await this.recordUserMessage(issueId, managed, userMessage);
    if (managed.streaming) await managed.session.steer(promptWithRuntimeTime(userMessage));
    else this.schedule(issueId, () => this.promptExisting(issueId, managed, userMessage));
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((issueId) => this.stopSession(issueId)));
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
    void this.issueQueue.run(issueId, operation).catch(async (error) => {
      await this.stopSession(issueId).catch(() => undefined);
      try {
        await this.database.transaction(async (transaction) => {
          await transaction.update(issueWorkspaces).set({
            status: "failed",
            lastError: errorMessage(error),
            updatedAt: new Date(),
          }).where(eq(issueWorkspaces.issueId, issueId));
          await transaction.update(issues).set({ status: "open", updatedAt: new Date() }).where(and(eq(issues.id, issueId), ne(issues.status, "resolved")));
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
    const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
    const currentMessage = latestMessage?.trim() || undefined;
    await this.database.update(issueWorkspaces).set({ status: "preparing", codeServerReady: false, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));

    const [service] = await this.database.select({
      id: services.id,
      key: services.key,
      name: services.name,
      description: services.description,
      environmentKey: environments.key,
      environmentKind: environments.kind,
    }).from(services)
      .innerJoin(environments, eq(environments.id, issue.environmentId))
      .where(eq(services.id, issue.serviceId))
      .limit(1);
    if (!service) throw new Error("issue_service_not_found");
    if (!ENVIRONMENT_KINDS.includes(service.environmentKind as EnvironmentKind)) throw new Error("unsupported_issue_environment_kind");
    const environmentKind = service.environmentKind as EnvironmentKind;
    await this.stopSession(issue.id);

    const [{ deployment, repositories: repositoryRows }, existingRepositoryRows] = await Promise.all([
      loadDeploymentRepositories(this.database, { serviceId: service.id, environmentId: issue.environmentId }),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    const preparationMode = repositoryPreparationMode(environmentKind, issue.type);
    const sharedRepositories = preparationMode === "shared";
    const repositoryUrls = new Set(repositoryRows.map(({ repository }) => repository.url));
    const removedRepositories = existingRepositoryRows.filter((repository) => !repositoryUrls.has(repository.url));
    const existingRepositoryState = existingRepositoryRows.length ? classifyRepositoryState(existingRepositoryRows) : undefined;
    if (sharedRepositories && existingRepositoryState && existingRepositoryState !== "read_only") throw new Error("readonly_repository_state_invalid");
    if (!sharedRepositories && existingRepositoryState && existingRepositoryState !== "development_workspace") throw new Error("development_repository_state_invalid");

    const existingRepositoryByUrl = new Map(existingRepositoryRows.map((repository) => [repository.url, repository]));
    const existingWorkspaceNames = sharedRepositories ? new Map<string, string>() : issueRepositoryWorkspaceNames(existingRepositoryRows);
    if (!sharedRepositories && await pathExists(issueWorkspaceRoot(this.stateRoot, issue.key))) {
      await assertManagedIssueWorkspaceLayout(issueWorkspaceRoot(this.stateRoot, issue.key), existingRepositoryRows.map((repository) => repository.localPath!));
    }
    const workspaceNames = repositoryWorkspaceNames(repositoryRows.map(({ repository }) => repository.url), existingWorkspaceNames);
    const saveRepositoryRows = async (workspaces: Awaited<ReturnType<WorktreeManager["prepare"]>>[]) => {
      await this.database.transaction(async (transaction) => {
        for (const [index, { repository }] of repositoryRows.entries()) {
          const workspace = workspaces[index]!;
          const existingRepository = existingRepositoryByUrl.get(repository.url);
          const repositoryState = {
            baseBranch: workspace.baseBranch,
            workingBranch: workspace.workingBranch,
            localPath: sharedRepositories ? null : workspace.workspacePath,
            workspaceName: sharedRepositories ? null : workspaceNames.get(repository.url)!,
            commitBefore: sharedRepositories ? workspace.baseCommit : existingRepository?.commitBefore ?? workspace.baseCommit,
          };
          await transaction.insert(issueRepositories).values({ issueId: issue.id, url: repository.url, ...repositoryState }).onConflictDoUpdate({
            target: [issueRepositories.issueId, issueRepositories.url],
            set: { ...repositoryState, updatedAt: new Date() },
          });
        }
        if (removedRepositories.length) await transaction.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), notInArray(issueRepositories.url, [...repositoryUrls])));
      });
    };

    const prepared: Array<{ name: string; workspace: Awaited<ReturnType<WorktreeManager["prepare"]>> }> = [];
    if (sharedRepositories) {
      for (const { repository, baseBranch } of repositoryRows) {
        prepared.push({ name: workspaceNames.get(repository.url)!, workspace: await this.worktreeManager.prepareShared({ url: repository.url, baseBranch }) });
      }
      await saveRepositoryRows(prepared.map(({ workspace }) => workspace));
    } else {
      const mode = developmentWorktreeMode(issue.type);
      const worktreeInputs = repositoryRows.map(({ repository, baseBranch }) => {
        const existingRepository = existingRepositoryByUrl.get(repository.url);
        return {
          issueKey: issue.key,
          workspaceName: workspaceNames.get(repository.url)!,
          url: repository.url,
          baseBranch: existingRepository?.baseBranch ?? baseBranch,
          mode,
          ...(existingRepository?.workingBranch ? { workingBranch: existingRepository.workingBranch } : {}),
          ...(existingRepository?.localPath ? { existingWorkspacePath: existingRepository.localPath } : {}),
          ...(existingRepository?.commitBefore ? { existingBaseCommit: existingRepository.commitBefore } : {}),
        };
      });
      const preparedWorktrees = await this.worktreeManager.prepareBatch({
        worktrees: worktreeInputs,
        finalize: async (workspaces) => {
          if (removedRepositories.length) {
            await this.worktreeManager.removeBatch({
              issueKey: issue.key,
              mode,
              worktrees: removedRepositories.map((repository) => ({
                workspaceName: existingWorkspaceNames.get(repository.url)!,
                url: repository.url,
                workingBranch: repository.workingBranch!,
                workspacePath: repository.localPath!,
              })),
              finalize: () => saveRepositoryRows(workspaces),
            });
          } else {
            await saveRepositoryRows(workspaces);
          }
          return workspaces;
        },
      });
      prepared.push(...preparedWorktrees.map((workspace, index) => ({ name: workspaceNames.get(repositoryRows[index]!.repository.url)!, workspace })));
    }

    const sessionDirectory = issueSessionRoot(this.stateRoot, issue.key);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(sessionDirectory), 0o700), chmod(sessionDirectory, 0o700)]);
    const runtimeRoot = await prepareIssueRuntime(
      this.stateRoot,
      issue.key,
      prepared.map(({ name, workspace }) => ({ name, repositoryPath: workspace.workspacePath })),
      sharedRepositories ? "read" : "write",
    );
    const workspaceRoot = sharedRepositories ? runtimeRoot : issueWorkspaceRoot(this.stateRoot, issue.key);
    const attachmentPath = issueAttachmentRoot(this.stateRoot, issue.key);
    await mkdir(attachmentPath, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(attachmentPath), 0o700), chmod(attachmentPath, 0o700)]);
    const executableRoot = sharedRepositories ? undefined : await prepareProjectWrappers(runtimeRoot);
    const repositoryPaths = prepared.map(({ name, workspace }) => sharedRepositories ? path.join(workspaceRoot, name) : workspace.workspacePath);
    const policy = createDeploymentPolicy({
      issueKey: issue.key,
      issueType: issue.type,
      workspaceRoot,
      deploymentId: deployment.id,
      deploymentConfig: deployment.config,
      serviceKey: service.key,
      environmentKey: service.environmentKey,
      environmentKind,
      repositories: prepared.map(({ workspace }, index) => ({ codeAccess: sharedRepositories ? "read" : "write", repositoryPath: repositoryPaths[index]!, baseCommit: workspace.baseCommit })),
    });
    let codeServerReady = false;
    try {
      await this.codeServerManager.ensure(issue.key, runtimeRoot);
      codeServerReady = true;
    } catch {
      // Agent execution remains available when the optional editor is unavailable.
    }
    const [binding] = await this.database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await pathExists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, workspaceRoot)
      : await createPrivateSessionManager(workspaceRoot, sessionDirectory);
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");

    const managed = await this.piRuntime.start({
      workspaceRoot,
      policy,
      deploymentConfig: deployment.config,
      manager,
      ...(executableRoot ? { executableRoot } : {}),
      systemPrompt: agentSystemPrompt(policy),
      onEvent: (event) => this.publishPiEvent(issue.id, event),
    });
    this.sessions.set(issue.id, managed);
    if (sharedRepositories) this.sharedReadOnlySessions.add(issue.id);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_initialize_agent_session");
    await this.database.insert(agentSessions).values({ issueId: issue.id, sessionFile, workspacePath: workspaceRoot }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { sessionFile, workspacePath: workspaceRoot, updatedAt: new Date() },
    });
    if (displayMessage && currentMessage) await this.recordUserMessage(issue.id, managed, currentMessage);
    await this.database.update(issueWorkspaces).set({ status: "running", codeServerReady, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    await this.database.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), ne(issues.status, "resolved")));

    const repositoryContexts = prepared.map(({ workspace }, index) => ({ branch: workspace.workingBranch ?? workspace.baseBranch, path: path.relative(workspaceRoot, repositoryPaths[index]!), readOnly: sharedRepositories }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, attachmentPath, currentMessage)
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, attachmentPath, ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}) });
    await managed.prompt(prompt);
    if (sharedRepositories) await this.stopSession(issue.id);
    await this.finalizeRun(issue.id);

  }

  private publishPiEvent(issueId: string, event: JsonAgentSessionEvent): void {
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event });
  }

  private async recordUserMessage(issueId: string, managed: ManagedPiSession, message: string): Promise<void> {
    managed.session.sessionManager.appendCustomEntry("issue-pilot-user", { message });
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_user", message } });
  }

  private async promptExisting(issueId: string, managed: ManagedPiSession, message: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date() }).where(and(eq(issues.id, issueId), ne(issues.status, "resolved")));
    });
    await managed.prompt(promptWithRuntimeTime(message));
    await this.finalizeRun(issueId);
  }

  private async finalizeRun(issueId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "pending", updatedAt: new Date() }).where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
    });
    this.publishStatus(issueId, "complete");
  }

  private async stopSession(issueId: string): Promise<void> {
    const managed = this.sessions.get(issueId);
    this.sharedReadOnlySessions.delete(issueId);
    if (!managed) return;
    this.sessions.delete(issueId);
    await managed.stop();
  }

  private publishStatus(issueId: string, status: "complete" | "error"): void {
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_status", status } });
  }

}
