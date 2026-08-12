import { execFile } from "node:child_process";
import { rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { and, asc, eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { AgentController } from "../agent/engine.ts";
import type { Database } from "../db/client.ts";
import { environments, issueRepositories, issues, issueWorkspaces } from "../db/schema.ts";
import { errorMessage, isWorkspaceBusy, type IssueStatus, type WorkspaceStatus } from "../domain/contracts.ts";
import { CodeServerManager } from "./code-server.ts";
import { developmentWorktreeMode, prepareDevelopmentIssueRuntime } from "./development.ts";
import { repositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure } from "./git.ts";
import { prepareProjectWrappers } from "./project-wrappers.ts";
import { prepareIssueRuntime } from "./runtime.ts";
import { assertManagedIssueWorkspaceLayout, assertManagedIssueWorkspacePaths, classifyRepositoryState, issueWorkspaceRoot, pathExists } from "./state.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceRetentionPolicy {
  retentionMs: number;
  highWaterBytes: number;
  targetBytes: number;
  maintenanceIntervalMs: number;
}

export interface WorkspaceInspection {
  issueId: string;
  issueKey: string;
  issueStatus: IssueStatus;
  workspaceStatus: WorkspaceStatus;
  resolvedAt: string | null;
  bytes: number;
  releasable: boolean;
  blockedReason: string | null;
}

export interface WorkspaceReleaseResult {
  issueKey: string;
  releasedBytes: number;
  alreadyReleased: boolean;
}

export class WorkspaceReleaseRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class WorkspaceRestoreRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

type CodeServer = Pick<CodeServerManager, "ensure">;
type Issue = typeof issues.$inferSelect;
type IssueWorkspace = typeof issueWorkspaces.$inferSelect;
type IssueRepository = typeof issueRepositories.$inferSelect;
type IssueRow = { issue: Issue; workspace: IssueWorkspace | null; environmentKind: typeof environments.$inferSelect.kind };

async function directoryBytes(candidate: string): Promise<number> {
  if (!await pathExists(candidate)) return 0;
  const { diskUsageMs, diskUsageOutputBytes } = issuePilotConfig.limits.process;
  const { stdout } = await execFileAsync("du", ["-sk", "--", candidate], { encoding: "utf8", timeout: diskUsageMs, maxBuffer: diskUsageOutputBytes });
  const kibibytes = Number(stdout.trim().split(/\s+/, 1)[0]);
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 0) throw new Error("invalid_workspace_disk_usage");
  return kibibytes * 1024;
}

export class WorkspaceLifecycleManager {
  private readonly database: Database;
  private readonly stateRoot: string;
  private readonly engine: AgentController;
  private readonly worktrees: WorktreeManager;
  private readonly codeServer: CodeServer;
  private readonly prepareDevelopmentRuntime: (issue: { id: string; key: string }) => Promise<unknown>;
  readonly policy: WorkspaceRetentionPolicy;
  private tail = Promise.resolve();

  constructor(
    database: Database,
    stateRoot: string,
    engine: AgentController,
    policy: WorkspaceRetentionPolicy = issuePilotConfig.workspace,
    prepareRuntime?: (issue: { id: string; key: string }) => Promise<unknown>,
    codeServer: CodeServer = new CodeServerManager(stateRoot),
  ) {
    if (policy.highWaterBytes > 0 && policy.targetBytes >= policy.highWaterBytes) throw new Error("workspace_target_must_be_below_high_water");
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.engine = engine;
    this.policy = policy;
    this.worktrees = new WorktreeManager(this.stateRoot);
    this.codeServer = codeServer;
    this.prepareDevelopmentRuntime = prepareRuntime ?? ((issue) => prepareDevelopmentIssueRuntime(this.database, this.stateRoot, issue, this.codeServer, this.worktrees));
  }

  start(onError: (error: unknown) => void = () => undefined): () => void {
    if (this.policy.maintenanceIntervalMs === 0) return () => undefined;
    const timer = setInterval(() => { void this.maintain().catch(onError); }, this.policy.maintenanceIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async inspectIssue(issueId: string): Promise<WorkspaceInspection> {
    return this.exclusive(async () => {
      const issueRow = await this.issueRow(issueId);
      return this.inspectLocked(issueRow.issue, issueRow.workspace);
    });
  }

  async stats(): Promise<{ totalBytes: number; policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number }; workspaces: WorkspaceInspection[] }> {
    return this.exclusive(async () => {
      const issueRows = await this.issueRows();
      const inspections: WorkspaceInspection[] = [];
      for (const issueRow of issueRows) inspections.push(await this.inspectLocked(issueRow.issue, issueRow.workspace));
      return {
        totalBytes: inspections.reduce((total, workspace) => total + workspace.bytes, 0),
        policy: {
          retentionHours: Number.isFinite(this.policy.retentionMs) ? this.policy.retentionMs / 3_600_000 : null,
          highWaterBytes: this.policy.highWaterBytes,
          targetBytes: this.policy.targetBytes,
          maintenanceIntervalMinutes: this.policy.maintenanceIntervalMs / 60_000,
        },
        workspaces: inspections,
      };
    });
  }

  async releaseIssue(issueId: string): Promise<WorkspaceReleaseResult> {
    return this.exclusive(async () => {
      return this.releaseLocked(await this.issueRow(issueId));
    });
  }

  async reopenIssue(issueId: string): Promise<Issue> {
    return this.exclusive(async () => this.reopenLocked(await this.issueRow(issueId)));
  }

  async maintain(): Promise<{ totalBytes: number; released: WorkspaceReleaseResult[]; blocked: Array<{ issueKey: string; reason: string }> }> {
    return this.exclusive(async () => {
      const issueRows = await this.issueRows();
      const workspaceBytes = new Map<string, number>();
      let totalBytes = 0;
      for (const { issue } of issueRows) {
        const bytes = await directoryBytes(issueWorkspaceRoot(this.stateRoot, issue.key));
        workspaceBytes.set(issue.id, bytes);
        totalBytes += bytes;
      }

      const released: WorkspaceReleaseResult[] = [];
      const blocked: Array<{ issueKey: string; reason: string }> = [];
      const attemptedIssues = new Set<string>();
      const candidates = issueRows.filter(({ issue, environmentKind }) => environmentKind === "dev" && issue.status === "resolved" && (workspaceBytes.get(issue.id) ?? 0) > 0);
      const releaseCandidate = async (candidate: IssueRow) => {
        attemptedIssues.add(candidate.issue.id);
        try {
          const release = await this.releaseLocked(candidate);
          if (!release.alreadyReleased) {
            released.push(release);
            totalBytes = Math.max(0, totalBytes - (workspaceBytes.get(candidate.issue.id) ?? release.releasedBytes));
          }
        } catch (error) {
          if (error instanceof WorkspaceReleaseRefusal) blocked.push({ issueKey: candidate.issue.key, reason: error.reason });
          else throw error;
        }
      };

      if (Number.isFinite(this.policy.retentionMs)) {
        const retentionCutoff = Date.now() - this.policy.retentionMs;
        const retentionCandidates = [...candidates].sort((left, right) => (left.issue.resolvedAt?.getTime() ?? left.issue.updatedAt.getTime()) - (right.issue.resolvedAt?.getTime() ?? right.issue.updatedAt.getTime()));
        for (const candidate of retentionCandidates) {
          if (candidate.issue.resolvedAt && candidate.issue.resolvedAt.getTime() <= retentionCutoff) await releaseCandidate(candidate);
        }
      }
      if (this.policy.highWaterBytes > 0 && totalBytes > this.policy.highWaterBytes) {
        const quotaCandidates = [...candidates].sort((left, right) => (left.workspace?.updatedAt.getTime() ?? left.issue.updatedAt.getTime()) - (right.workspace?.updatedAt.getTime() ?? right.issue.updatedAt.getTime()));
        for (const candidate of quotaCandidates) {
          if (totalBytes <= this.policy.targetBytes) break;
          if (!attemptedIssues.has(candidate.issue.id)) await releaseCandidate(candidate);
        }
      }
      return { totalBytes, released, blocked };
    });
  }

  private async reopenLocked(issueRow: IssueRow): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (issue.status !== "resolved") throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    if (this.engine.isRunning(issue.id) || workspace && isWorkspaceBusy(workspace.status)) throw new WorkspaceRestoreRefusal("issue_already_running");
    if (issueRow.environmentKind !== "dev") return this.markReopened(issue);

    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    if (repositoryState === "development_workspace") {
      if (!await pathExists(workspaceRoot)) throw new WorkspaceRestoreRefusal("workspace_missing");
      await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
      return this.markReopened(issue);
    }
    if (repositoryState !== "development_snapshot") throw new WorkspaceRestoreRefusal("development_repository_state_invalid");
    if (await pathExists(workspaceRoot)) throw new WorkspaceRestoreRefusal("workspace_path_already_exists");

    let mode: ReturnType<typeof developmentWorktreeMode>;
    try { mode = developmentWorktreeMode(issue.type); }
    catch (error) { throw new WorkspaceRestoreRefusal(errorMessage(error)); }
    const names = repositoryWorkspaceNames(repositories.map((repository) => repository.url));
    const prepared: Array<{ repository: IssueRepository; name: string; workspacePath: string }> = [];
    try {
      for (const repository of repositories) {
        const restored = await this.worktrees.prepare({
          issueKey: issue.key,
          workspaceName: names.get(repository.url)!,
          url: repository.url,
          baseBranch: repository.baseBranch,
          mode,
          workingBranch: repository.workingBranch!,
          ...(repository.commitBefore ? { existingBaseCommit: repository.commitBefore } : {}),
        });
        prepared.push({ repository, name: names.get(repository.url)!, workspacePath: restored.workspacePath });
      }
      await assertManagedIssueWorkspaceLayout(workspaceRoot, prepared.map(({ workspacePath }) => workspacePath));
      const runtimeRoot = await prepareIssueRuntime(
        this.stateRoot,
        issue.key,
        prepared.map(({ name, workspacePath }) => ({ name, repositoryPath: workspacePath })),
        "write",
      );
      await prepareProjectWrappers(runtimeRoot);
      await this.codeServer.ensure(issue.key, runtimeRoot);
      return await this.database.transaction(async (transaction) => {
        const now = new Date();
        for (const restored of prepared) {
          await transaction.update(issueRepositories).set({ localPath: restored.workspacePath, updatedAt: now }).where(eq(issueRepositories.id, restored.repository.id));
        }
        await transaction.update(issueWorkspaces).set({ status: "ready", codeServerReady: true, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
        const [reopened] = await transaction.update(issues).set({ status: "open", resolvedAt: null, updatedAt: now }).where(and(eq(issues.id, issue.id), eq(issues.status, "resolved"))).returning();
        if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
        return reopened;
      });
    } catch (error) {
      let cleanupFailed = false;
      for (const restored of prepared.reverse()) {
        try { await this.worktrees.remove(restored.repository.url, restored.workspacePath); } catch { cleanupFailed = true; }
      }
      if (!cleanupFailed) await rm(workspaceRoot, { recursive: true, force: true });
      try { await this.prepareDevelopmentRuntime({ id: issue.id, key: issue.key }); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw new WorkspaceRestoreRefusal("workspace_restore_cleanup_failed");
      throw error instanceof WorkspaceRestoreRefusal ? error : new WorkspaceRestoreRefusal(errorMessage(error));
    }
  }

  private async markReopened(issue: Issue): Promise<Issue> {
    const [reopened] = await this.database.update(issues).set({ status: "open", resolvedAt: null, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, "resolved"))).returning();
    if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    return reopened;
  }

  private async releaseLocked(issueRow: IssueRow): Promise<WorkspaceReleaseResult> {
    const { issue, workspace } = issueRow;
    if (issueRow.environmentKind !== "dev") throw new WorkspaceReleaseRefusal("workspace_not_development");
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const inspection = await this.inspectLocked(issue, workspace, repositories);
    if (["issue_not_resolved", "issue_already_running", "workspace_busy"].includes(inspection.blockedReason ?? "")) throw new WorkspaceReleaseRefusal(inspection.blockedReason!);
    if (repositoryState === "development_snapshot") {
      if (inspection.blockedReason !== "workspace_missing") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
      if (!workspace?.codeServerReady) await this.restoreDevelopmentRuntime(issue);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
    }
    if (repositoryState !== "development_workspace") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
    if (inspection.blockedReason === "workspace_missing") {
      try { assertManagedIssueWorkspacePaths(issueWorkspaceRoot(this.stateRoot, issue.key), repositories.map((repository) => repository.localPath!)); }
      catch (error) { throw new WorkspaceReleaseRefusal(errorMessage(error)); }
      await this.markReleased(issue.id);
      await this.restoreDevelopmentRuntime(issue);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
    }
    if (!inspection.releasable) throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "workspace_not_releasable");
    let mode: ReturnType<typeof developmentWorktreeMode>;
    try { mode = developmentWorktreeMode(issue.type); }
    catch (error) { throw new WorkspaceReleaseRefusal(errorMessage(error)); }
    await this.engine.closeSession(issue.id);
    const names = repositoryWorkspaceNames(repositories.map((repository) => repository.url));
    try {
      await this.worktrees.removeBatch({
        issueKey: issue.key,
        mode,
        worktrees: repositories.map((repository) => ({
          workspaceName: names.get(repository.url)!,
          url: repository.url,
          workingBranch: repository.workingBranch!,
          workspacePath: repository.localPath!,
        })),
        finalize: async () => {
          await rmdir(issueWorkspaceRoot(this.stateRoot, issue.key));
          await this.markReleased(issue.id);
        },
      });
    } catch (error) {
      if (error instanceof WorktreeRollbackFailure) throw new WorkspaceReleaseRefusal("workspace_release_rollback_failed");
      if (error instanceof Error && ["workspace_has_changes", "workspace_repository_missing"].includes(error.message)) throw new WorkspaceReleaseRefusal(error.message);
      if (error && typeof error === "object" && "code" in error && error.code === "ENOTEMPTY") throw new WorkspaceReleaseRefusal("workspace_has_untracked_files");
      throw error;
    }
    await this.restoreDevelopmentRuntime(issue);
    return { issueKey: issue.key, releasedBytes: inspection.bytes, alreadyReleased: false };
  }

  private async restoreDevelopmentRuntime(issue: Issue): Promise<void> {
    try {
      await this.prepareDevelopmentRuntime({ id: issue.id, key: issue.key });
    } catch (error) {
      const reason = errorMessage(error);
      await this.database.update(issueWorkspaces).set({ codeServerReady: false, lastError: reason, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    }
  }

  private async markReleased(issueId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.update(issueRepositories).set({ localPath: null, updatedAt: new Date() }).where(eq(issueRepositories.issueId, issueId));
      await transaction.update(issueWorkspaces).set({ status: "stopped", codeServerReady: false, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
    });
  }

  private async inspectLocked(issue: Issue, workspace: IssueWorkspace | null, knownRepositories?: IssueRepository[]): Promise<WorkspaceInspection> {
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    const bytes = await directoryBytes(workspaceRoot);
    let blockedReason: string | null = null;
    if (issue.status !== "resolved") blockedReason = "issue_not_resolved";
    else if (this.engine.isRunning(issue.id)) blockedReason = "issue_already_running";
    else if (workspace && isWorkspaceBusy(workspace.status)) blockedReason = "workspace_busy";
    else if (!await pathExists(workspaceRoot)) blockedReason = "workspace_missing";
    else {
      const repositories = knownRepositories ?? await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      if (classifyRepositoryState(repositories) !== "development_workspace") blockedReason = "development_repository_state_invalid";
      else try {
        await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
        for (const repository of repositories) await this.worktrees.assertClean(repository.localPath!);
      } catch (error) {
        blockedReason = errorMessage(error);
      }
    }
    return {
      issueId: issue.id,
      issueKey: issue.key,
      issueStatus: issue.status,
      workspaceStatus: workspace?.status ?? "not_created",
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      bytes,
      releasable: blockedReason === null,
      blockedReason,
    };
  }

  private async issueRow(issueId: string): Promise<IssueRow> {
    const [issueRow] = await this.database.select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind }).from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id)).where(eq(issues.id, issueId)).limit(1);
    if (!issueRow) throw new Error("issue_not_found");
    return issueRow;
  }

  private issueRows(): Promise<IssueRow[]> {
    return this.database.select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind }).from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id)).orderBy(asc(issues.updatedAt));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const preceding = this.tail;
    let complete!: () => void;
    const queued = new Promise<void>((resolve) => { complete = resolve; });
    this.tail = preceding.catch(() => undefined).then(() => queued);
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      complete();
    }
  }
}
