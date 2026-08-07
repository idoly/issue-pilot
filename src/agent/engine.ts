import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import { RpcClient, SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type { RunEvent } from "./events.ts";
import { createPrivateSessionManager } from "./session.ts";
import { CodeServer } from "../workspace/code-server.ts";
import { preparePiWorkspace } from "../workspace/pi-tools.ts";
import { issueSessionRoot, issueWorkspaceRoot, toolsRoot } from "../workspace/paths.ts";
import type { openDatabase } from "../db/client.ts";
import {
  agentSessions,
  environments,
  issueRepositories,
  issueWorkspaces,
  issues,
  serviceDeployments,
  serviceRepositories,
  services,
} from "../db/schema.ts";
import type { CapabilityName } from "../domain/contracts.ts";
import { repositoryWorkspaceNames, Worktrees } from "../workspace/git.ts";
import { createDeploymentPolicy, type IssuePolicy } from "../pi/policy.ts";
import { executeCapability } from "../capabilities/broker.ts";
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
  client: RpcClient;
  policy: IssuePolicy;
  deploymentConfig: Record<string, unknown>;
  brokerToken: string;
  sessionFile: string;
  sessionId: string;
  runtimeConfigFile: string;
  streaming: boolean;
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

  constructor(db: Database, stateRoot = ".issue-pilot", publish?: (event: RunEvent) => void) {
    this.db = db;
    this.stateRoot = path.resolve(stateRoot);
    this.worktrees = new Worktrees(this.stateRoot);
    this.codeServer = new CodeServer(this.stateRoot);
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
    const userMessage = message.trim();
    const managed = this.sessions.get(issueId);
    if (!managed) {
      this.enqueue(issueId, userMessage, true);
      return;
    }
    await this.recordUserMessage(issueId, managed, userMessage);
    if (managed.streaming) await managed.client.steer(promptWithRuntimeTime(userMessage));
    else this.schedule(issueId, () => this.promptExisting(issueId, managed, userMessage));
  }

  async abort(issueId: string): Promise<boolean> {
    const managed = this.sessions.get(issueId);
    if (!managed?.streaming) return false;
    await managed.client.abort();
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((issueId) => this.stopSession(issueId)));
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
    if (service.environmentKind !== "prod" && service.environmentKind !== "test" && service.environmentKind !== "dev") throw new Error("unsupported_issue_environment_kind");
    const worktreeMode = service.environmentKind === "dev" && issue.type === "defect_fix"
      ? "hotfix" as const
      : service.environmentKind === "dev" && issue.type === "feature_development"
        ? "feature" as const
        : "detached" as const;

    const [repositoryRows, existingRepositoryRows] = await Promise.all([
      this.db.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id)),
      this.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (!repositoryRows.length) {
      await this.db.delete(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      throw new Error("selected_service_has_no_repository");
    }
    const existingRepositoryByUrl = new Map(existingRepositoryRows.map((repository) => [repository.url, repository]));
    const workspaceNames = repositoryWorkspaceNames(repositoryRows.map((repository) => repository.url));
    await this.db.delete(issueRepositories).where(and(
      eq(issueRepositories.issueId, issue.id),
      notInArray(issueRepositories.url, repositoryRows.map((repository) => repository.url)),
    ));

    const prepared: Array<{ repository: (typeof repositoryRows)[number]; workspace: Awaited<ReturnType<Worktrees["prepare"]>> }> = [];
    for (const repository of repositoryRows) {
      const existingRepository = existingRepositoryByUrl.get(repository.url);
      const workspace = await this.worktrees.prepare({
        issueId: issue.key,
        workspaceName: workspaceNames.get(repository.url)!,
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

    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    const sessionDirectory = issueSessionRoot(this.stateRoot, issue.key);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    const policy = createDeploymentPolicy({
      issueKey: issue.key,
      issueType: issue.type,
      workspaceRoot,
      deploymentId: service.deploymentId,
      deploymentConfig: service.deploymentConfig,
      serviceKey: service.key,
      environmentKey: service.environmentKey,
      environmentKind: service.environmentKind,
      repositories: prepared.map(({ workspace }) => ({ codeAccess: worktreeMode === "detached" ? "read" : "write", repositoryPath: workspace.workspacePath, baseCommit: workspace.baseCommit })),
    });
    await preparePiWorkspace(workspaceRoot);
    let codeServerUrl: string | null = null;
    try {
      codeServerUrl = await this.codeServer.ensure(issue.key, workspaceRoot);
    } catch {
      codeServerUrl = null;
    }
    const [binding] = await this.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1);
    const manager = binding && await exists(binding.sessionFile)
      ? SessionManager.open(binding.sessionFile, sessionDirectory, binding.workspacePath)
      : await createPrivateSessionManager(workspaceRoot, sessionDirectory);
    const hadMessages = manager.buildContextEntries().some((entry) => entry.type === "message");

    await this.stopSession(issue.id);
    const managed = await this.createManagedSession(issue.id, workspaceRoot, sessionDirectory, policy, service.deploymentConfig, manager);
    this.sessions.set(issue.id, managed);
    if (displayMessage && currentMessage) await this.recordUserMessage(issue.id, managed, currentMessage);
    await this.db.insert(agentSessions).values({ issueId: issue.id, piSessionId: managed.sessionId, sessionFile: managed.sessionFile, workspacePath: workspaceRoot }).onConflictDoUpdate({
      target: agentSessions.issueId,
      set: { piSessionId: managed.sessionId, sessionFile: managed.sessionFile, workspacePath: workspaceRoot, updatedAt: new Date() },
    });
    await this.db.update(issueWorkspaces).set({ status: "running", codeServerUrl, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    await this.db.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issue.id), ne(issues.status, "resolved")));

    const repositoryContexts = prepared.map(({ repository, workspace }) => ({ url: repository.url, branch: workspace.workingBranch ?? workspace.baseBranch, path: path.relative(workspaceRoot, workspace.workspacePath), readOnly: worktreeMode === "detached" }));
    const prompt = hadMessages
      ? continuationPrompt(issue.key, repositoryContexts, currentMessage)
      : initialPrompt({ issueKey: issue.key, title: issue.title, description: issue.description, issueType: issue.type, repositories: repositoryContexts, service, ...(currentMessage !== undefined ? { latestUpdate: currentMessage } : {}) });
    await this.promptAndWait(managed, prompt);
    await this.finalizeRun(issue.id);

  }

  private async createManagedSession(issueId: string, workspaceRoot: string, sessionDirectory: string, policy: IssuePolicy, deploymentConfig: Record<string, unknown>, manager: SessionManager): Promise<ManagedSession> {
    const sessionFile = manager.getSessionFile();
    const sessionId = manager.getSessionId();
    if (!sessionFile) throw new Error("failed_to_create_agent_session");
    const runtimeConfigFile = path.join(sessionDirectory, `${sessionId}.runtime.json`);
    for (const entry of await readdir(sessionDirectory)) {
      if (entry.endsWith(".runtime.json")) await rm(path.join(sessionDirectory, entry), { force: true });
    }
    const brokerToken = randomUUID();
    await writeFile(runtimeConfigFile, JSON.stringify({
      issueId,
      capabilities: policy.service.capabilities,
      brokerUrl: process.env.ISSUE_PILOT_INTERNAL_URL ?? "http://127.0.0.1:3000",
      brokerToken,
    }), { mode: 0o600 });
    const cliPath = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
    const extensionPath = fileURLToPath(new URL("../pi/rpc-extension.ts", import.meta.url));
    const client = new RpcClient({
      cliPath,
      cwd: workspaceRoot,
      provider: policy.model.provider,
      model: policy.model.modelId,
      env: {
        ISSUE_PILOT_RUNTIME_CONFIG: runtimeConfigFile,
        ISSUE_WORKSPACE: workspaceRoot,
        PI_TOOL_CACHE_ROOT: toolsRoot(this.stateRoot),
        PATH: `${path.join(workspaceRoot, ".issue-pilot", "bin")}:${process.env.PATH ?? ""}`,
      },
      args: [
        "--session", sessionFile,
        "--session-dir", sessionDirectory,
        "--thinking", policy.model.thinkingLevel,
        "--no-approve",
        "--extension", extensionPath,
        "--append-system-prompt", `You are handling ${policy.issueKey} through Issue Pilot. Use the configured capability tools for deployment evidence.`,
      ],
    });
    let managed!: ManagedSession;
    const unsubscribe = client.onEvent((event) => this.handleRpcEvent(issueId, managed, event));
    managed = {
      client, policy, deploymentConfig: structuredClone(deploymentConfig), brokerToken, sessionFile, sessionId, runtimeConfigFile,
      streaming: false, unsubscribe,
    };
    try {
      await client.start();
      const state = await client.getState();
      if (state.sessionId !== sessionId || state.sessionFile !== sessionFile) throw new Error("issue_pilot_rpc_session_mismatch");
      await Promise.all([client.setAutoCompaction(true), client.setAutoRetry(true)]);
      return managed;
    } catch (error) {
      unsubscribe();
      await client.stop().catch(() => undefined);
      await rm(runtimeConfigFile, { force: true });
      throw error;
    }
  }

  private handleRpcEvent(issueId: string, managed: ManagedSession, event: JsonAgentSessionEvent): void {
    if (event.type === "agent_start") managed.streaming = true;
    if (event.type === "agent_settled") managed.streaming = false;
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event });
  }

  private async promptAndWait(managed: ManagedSession, prompt: string): Promise<void> {
    const settled = managed.client.waitForIdle(30 * 60_000);
    await Promise.all([managed.client.prompt(prompt), settled]);
  }

  private async recordUserMessage(issueId: string, managed: ManagedSession, message: string): Promise<void> {
    await managed.client.prompt(`/issue-user ${Buffer.from(message).toString("base64url")}`);
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_user", message } });
  }

  private async promptExisting(issueId: string, managed: ManagedSession, message: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), ne(issues.status, "resolved")));
    });
    await this.promptAndWait(managed, promptWithRuntimeTime(message));
    await this.finalizeRun(issueId);
  }

  private async finalizeRun(issueId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "ready", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
      await transaction.update(issues).set({ status: "pending", updatedAt: new Date(), version: sql`${issues.version} + 1` }).where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")));
    });
    this.publishStatus(issueId, "complete");
  }

  private async stopSession(issueId: string): Promise<void> {
    const managed = this.sessions.get(issueId);
    if (!managed) return;
    this.sessions.delete(issueId);
    if (managed.streaming) await managed.client.abort().catch(() => undefined);
    managed.unsubscribe();
    await managed.client.stop();
    await rm(managed.runtimeConfigFile, { force: true });
  }

  async invokeCapability(issueId: string, token: string, capability: string, input: unknown, signal?: AbortSignal) {
    const managed = this.sessions.get(issueId);
    if (!managed || managed.brokerToken !== token || !managed.policy.service.capabilities.includes(capability as CapabilityName)) throw new Error("capability_not_available");
    return executeCapability(managed.policy, managed.deploymentConfig, capability as CapabilityName, input, signal);
  }

  private publishStatus(issueId: string, status: "complete" | "error"): void {
    this.publish?.({ id: randomUUID(), issueId, createdAt: new Date().toISOString(), event: { type: "issue_status", status } });
  }

}
