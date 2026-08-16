import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, ne } from "drizzle-orm";
import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createCapabilityExecutor } from "../capabilities/broker.ts";
import { processToolRuntime, type ToolRuntime } from "../tool-runtime.ts";
import { KeyedSerialQueue } from "../serial.ts";
import type { RunEvent } from "./events.ts";
import { createPrivateSessionManager, PiSessionRuntime, type ManagedPiSession } from "./pi-session.ts";
import { IssueProjectManager } from "../workspace/project.ts";
import { issueAttachmentRoot, issueSessionRoot, pathExists } from "../workspace/state.ts";
import type { Database } from "../db/client.ts";
import {
  agentSessions,
  environments,
  issueWorkspaces,
  issues,
  services,
} from "../db/schema.ts";
import { ENVIRONMENT_KINDS, errorMessage, type EnvironmentKind } from "../domain/contracts.ts";
import { createDeploymentPolicy } from "../pi/policy.ts";
import { agentSystemPrompt, continuationPrompt, initialPrompt, promptWithRuntimeTime } from "./prompts.ts";


export interface AgentReservation {
  enqueue(issueId: string, message?: string, recordMessage?: boolean): void;
  closeSession(issueId: string): Promise<void>;
}

export interface AgentController {
  enqueue(issueId: string, message?: string, recordMessage?: boolean): void;
  send(issueId: string, message: string): Promise<void>;
  isRunning(issueId: string): boolean;
  runExclusive<T>(issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export { repositoryPreparationMode } from "../workspace/project.ts";

export class AgentEngine implements AgentController {
  private readonly issueQueue = new KeyedSerialQueue();
  private readonly steerQueue = new KeyedSerialQueue();
  private readonly runCounts = new Map<string, number>();
  private readonly reservations = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly projectManager: IssueProjectManager;
  private readonly stateRoot: string;
  private readonly database: Database;
  private readonly publish: ((event: RunEvent) => void) | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly sessions = new Map<string, ManagedPiSession>();
  private readonly sharedReadOnlySessions = new Set<string>();
  private readonly piRuntime: PiSessionRuntime;
  private closePromise: Promise<void> | undefined;
  private closing = false;

  constructor(
    database: Database,
    stateRoot = ".issue-pilot",
    publish?: (event: RunEvent) => void,
    onError: (error: unknown) => void = () => undefined,
    tools: ToolRuntime = processToolRuntime,
  ) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.projectManager = new IssueProjectManager(this.database, this.stateRoot);
    this.publish = publish;
    this.onError = onError;
    this.piRuntime = new PiSessionRuntime(undefined, createCapabilityExecutor(tools));
  }

  enqueue(issueId: string, latestMessage?: string, displayMessage = false): void {
    this.assertOpen();
    this.assertNotReserved(issueId);
    this.schedule(issueId, () => this.run(issueId, latestMessage, displayMessage));
  }

  isRunning(issueId: string): boolean {
    return (this.runCounts.get(issueId) ?? 0) > 0;
  }

  async runExclusive<T>(issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T> {
    this.assertOpen();
    const reserved = [...new Set(issueIds)].sort();
    const reservedSet = new Set(reserved);
    if (reserved.some((issueId) => this.isRunning(issueId) || this.reservations.has(issueId))) throw new Error("issue_already_running");
    for (const issueId of reserved) this.reservations.add(issueId);
    let active = true;
    const assertReserved = (issueId: string) => { if (!active || !reservedSet.has(issueId)) throw new Error("issue_not_reserved"); };
    try {
      return await operation({
        enqueue: (issueId, message, recordMessage) => {
          assertReserved(issueId);
          this.schedule(issueId, () => this.run(issueId, message, recordMessage));
        },
        closeSession: async (issueId) => {
          assertReserved(issueId);
          await this.stopSession(issueId);
        },
      });
    } finally {
      active = false;
      for (const issueId of reserved) this.reservations.delete(issueId);
      this.notifyIdle();
    }
  }

  async send(issueId: string, message: string): Promise<void> {
    if (!message.trim()) throw new Error("agent_message_required");
    if (message.length > issuePilotConfig.limits.agentMessageChars) throw new Error("invalid_agent_message");
    this.assertOpen();
    this.assertNotReserved(issueId);
    this.beginActivity(issueId);
    try {
      const [issue] = await this.database.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1);
      if (!issue) throw new Error("issue_not_found");
      if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
      const userMessage = message.trim();
      const managed = this.sessions.get(issueId);
      if (!managed || (this.sharedReadOnlySessions.has(issueId) && !managed.streaming)) {
        if (managed) await this.stopSession(issueId);
        this.assertNotReserved(issueId);
        this.schedule(issueId, () => this.run(issueId, userMessage, true));
        return;
      }
      if (managed.streaming) {
        await this.steerQueue.run(issueId, async () => {
          if (this.sessions.get(issueId) !== managed || !managed.streaming) throw new Error("agent_session_changed");
          await managed.session.steer(promptWithRuntimeTime(userMessage));
          try { await this.recordUserMessage(issueId, managed, userMessage); }
          catch (error) {
            try { await this.stopSession(issueId); }
            catch (stopError) { throw new AggregateError([error, stopError], "agent_message_record_failed"); }
            throw error;
          }
        });
      } else {
        this.schedule(issueId, () => this.promptExisting(issueId, managed, userMessage));
      }
    } finally {
      this.endActivity(issueId);
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeLocked();
    return this.closePromise;
  }

  private async closeLocked(): Promise<void> {
    this.closing = true;
    await this.waitForIdle();
    const failures: unknown[] = [];
    for (const issueId of [...this.sessions.keys()]) {
      try { await this.stopSession(issueId); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "agent_close_failed");
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("agent_engine_closing");
  }

  private assertNotReserved(issueId: string): void {
    if (this.reservations.has(issueId)) throw new Error("issue_already_running");
  }

  private beginActivity(issueId: string): void {
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
  }

  private endActivity(issueId: string): void {
    const remaining = (this.runCounts.get(issueId) ?? 1) - 1;
    if (remaining > 0) this.runCounts.set(issueId, remaining);
    else this.runCounts.delete(issueId);
    this.notifyIdle();
  }

  private async waitForIdle(): Promise<void> {
    if (!this.runCounts.size && !this.reservations.size) return;
    await new Promise<void>((resolve) => { this.idleWaiters.add(resolve); });
  }

  private notifyIdle(): void {
    if (this.runCounts.size || this.reservations.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.beginActivity(issueId);
    void this.issueQueue.run(issueId, operation).catch(async (error) => {
      const cleanupFailures: unknown[] = [];
      try { await this.stopSession(issueId); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
      try {
        const failed = await this.database.transaction(async (transaction) => {
          const [failedIssue] = await transaction.update(issues).set({ status: "open", updatedAt: new Date() })
            .where(and(eq(issues.id, issueId), ne(issues.status, "resolved"))).returning({ id: issues.id });
          if (!failedIssue) return false;
          const [failedWorkspace] = await transaction.update(issueWorkspaces).set({
            status: "failed",
            lastError: errorMessage(error),
            updatedAt: new Date(),
          }).where(eq(issueWorkspaces.issueId, issueId)).returning({ issueId: issueWorkspaces.issueId });
          if (!failedWorkspace) throw new Error("issue_workspace_missing");
          return true;
        });
        if (failed) this.publishStatus(issueId, "error");
      } catch (reportingError) {
        cleanupFailures.push(reportingError);
      }
      if (cleanupFailures.length) this.reportError(new AggregateError([error, ...cleanupFailures], "agent_failure_cleanup_failed"));
    }).finally(() => this.endActivity(issueId));
  }

  private async run(issueId: string, latestMessage?: string, displayMessage = false): Promise<void> {
    const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
    const currentMessage = latestMessage?.trim() || undefined;
    const [preparingWorkspace] = await this.database.update(issueWorkspaces).set({ status: "preparing", runtimeReady: false, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id)).returning({ issueId: issueWorkspaces.issueId });
    if (!preparingWorkspace) throw new Error("issue_workspace_missing");

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

    const project = await this.projectManager.prepare(issue, environmentKind);
    const sharedRepositories = project.repositories.every((repository) => repository.access === "read");
    const sessionDirectory = issueSessionRoot(this.stateRoot, issue.key);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(sessionDirectory), 0o700), chmod(sessionDirectory, 0o700)]);
    const attachmentPath = issueAttachmentRoot(this.stateRoot, issue.key);
    await mkdir(attachmentPath, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(attachmentPath), 0o700), chmod(attachmentPath, 0o700)]);
    const policy = createDeploymentPolicy({
      issueKey: issue.key,
      issueType: issue.type,
      workspaceRoot: project.workspaceRoot,
      deploymentId: project.deployment.id,
      deploymentConfig: project.deployment.config,
      serviceKey: service.key,
      environmentKey: service.environmentKey,
      environmentKind,
      repositories: project.repositories.map((repository) => ({ codeAccess: repository.access, repositoryPath: repository.workspacePath, baseCommit: repository.baseCommit })),
    });
    const [binding] = await this.database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await pathExists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, project.workspaceRoot)
      : await createPrivateSessionManager(project.workspaceRoot, sessionDirectory);
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");

    const managed = await this.piRuntime.start({
      workspaceRoot: project.workspaceRoot,
      policy,
      deploymentConfig: project.deployment.config,
      manager,
      ...(project.executableRoot ? { executableRoot: project.executableRoot } : {}),
      systemPrompt: agentSystemPrompt(policy),
      onEvent: (event) => this.publishPiEvent(issue.id, event),
    });
    this.sessions.set(issue.id, managed);
    if (sharedRepositories) this.sharedReadOnlySessions.add(issue.id);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_initialize_agent_session");
    await this.database.insert(agentSessions).values({ issueId: issue.id, sessionFile, workspacePath: project.workspaceRoot }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { sessionFile, workspacePath: project.workspaceRoot, updatedAt: new Date() },
    });
    await this.markRunning(issue.id, project.runtimeReady);
    if (displayMessage && currentMessage) await this.recordUserMessage(issue.id, managed, currentMessage);

    const repositoryContexts = project.repositories.map((repository) => ({ branch: repository.workingBranch ?? repository.baseBranch, path: path.relative(project.workspaceRoot, repository.workspacePath), readOnly: repository.access === "read" }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, attachmentPath, currentMessage)
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, attachmentPath, ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}) });
    await managed.prompt(prompt);
    if (sharedRepositories) await this.stopSession(issue.id);
    await this.finalizeRun(issue.id);

  }

  private reportError(error: unknown): void {
    try { this.onError(error); } catch {
      // Logging failures cannot create an unhandled background rejection.
    }
  }

  private publishEvent(event: RunEvent): void {
    try { this.publish?.(event); } catch (error) { this.reportError(error); }
  }

  private publishPiEvent(issueId: string, event: JsonAgentSessionEvent): void {
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event });
  }

  private async recordUserMessage(issueId: string, managed: ManagedPiSession, message: string): Promise<void> {
    managed.session.sessionManager.appendCustomEntry("issue-pilot-user", { message });
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_user", message } });
  }

  private async promptExisting(issueId: string, managed: ManagedPiSession, message: string): Promise<void> {
    await this.markRunning(issueId);
    await this.recordUserMessage(issueId, managed, message);
    await managed.prompt(promptWithRuntimeTime(message));
    await this.finalizeRun(issueId);
  }

  private async markRunning(issueId: string, runtimeReady?: boolean): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [runningIssue] = await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), inArray(issues.status, ["open", "pending"]))).returning({ id: issues.id });
      if (!runningIssue) throw new Error("issue_not_runnable");
      const [runningWorkspace] = await transaction.update(issueWorkspaces).set({
        status: "running",
        ...(runtimeReady !== undefined ? { runtimeReady } : {}),
        lastError: null,
        updatedAt: new Date(),
      }).where(eq(issueWorkspaces.issueId, issueId)).returning({ issueId: issueWorkspaces.issueId });
      if (!runningWorkspace) throw new Error("issue_workspace_missing");
    });
  }

  private async finalizeRun(issueId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [readyWorkspace] = await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId)).returning({ issueId: issueWorkspaces.issueId });
      if (!readyWorkspace) throw new Error("issue_workspace_missing");
      const [completedIssue] = await transaction.update(issues).set({ status: "pending", updatedAt: new Date() }).where(and(eq(issues.id, issueId), eq(issues.status, "in_progress"))).returning({ id: issues.id });
      if (!completedIssue) throw new Error("issue_not_running");
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
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_status", status } });
  }

}
