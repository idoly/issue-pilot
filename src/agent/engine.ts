import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, ne } from "drizzle-orm";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { loadEnabledCapabilities } from "../configuration/capability-switches.ts";
import { stableErrorReason } from "../diagnostics.ts";
import { applyIssueCredentials, loadIssueCredentialOwner } from "../configuration/user-credentials.ts";
import { createPersonalGitEnvironment, type PersonalGitEnvironment } from "../workspace/git-credentials.ts";
import { loadGlobalAgentConfiguration, loadSharedAgentApiKey, selectAgentConfiguration } from "../configuration/agent.ts";
import { dingtalkMcpNames, serviceMcpConnections } from "../configuration/service-mcp.ts";
import { projectCapabilityConfiguration } from "../configuration/credentials.ts";
import { issueServiceIds, listEnvironmentServices, loadIssueDeployments } from "../workspace/issue-services.ts";
import { createWorkspaceTool } from "./workspace-tool.ts";
import { openVerifiedAttachmentFile } from "../http/attachment-store.ts";
import { IssueWorkFileStore } from "../workspace/work-files.ts";
import { KeyedSerialQueue } from "../serial.ts";
import { appendQueuedAgentMessage, pendingAgentMessages, selectAgentMessage, startAgentMessage, type AgentMessageScope } from "./message-delivery.ts";
import type { RunEvent } from "./events.ts";
import { createPrivateSessionManager, assertSessionFileComplete, PiSessionRuntime, type GitCommitIdentity, type ManagedPiSession } from "./pi-session.ts";
import { IssueProjectManager } from "../workspace/project.ts";
import { prepareIssueWorkDirectory } from "../workspace/work-files.ts";
import { issueRoot, pathExists } from "../workspace/state.ts";
import type { Database } from "../db/client.ts";
import { agentSessions, applicationSettings, issueAttachments, mcpServices, environments, issueWorkspaces, issues, services, subjects } from "../db/schema.ts";
import { CAPABILITY_KEYS, ENVIRONMENT_KINDS, errorMessage, personGitIdentity, type AgentRunState, type CapabilityName, type DeploymentConfig, type EnvironmentKind } from "../domain/contracts.ts";
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
  getRunState(issueId: string): AgentRunState;
  runExclusive<T>(issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export class AgentEngine implements AgentController {
  private readonly issueQueue = new KeyedSerialQueue();
  private readonly steerQueue = new KeyedSerialQueue();
  private readonly sessionQueue = new KeyedSerialQueue();
  private readonly runCounts = new Map<string, number>();
  private readonly executingIssues = new Set<string>();
  private readonly reservations = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly projectManager: IssueProjectManager;
  private readonly stateRoot: string;
  private readonly database: Database;
  private readonly publish: ((event: RunEvent) => void) | undefined;
  private readonly onError: (error: unknown) => void;
  private readonly sessions = new Map<string, ManagedPiSession>();
  // Sessions whose service scope changed during a round; they are retired when that round ends.
  private readonly scopeChangedSessions = new WeakSet<ManagedPiSession>();
  private readonly personalGit = new Map<string, PersonalGitEnvironment>();
  private readonly personalSessions = new Set<string>();
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

  getRunState(issueId: string): AgentRunState {
    return this.executingIssues.has(issueId) ? "running" : this.isRunning(issueId) ? "queued" : "idle";
  }

  async runExclusive<T>(issueIds: string[], operation: (reservation: AgentReservation) => Promise<T>): Promise<T> {
    this.assertOpen();
    const reserved = [...new Set(issueIds)].sort();
    const reservedSet = new Set(reserved);
    if (reserved.some((issueId) => this.isRunning(issueId) || this.reservations.has(issueId))) throw new Error("issue_already_running");
    for (const issueId of reserved) this.reservations.add(issueId);
    let active = true;
    const assertReserved = (issueId: string) => {
      if (!active || !reservedSet.has(issueId)) throw new Error("issue_not_reserved");
    };
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
      const [issue] = await this.database
        .select({ key: issues.key, status: issues.status, serviceId: issues.serviceId, environmentId: issues.environmentId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .limit(1);
      if (!issue) throw new Error("issue_not_found");
      if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
      const userMessage = message;
      const messageIssue = { id: issueId, key: issue.key, serviceId: issue.serviceId, environmentId: issue.environmentId };
      const managed = this.sessions.get(issueId);
      if (!managed) {
        this.assertNotReserved(issueId);
        await this.scheduleUserMessage(messageIssue, userMessage, images, (entryId) => this.run(issueId, userMessage, false, gitIdentity, images, entryId));
        return;
      }
      const scheduleMessage = () =>
        this.scheduleUserMessage(messageIssue, userMessage, images, (entryId) =>
          this.sessions.get(issueId) === managed ? this.promptExisting(issueId, managed, userMessage, images, entryId) : this.run(issueId, userMessage, false, gitIdentity, images, entryId),
        );
      if (gitIdentity && !this.personalSessions.has(issueId)) managed.setGitIdentity(gitIdentity);
      if (managed.streaming) {
        await this.steerQueue.run(issueId, async () => {
          // Earlier messages still queued for a later round keep their order; never steer past them.
          if (this.sessions.get(issueId) !== managed || !managed.streaming || pendingAgentMessages(managed.session.sessionManager).length) {
            await scheduleMessage();
            return;
          }
          const steered = userMessage.startsWith("/") ? userMessage : promptWithRuntimeTime(userMessage);
          const queuedBefore = managed.session.getSteeringMessages().length;
          await managed.session.steer(steered, images);
          // Pi may have accepted work before the old session was disposed; do not replay it.
          if (this.sessions.get(issueId) !== managed) throw new Error("agent_message_outcome_unknown");
          // The round can finish while Pi is still admitting the steer, leaving it undelivered in Pi's queue.
          // Take it back and queue it for the next round instead of reporting it as delivered. Pi may rewrite the
          // text (skills, templates, input handlers), so match by count; clearQueue() empties the whole queue,
          // so only do this when this steer is the only entry waiting there.
          if (!managed.streaming && queuedBefore === 0 && managed.session.getSteeringMessages().length === 1) {
            managed.session.clearQueue();
            await scheduleMessage();
            return;
          }
          try {
            await this.recordUserMessage(issueId, managed.session.sessionManager, userMessage, images);
          } catch (error) {
            try {
              await this.stopSession(issueId, managed);
            } catch (stopError) {
              throw new AggregateError([error, stopError], "agent_message_record_failed");
            }
            throw error;
          }
        });
      } else {
        await scheduleMessage();
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
      try {
        await this.stopSession(issueId);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.piRuntime.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "agent_close_failed");
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("agent_engine_closing");
  }

  private assertNotReserved(issueId: string): void {
    if (this.reservations.has(issueId)) throw new Error("issue_already_running");
  }

  private publishRunState(issueId: string, previous: AgentRunState): void {
    const state = this.getRunState(issueId);
    if (state !== previous) this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_run_state", state } });
  }

  private beginActivity(issueId: string): void {
    const previous = this.getRunState(issueId);
    this.runCounts.set(issueId, (this.runCounts.get(issueId) ?? 0) + 1);
    this.publishRunState(issueId, previous);
  }

  private endActivity(issueId: string, previous = this.getRunState(issueId)): void {
    const remaining = (this.runCounts.get(issueId) ?? 1) - 1;
    if (remaining > 0) this.runCounts.set(issueId, remaining);
    else this.runCounts.delete(issueId);
    this.publishRunState(issueId, previous);
    this.notifyIdle();
  }

  private async waitForIdle(): Promise<void> {
    if (!this.runCounts.size && !this.reservations.size) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private notifyIdle(): void {
    if (this.runCounts.size || this.reservations.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private async acquireSlot(): Promise<() => void> {
    if (this.activeSlots < this.maxConcurrentIssues) this.activeSlots++;
    else await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    return () => {
      const next = this.slotWaiters.shift();
      if (next) next();
      else this.activeSlots--;
    };
  }

  private schedule(issueId: string, operation: () => Promise<void>): void {
    this.beginActivity(issueId);
    void this.issueQueue.run(issueId, async () => {
      const release = await this.acquireSlot();
      const previous = this.getRunState(issueId);
      this.executingIssues.add(issueId);
      this.publishRunState(issueId, previous);
      try {
        await operation();
      } catch (error) {
        const cleanupFailures: unknown[] = [];
        try {
          await this.stopSession(issueId);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        try {
          const failed = await this.database.transaction(async (transaction) => {
            const [failedIssue] = await transaction
              .update(issues)
              .set({ status: "open", updatedAt: new Date() })
              .where(and(eq(issues.id, issueId), ne(issues.status, "resolved")))
              .returning({ id: issues.id });
            if (!failedIssue) return false;
            const [failedWorkspace] = await transaction
              .update(issueWorkspaces)
              .set({
                status: "failed",
                lastError: stableErrorReason(error, "agent_run_failed"),
                updatedAt: new Date(),
              })
              .where(eq(issueWorkspaces.issueId, issueId))
              .returning({ issueId: issueWorkspaces.issueId });
            if (!failedWorkspace) throw new Error("issue_workspace_missing");
            return true;
          });
          if (failed) this.publishStatus(issueId, "error");
        } catch (reportingError) {
          cleanupFailures.push(reportingError);
        }
        this.reportError(cleanupFailures.length ? new AggregateError([error, ...cleanupFailures], "agent_failure_cleanup_failed") : error);
      } finally {
        // Keep execution and failure cleanup in the same per-Issue serialized round.
        this.executingIssues.delete(issueId);
        this.endActivity(issueId, "running");
        release();
      }
    });
  }

  private async run(issueId: string, latestMessage?: string, displayMessage = false, requestedGitIdentity?: GitCommitIdentity, images: ImageContent[] = [], messageEntryId?: string): Promise<void> {
    const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issue) throw new Error("issue_not_found");
    if (issue.status === "resolved") throw new Error("resolved_issue_cannot_run_agent");
    let currentMessage = latestMessage?.trim() || undefined;
    if (messageEntryId || latestMessage === undefined) {
      const selected = await this.sessionQueue.run(issueId, async () => {
        const manager = await this.sessionManagerLocked(issue, await prepareIssueWorkDirectory(this.stateRoot, issue.key));
        return selectAgentMessage(manager, issue, messageEntryId);
      });
      if (messageEntryId && !selected) return;
      if (selected) {
        if (selected.id !== messageEntryId) requestedGitIdentity = undefined;
        messageEntryId = selected.id;
        currentMessage = selected.message;
        images = selected.images;
      }
    }
    const gitIdentity = requestedGitIdentity ?? (await this.gitIdentity(issue.reporterSubject));
    const [preparingWorkspace] = await this.database
      .update(issueWorkspaces)
      .set({ status: "preparing", runtimeReady: false, lastError: null, updatedAt: new Date() })
      .where(eq(issueWorkspaces.issueId, issue.id))
      .returning({ issueId: issueWorkspaces.issueId });
    if (!preparingWorkspace) throw new Error("issue_workspace_missing");

    const [service] = await this.database
      .select({
        id: services.id,
        key: services.key,
        name: services.name,
        description: services.description,
        environmentKey: environments.key,
        environmentKind: environments.kind,
      })
      .from(services)
      .innerJoin(environments, eq(environments.id, issue.environmentId))
      .where(eq(services.id, issue.serviceId))
      .limit(1);
    if (!service) throw new Error("issue_service_not_found");
    if (!ENVIRONMENT_KINDS.includes(service.environmentKind as EnvironmentKind)) throw new Error("unsupported_issue_environment_kind");
    const environmentKind = service.environmentKind as EnvironmentKind;
    await this.stopSession(issue.id);
    const owner = await loadIssueCredentialOwner(this.database, issue.id);
    if (environmentKind === "dev" && owner.user.role !== "developer") throw new Error("issue_developer_owner_required");
    const globalConfiguration = await loadGlobalAgentConfiguration(this.database);
    // The owner's complete personal model group replaces the shared model and key; only its absence selects the shared group.
    const personalModel = owner.credentials?.modelCredentials;
    const modelApiKey = personalModel ? personalModel.apiKey : await loadSharedAgentApiKey(this.database);
    if (!modelApiKey) throw new Error("model_api_key_not_configured");
    const agentConfiguration = selectAgentConfiguration(globalConfiguration, personalModel);
    let personalGit: PersonalGitEnvironment | undefined;
    if (owner.user.role === "developer") {
      const deployment = await loadIssueDeployments(this.database, issue);
      personalGit = await createPersonalGitEnvironment(
        owner.credentials,
        deployment.repositories.map(({ repository }) => repository.url),
      );
      this.personalGit.set(issue.id, personalGit);
      this.personalSessions.add(issue.id);
    }

    const workDirectory = await prepareIssueWorkDirectory(this.stateRoot, issue.key);
    const project = await this.projectManager.prepare(issue, environmentKind, personalGit?.env);
    const sharedRepositories = project.repositories.every((repository) => repository.access === "read");
    await chmod(workDirectory, 0o700);
    const attachmentPath = workDirectory;
    await chmod(path.dirname(workDirectory), 0o700);
    const attachments = await this.database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
    for (const attachment of attachments) {
      const handle = await openVerifiedAttachmentFile(attachmentPath, attachment.objectKey, attachment.size, attachment.sha256);
      await handle.close();
    }
    const environmentServices = await listEnvironmentServices(this.database, issue.environmentId);
    const queryServices = environmentServices.filter((row) => row.environment.kind !== "dev");
    const [shared] = await this.database
      .select({ sls: applicationSettings.sharedSlsCredentials, dms: applicationSettings.sharedDmsCredentials })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, 1))
      .limit(1);
    const serviceScopes = queryServices.map((row) => {
      const config = projectCapabilityConfiguration(row.deployment.config);
      const scope = { environmentKey: row.environment.key, serviceKey: row.service.key, serviceName: row.service.name };
      // Resolve each capability separately so a missing DMS group does not block SLS, and vice versa.
      // Failed targets stay discoverable; the selected query reports its own credential error at execution time.
      const resolved = { ...(config as DeploymentConfig) };
      const credentialErrors: Partial<Record<CapabilityName, string>> = {};
      for (const capability of CAPABILITY_KEYS) {
        if (!config[capability]) continue;
        try {
          Object.assign(resolved, applyIssueCredentials({ [capability]: config[capability] }, owner.credentials, shared));
        } catch (error) {
          credentialErrors[capability] = errorMessage(error);
        }
      }
      return { ...scope, config: resolved, credentialErrors };
    });
    const deploymentConfig = serviceScopes.find((scope) => scope.serviceKey === service.key && scope.environmentKey === service.environmentKey)?.config ?? {};
    const mcpRows = await this.database.select().from(mcpServices);
    const includedServiceIds = new Set(await issueServiceIds(this.database, issue));
    const mcpConfigurations = serviceMcpConnections(
      mcpRows,
      environmentServices.filter((row) => includedServiceIds.has(row.service.id)).map((row) => row.deployment.id),
      await dingtalkMcpNames(this.database),
    );
    const context = createAgentSessionContext({
      issueKey: issue.key,
      issueType: issue.type,
      enabledCapabilities: await loadEnabledCapabilities(this.database),
      deploymentConfig,
      additionalDeploymentConfigs: serviceScopes.map((scope) => scope.config),
      agentConfiguration,
      serviceKey: service.key,
      environmentKey: service.environmentKey,
      environmentKind,
      repositoryAccess: project.repositories.map((repository) => repository.access),
    });
    const workspaceTool = await createWorkspaceTool(this.database, issue, environmentKind, this.projectManager, project.runtimeRoot, personalGit?.env, () => {
      const current = this.sessions.get(issue.id);
      if (current) this.scopeChangedSessions.add(current);
    });
    const { managed, hadMessages } = await this.sessionQueue.run(issue.id, async () => {
      const manager = await this.sessionManagerLocked(issue, workDirectory);
      const hadMessages = manager.buildSessionContext().messages.length > 0;
      const managed = await this.piRuntime.start({
        runtime: agentConfiguration.runtime,
        workspaceRoot: workDirectory,
        context,
        deploymentConfig,
        serviceScopes,
        workspaceTool,
        mcpConfigurations,
        manager,
        readRoots: project.relatedIssueKeys.map((key) => issueRoot(this.stateRoot, key)),
        gitAccess: environmentKind === "dev" ? "write" : "read",
        gitIdentity: owner.user.role === "developer" ? personGitIdentity(owner.user) : gitIdentity,
        modelApiKey,
        ...(personalGit ? { gitEnvironment: personalGit.env, gitReadRoots: personalGit.readRoots } : {}),
        workFiles: new IssueWorkFileStore(this.stateRoot, issue.key),
        systemPrompt: agentSystemPrompt(context),
        onEvent: (event) => this.publishPiEvent(issue.id, event),
      });
      this.sessions.set(issue.id, managed);
      const sessionFile = manager.getSessionFile();
      if (!sessionFile) throw new Error("failed_to_initialize_agent_session");
      await this.database
        .insert(agentSessions)
        .values({ issueId: issue.id, sessionFile, workspacePath: workDirectory })
        .onConflictDoUpdate({
          target: agentSessions.issueId,
          set: { sessionFile, workspacePath: workDirectory, updatedAt: new Date() },
        });
      return { managed, hadMessages };
    });
    await this.markRunning(issue.id, project.runtimeReady);
    if (this.sessions.get(issue.id) !== managed) throw new Error("agent_session_changed");
    if (messageEntryId) await this.startQueuedMessage(issue, managed, messageEntryId);
    if (displayMessage && currentMessage) await this.recordUserMessage(issue.id, managed.session.sessionManager, currentMessage, images);

    const repositoryContexts = project.repositories.map((repository) => ({
      branch: repository.workingBranch ?? repository.baseBranch,
      path: repository.workspacePath,
      readOnly: repository.access === "read",
    }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, attachmentPath, currentMessage, undefined, project.relatedIssueKeys, project.runtimeRoot)
      : initialPrompt({
          issueKey: issue.key,
          title: issue.title,
          description: issue.description,
          issueType: issue.type,
          repositories: repositoryContexts,
          service,
          attachmentPath,
          relatedIssueKeys: project.relatedIssueKeys,
          relatedRoot: project.runtimeRoot,
          ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}),
        });
    await managed.prompt(prompt, images, currentMessage?.startsWith("/") ? currentMessage : undefined);
    // A failure path elsewhere may have stopped this session mid-round; an aborted prompt is not a completed round.
    if (this.sessions.get(issue.id) !== managed) throw new Error("agent_session_changed");
    if (sharedRepositories || this.scopeChangedSessions.has(managed)) await this.stopSession(issue.id, managed);
    await this.finalizeRun(issue.id);
  }

  private async gitIdentity(subject: string): Promise<GitCommitIdentity> {
    const [person] = await this.database.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new Error("issue_reporter_not_found");
    return personGitIdentity(person);
  }

  private reportError(error: unknown): void {
    try {
      this.onError(error);
    } catch {
      // Logging failures cannot create an unhandled background rejection.
    }
  }

  private publishEvent(event: RunEvent): void {
    try {
      this.publish?.(event);
    } catch (error) {
      this.reportError(error);
    }
  }

  private publishPiEvent(issueId: string, event: JsonAgentSessionEvent): void {
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event });
  }

  private async sessionManagerLocked(issue: { id: string; key: string }, workDirectory: string): Promise<SessionManager> {
    const active = this.sessions.get(issue.id)?.session.sessionManager;
    if (active) return active;
    const sessionDirectory = issueRoot(this.stateRoot, issue.key);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([chmod(path.dirname(sessionDirectory), 0o700), chmod(sessionDirectory, 0o700)]);
    const [binding] = await this.database.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const existingFile = binding && (await pathExists(binding.sessionFile));
    if (binding && !existingFile) throw new Error("agent_session_file_missing");
    if (existingFile) {
      await assertSessionFileComplete(binding.sessionFile);
      const manager = SessionManager.open(binding.sessionFile, sessionDirectory, workDirectory);
      // Never let Pi rebind the Issue to a replacement session file.
      if (manager.getSessionFile() !== path.resolve(binding.sessionFile)) throw new Error("agent_session_file_incomplete");
      return manager;
    }
    const manager = await createPrivateSessionManager(workDirectory, sessionDirectory);
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) throw new Error("failed_to_initialize_agent_session");
    try {
      await this.database
        .insert(agentSessions)
        .values({ issueId: issue.id, sessionFile, workspacePath: workDirectory })
        .onConflictDoUpdate({
          target: agentSessions.issueId,
          set: { sessionFile, workspacePath: workDirectory, updatedAt: new Date() },
        });
    } catch (error) {
      try {
        await unlink(sessionFile);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "agent_session_binding_cleanup_failed");
      }
      throw error;
    }
    return manager;
  }

  private async scheduleUserMessage(issue: AgentMessageScope & { id: string; key: string }, message: string, images: ImageContent[], operation: (entryId: string) => Promise<void>): Promise<void> {
    await this.sessionQueue.run(issue.id, async () => {
      const current = this.sessions.get(issue.id)?.session.sessionManager;
      const manager = current ?? (await this.sessionManagerLocked(issue, await prepareIssueWorkDirectory(this.stateRoot, issue.key)));
      let entryId: string;
      try {
        entryId = await this.recordUserMessage(issue.id, manager, message, images, issue);
      } catch (error) {
        try {
          await this.stopSessionLocked(issue.id);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "agent_message_record_failed");
        }
        throw error;
      }
      this.schedule(issue.id, () => operation(entryId));
    });
  }

  private async recordUserMessage(issueId: string, manager: SessionManager, message: string, images: ImageContent[] = [], queuedScope?: AgentMessageScope): Promise<string> {
    const entryId = queuedScope ? appendQueuedAgentMessage(manager, queuedScope, message, images) : manager.appendCustomEntry("issue-pilot-user", { message, ...(images.length ? { images } : {}) });
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_user", message, ...(images.length ? { images } : {}) } });
    return entryId;
  }

  private async startQueuedMessage(issue: AgentMessageScope & { id: string }, managed: ManagedPiSession, entryId: string): Promise<void> {
    await this.sessionQueue.run(issue.id, async () => {
      if (this.sessions.get(issue.id) !== managed) throw new Error("agent_session_changed");
      startAgentMessage(managed.session.sessionManager, entryId, issue);
      const next = pendingAgentMessages(managed.session.sessionManager)[0];
      if (next) this.schedule(issue.id, () => this.run(issue.id, next.message, false, undefined, next.images, next.id));
    });
  }

  private async promptExisting(issueId: string, managed: ManagedPiSession, message: string, images: ImageContent[] = [], messageEntryId?: string): Promise<void> {
    let scope: AgentMessageScope | undefined;
    if (messageEntryId) {
      const [issue] = await this.database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
      if (!issue) throw new Error("issue_not_found");
      const selected = await this.sessionQueue.run(issueId, async () => {
        if (this.sessions.get(issueId) !== managed) throw new Error("agent_session_changed");
        return selectAgentMessage(managed.session.sessionManager, issue, messageEntryId);
      });
      if (!selected) return;
      scope = issue;
      messageEntryId = selected.id;
      message = selected.message;
      images = selected.images;
    }
    await this.markRunning(issueId);
    if (this.sessions.get(issueId) !== managed) throw new Error("agent_session_changed");
    if (messageEntryId && scope) await this.startQueuedMessage({ id: issueId, ...scope }, managed, messageEntryId);
    await managed.prompt(promptWithRuntimeTime(message), images, message.startsWith("/") ? message : undefined);
    // A failure path elsewhere may have stopped this session mid-round; an aborted prompt is not a completed round.
    if (this.sessions.get(issueId) !== managed) throw new Error("agent_session_changed");
    if (this.scopeChangedSessions.has(managed)) await this.stopSession(issueId, managed);
    await this.finalizeRun(issueId);
  }

  private async markRunning(issueId: string, runtimeReady?: boolean): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [runningIssue] = await transaction
        .update(issues)
        .set({ status: "in_progress", resolvedAt: null, updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), inArray(issues.status, ["open", "pending"])))
        .returning({ id: issues.id });
      if (!runningIssue) throw new Error("issue_not_runnable");
      const [runningWorkspace] = await transaction
        .update(issueWorkspaces)
        .set({
          status: "running",
          ...(runtimeReady !== undefined ? { runtimeReady } : {}),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(issueWorkspaces.issueId, issueId))
        .returning({ issueId: issueWorkspaces.issueId });
      if (!runningWorkspace) throw new Error("issue_workspace_missing");
    });
  }

  private async finalizeRun(issueId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [readyWorkspace] = await transaction
        .update(issueWorkspaces)
        .set({ status: "ready", lastError: null, updatedAt: new Date() })
        .where(eq(issueWorkspaces.issueId, issueId))
        .returning({ issueId: issueWorkspaces.issueId });
      if (!readyWorkspace) throw new Error("issue_workspace_missing");
      const [completedIssue] = await transaction
        .update(issues)
        .set({ status: "pending", updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")))
        .returning({ id: issues.id });
      if (!completedIssue) throw new Error("issue_not_running");
    });
    this.publishStatus(issueId, "complete");
  }

  private stopSession(issueId: string, expected?: ManagedPiSession): Promise<void> {
    return this.sessionQueue.run(issueId, () => this.stopSessionLocked(issueId, expected));
  }

  private async stopSessionLocked(issueId: string, expected?: ManagedPiSession): Promise<void> {
    const managed = this.sessions.get(issueId);
    if (expected && managed !== expected) return;
    this.personalSessions.delete(issueId);
    const personalGit = this.personalGit.get(issueId);
    this.personalGit.delete(issueId);
    this.sessions.delete(issueId);
    const failures: unknown[] = [];
    try {
      await managed?.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      await personalGit?.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "agent_session_close_failed");
  }

  private publishStatus(issueId: string, status: "complete" | "error"): void {
    this.publishEvent({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_status", status } });
  }
}
