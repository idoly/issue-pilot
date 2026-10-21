import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, ne } from "drizzle-orm";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { loadEnabledCapabilities } from "../configuration/capability-switches.ts";
import { applyProductionCredentials, loadIssueCredentialOwner } from "../configuration/user-credentials.ts";
import { createPersonalGitEnvironment, type PersonalGitEnvironment } from "../workspace/git-credentials.ts";
import { loadGlobalAgentConfiguration } from "../configuration/agent.ts";
import { resolveDeploymentConfiguration } from "../configuration/credentials.ts";
import { listEnvironmentServices, loadIssueDeployments } from "../workspace/issue-services.ts";
import { createWorkspaceTool } from "./workspace-tool.ts";
import { IssueOutputStore } from "../outputs/store.ts";
import { KeyedSerialQueue } from "../serial.ts";
import type { RunEvent } from "./events.ts";
import { createPrivateSessionManager, PiSessionRuntime, type GitCommitIdentity, type ManagedPiSession } from "./pi-session.ts";
import { IssueProjectManager } from "../workspace/project.ts";
import { prepareIssueWorkDirectory } from "../workspace/working-files.ts";
import { issueAttachmentRoot, issueSessionRoot, pathExists } from "../workspace/state.ts";
import type { Database } from "../db/client.ts";
import {
  agentSessions,
  issueAttachments,
  mcpServices,
  environments,
  issueWorkspaces,
  issues,
  services,
  subjects,
} from "../db/schema.ts";
import { ENVIRONMENT_KINDS, errorMessage, type EnvironmentKind } from "../domain/contracts.ts";
import type { PiModelRuntime } from "./model-runtime.ts";
import { createAgentSessionContext } from "./context.ts";
import { agentSystemPrompt, continuationPrompt, initialPrompt, promptWithRuntimeTime } from "./prompts.ts";


export interface AgentReservation {
  enqueue(issueId: string, message?: string, recordMessage?: boolean): void;
  closeSession(issueId: string): Promise<void>;
}

export interface AgentController {
  enqueue(issueId: string, message?: string, recordMessage?: boolean): void;
  send(issueId: string, message: string, gitIdentity?: GitCommitIdentity, images?: ImageContent[]): Promise<void>;
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
  private readonly personalGit = new Map<string, PersonalGitEnvironment>();
  private readonly personalSessions = new Set<string>();
  private readonly sharedReadOnlySessions = new Set<string>();
  private readonly piRuntime: PiSessionRuntime;
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private activeSlots = 0;
  private readonly slotWaiters: Array<() => void> = [];
  private readonly maxConcurrentIssues: number;

  constructor(
    database: Database,
    stateRoot = ".issue-pilot",
    publish?: (event: RunEvent) => void,
    onError: (error: unknown) => void = () => undefined,
    modelRuntime?: PiModelRuntime,
    maxConcurrentIssues: number = issuePilotConfig.runtime.agent.maxConcurrentIssues,
  ) {
    if (!Number.isInteger(maxConcurrentIssues) || maxConcurrentIssues < 1) throw new Error("invalid_agent_concurrency");
    this.maxConcurrentIssues = maxConcurrentIssues;
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.projectManager = new IssueProjectManager(this.database, this.stateRoot);
    this.publish = publish;
    this.onError = onError;
    this.piRuntime = new PiSessionRuntime(modelRuntime);
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

  async send(issueId: string, message: string, gitIdentity?: GitCommitIdentity, images: ImageContent[] = []): Promise<void> {
    this.assertOpen();
    this.assertNotReserved(issueId);
    this.beginActivity(issueId);
    try {
      const [issue] = await this.database.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).limit(1);
      if (!issue) throw new Error("issue_not_found");
      if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
      const userMessage = message;
      const managed = this.sessions.get(issueId);
      if (!managed || (this.sharedReadOnlySessions.has(issueId) && !managed.streaming)) {
        if (managed) await this.stopSession(issueId);
        this.assertNotReserved(issueId);
        this.schedule(issueId, () => this.run(issueId, userMessage, true, gitIdentity, images));
        return;
      }
      if (gitIdentity && !this.personalSessions.has(issueId)) managed.setGitIdentity(gitIdentity);
      if (managed.streaming) {
        await this.steerQueue.run(issueId, async () => {
          if (this.sessions.get(issueId) !== managed || !managed.streaming) throw new Error("agent_session_changed");
          await managed.session.steer(userMessage.startsWith("/") ? userMessage : promptWithRuntimeTime(userMessage), images);
          try { await this.recordUserMessage(issueId, managed, userMessage, images); }
          catch (error) {
            try { await this.stopSession(issueId); }
            catch (stopError) { throw new AggregateError([error, stopError], "agent_message_record_failed"); }
            throw error;
          }
        });
      } else {
        this.schedule(issueId, () => this.sessions.get(issueId) === managed
          ? this.promptExisting(issueId, managed, userMessage, images)
          : this.run(issueId, userMessage, true, gitIdentity, images));
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
    for (const issueId of new Set([...this.sessions.keys(), ...this.personalGit.keys()])) {
      try { await this.stopSession(issueId); }
      catch (error) { failures.push(error); }
    }
    try { await this.piRuntime.close(); }
    catch (error) { failures.push(error); }
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

  private async acquireSlot(): Promise<() => void> {
    if (this.activeSlots < this.maxConcurrentIssues) this.activeSlots++;
    else await new Promise<void>(resolve => this.slotWaiters.push(resolve));
    return () => {
      const next = this.slotWaiters.shift();
      if (next) next(); else this.activeSlots--;
    };
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.beginActivity(issueId);
    void this.issueQueue.run(issueId, async () => {
      const release = await this.acquireSlot();
      try { await operation(); }
      catch (error) {
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
      } finally { release(); }
    }).finally(() => this.endActivity(issueId));
  }

  private async run(issueId: string, latestMessage?: string, displayMessage = false, requestedGitIdentity?: GitCommitIdentity, images: ImageContent[] = []): Promise<void> {
    const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
    const gitIdentity = requestedGitIdentity ?? await this.gitIdentity(issue.reporterSubject);
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
    const owner = await loadIssueCredentialOwner(this.database, issue.id);
    if ((environmentKind === "dev" || issue.type === "data_processing") && owner.user.role !== "developer") throw new Error("issue_developer_owner_required");
    const agentConfiguration = await loadGlobalAgentConfiguration(this.database);
    let modelApiKey: string | undefined;
    let personalGit: PersonalGitEnvironment | undefined;
    if (owner.user.role === "developer") {
      modelApiKey = owner.credentials?.modelApiKeys[agentConfiguration.provider];
      if (!modelApiKey) throw new Error("user_model_api_key_required");
      const deployment = await loadIssueDeployments(this.database, issue);
      personalGit = await createPersonalGitEnvironment(owner.credentials, deployment.repositories.map(({ repository }) => repository.url));
      this.personalGit.set(issue.id, personalGit);
      this.personalSessions.add(issue.id);
    }

    const workDirectory = await prepareIssueWorkDirectory(this.stateRoot, issue.key);
    const project = await this.projectManager.prepare(issue, environmentKind, personalGit?.env);
    const sharedRepositories = project.repositories.every((repository) => repository.access === "read");
    await chmod(workDirectory, 0o700);
    const sessionDirectory = issueSessionRoot(this.stateRoot, issue.key);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(sessionDirectory), 0o700), chmod(sessionDirectory, 0o700)]);
    const attachmentPath = issueAttachmentRoot(this.stateRoot, issue.key);
    await mkdir(attachmentPath, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(attachmentPath), 0o700), chmod(attachmentPath, 0o700)]);
    const attachments = await this.database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
    for (const attachment of attachments) {
      if (path.dirname(attachment.objectKey) !== attachmentPath) throw new Error("insecure_issue_attachment_file");
      const original = await lstat(attachment.objectKey);
      if (!original.isFile() || (original.mode & 0o7777) !== 0o400 || original.size !== attachment.size) throw new Error("insecure_issue_attachment_file");
      const copy = path.join(workDirectory, path.basename(attachment.objectKey));
      try { await copyFile(attachment.objectKey, copy, constants.COPYFILE_EXCL); await chmod(copy, 0o600); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const environmentServices = await listEnvironmentServices(this.database, issue.environmentId, true);
    const queryServices = environmentServices.filter(row => row.environment.kind !== "dev");
    const serviceScopes = queryServices.map(row => ({ environmentKey: row.environment.key, serviceKey: row.service.key, serviceName: row.service.name, config: applyProductionCredentials(resolveDeploymentConfiguration(row.deployment.config), row.environment.key, owner.credentials) }));
    const deploymentConfig = serviceScopes.find(scope => scope.serviceKey === service.key && scope.environmentKey === service.environmentKey)?.config ?? {};
    const mcpRows = await this.database.select().from(mcpServices);
    const mcpConfigurations = mcpRows.filter(connection => connection.enabled);
    const context = createAgentSessionContext({
      issueKey: issue.key,
      issueType: issue.type,
      enabledCapabilities: await loadEnabledCapabilities(this.database),
      deploymentConfig,
      additionalDeploymentConfigs: serviceScopes.map(scope => scope.config),
      agentConfiguration,
      serviceKey: service.key,
      environmentKey: service.environmentKey,
      environmentKind,
      repositoryAccess: project.repositories.map((repository) => repository.access),
    });
    const [binding] = await this.database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await pathExists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, workDirectory)
      : await createPrivateSessionManager(workDirectory, sessionDirectory);
    const hadMessages = manager.buildSessionContext().messages.length > 0;

    const managed = await this.piRuntime.start({
      runtime: agentConfiguration.runtime,
      workspaceRoot: workDirectory,
      context,
      deploymentConfig,
      serviceScopes,
      workspaceTool: await createWorkspaceTool(this.database, issue, environmentKind, this.projectManager, project.runtimeRoot, personalGit?.env),
      mcpConfigurations,
      manager,
      ...(project.executableRoot ? { executableRoot: project.executableRoot } : {}),
      gitIdentity: owner.user.role === "developer" ? { name: owner.user.displayName ?? owner.user.subject, email: owner.user.email ?? `${owner.user.subject}@localhost` } : gitIdentity,
      ...(modelApiKey ? { modelApiKey } : {}),
      ...(personalGit ? { gitEnvironment: personalGit.env } : {}),
      ...(context.canWriteOutputs ? { outputStore: new IssueOutputStore(this.stateRoot, issue.key) } : {}),
      systemPrompt: agentSystemPrompt(context),
      onEvent: (event) => this.publishPiEvent(issue.id, event),
    });
    this.sessions.set(issue.id, managed);
    if (sharedRepositories) this.sharedReadOnlySessions.add(issue.id);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_initialize_agent_session");
    await this.database.insert(agentSessions).values({ issueId: issue.id, sessionFile, workspacePath: workDirectory }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { sessionFile, workspacePath: workDirectory, updatedAt: new Date() },
    });
    await this.markRunning(issue.id, project.runtimeReady);
    if (displayMessage && currentMessage) await this.recordUserMessage(issue.id, managed, currentMessage, images);

    const repositoryContexts = project.repositories.map((repository) => ({ branch: repository.workingBranch ?? repository.baseBranch, path: repository.workspacePath, readOnly: repository.access === "read" }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, attachmentPath, currentMessage, undefined, project.relatedIssueKeys, path.join(project.runtimeRoot, "related-issues"))
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, attachmentPath, relatedIssueKeys: project.relatedIssueKeys, relatedRoot: path.join(project.runtimeRoot, "related-issues"), ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}) });
    await managed.prompt(prompt, images, currentMessage?.startsWith("/") ? currentMessage : undefined);
    if (sharedRepositories) await this.stopSession(issue.id);
    await this.finalizeRun(issue.id);

  }

  private async gitIdentity(subject: string): Promise<GitCommitIdentity> {
    const [person] = await this.database.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new Error("issue_reporter_not_found");
    return {
      name: person.displayName ?? person.subject,
      email: person.email ?? `${person.subject}@localhost`,
    };
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

  private async recordUserMessage(issueId: string, managed: ManagedPiSession, message: string, images: ImageContent[] = []): Promise<void> {
    managed.session.sessionManager.appendCustomEntry("issue-pilot-user", { message, ...(images.length ? { images } : {}) });
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_user", message, ...(images.length ? { images } : {}) } });
  }

  private async promptExisting(issueId: string, managed: ManagedPiSession, message: string, images: ImageContent[] = []): Promise<void> {
    await this.markRunning(issueId);
    await this.recordUserMessage(issueId, managed, message, images);
    await managed.prompt(promptWithRuntimeTime(message), images, message.startsWith("/") ? message : undefined);
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
    this.personalSessions.delete(issueId);
    const personalGit = this.personalGit.get(issueId);
    this.personalGit.delete(issueId);
    this.sessions.delete(issueId);
    const failures: unknown[] = [];
    try { await managed?.stop(); } catch (error) { failures.push(error); }
    try { await personalGit?.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "agent_session_close_failed");
  }

  private publishStatus(issueId: string, status: "complete" | "error"): void {
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_status", status } });
  }

}
