import { execFile } from "node:child_process";
import { rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { and, asc, eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { AgentController, AgentReservation } from "../agent/engine.ts";
import type { Database } from "../db/client.ts";
import { environments, issueRepositories, issues, issueWorkspaces } from "../db/schema.ts";
import { errorMessage, isWorkspaceBusy, type IssueStatus, type WorkspaceStatus } from "../domain/contracts.ts";
import { KeyedSerialQueue, SerialQueue } from "../serial.ts";
import { CodeServerManager } from "./code-server.ts";
import { prepareDevelopmentIssueRuntime } from "./development.ts";
import { issueRepositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure } from "./git.ts";
import { developmentWorktreeMode, IssueProjectManager } from "./project.ts";
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
  private readonly projects: IssueProjectManager;
  private readonly codeServer: CodeServer;
  private readonly prepareDevelopmentRuntime: (issue: { id: string; key: string }) => Promise<unknown>;
  readonly policy: WorkspaceRetentionPolicy;
  private readonly queue = new SerialQueue();
  private readonly issueQueue = new KeyedSerialQueue();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

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
    this.projects = new IssueProjectManager(this.database, this.stateRoot, this.worktrees);
    this.codeServer = codeServer;
    this.prepareDevelopmentRuntime = prepareRuntime ?? ((issue) => prepareDevelopmentIssueRuntime(this.database, this.stateRoot, issue, this.codeServer, this.worktrees));
  }

  start(onError: (error: unknown) => void = () => undefined): () => Promise<void> {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (this.policy.maintenanceIntervalMs > 0) {
      timer = setInterval(() => {
        void this.maintain().catch((error) => {
          try { onError(error); } catch {
            // A maintenance reporter cannot create an unhandled timer rejection.
          }
        });
      }, this.policy.maintenanceIntervalMs);
      timer.unref();
    }
    return () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      this.stopping = true;
      this.stopPromise ??= Promise.all([this.queue.idle(), this.issueQueue.idle()]).then(() => undefined);
      return this.stopPromise;
    };
  }

  async inspectIssue(issueId: string): Promise<WorkspaceInspection> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.issueQueue.run(issueId, async () => {
      const issueRow = await this.issueRow(issueId);
      return this.inspectLocked(issueRow.issue, issueRow.workspace);
    });
  }

  async stats(): Promise<{ totalBytes: number; policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number }; workspaces: WorkspaceInspection[] }> {
    return this.exclusive(async () => {
      const issueRows = await this.issueRows();
      const inspections: WorkspaceInspection[] = [];
      for (const issueRow of issueRows) inspections.push(await this.issueQueue.run(issueRow.issue.id, () => this.inspectLocked(issueRow.issue, issueRow.workspace)));
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
    return this.exclusive(() => this.issueQueue.run(issueId, async () => {
      try { return await this.engine.runExclusive([issueId], async (reservation) => this.releaseLocked(await this.issueRow(issueId), reservation)); }
      catch (error) {
        if (error instanceof Error && error.message === "issue_already_running") throw new WorkspaceReleaseRefusal(error.message);
        throw error;
      }
    }));
  }

  async reopenIssue(issueId: string): Promise<Issue> {
    return this.exclusive(() => this.issueQueue.run(issueId, async () => {
      try { return await this.engine.runExclusive([issueId], async (reservation) => this.reopenLocked(await this.issueRow(issueId), reservation)); }
      catch (error) {
        if (error instanceof Error && error.message === "issue_already_running") throw new WorkspaceRestoreRefusal(error.message);
        throw error;
      }
    }));
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
          const release = await this.issueQueue.run(candidate.issue.id, () => this.engine.runExclusive([candidate.issue.id], (reservation) => this.releaseLocked(candidate, reservation)));
          if (!release.alreadyReleased) {
            released.push(release);
            totalBytes = Math.max(0, totalBytes - (workspaceBytes.get(candidate.issue.id) ?? release.releasedBytes));
          }
        } catch (error) {
          if (error instanceof WorkspaceReleaseRefusal) blocked.push({ issueKey: candidate.issue.key, reason: error.reason });
          else if (error instanceof Error && error.message === "issue_already_running") blocked.push({ issueKey: candidate.issue.key, reason: error.message });
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

  private async reopenLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (issue.status !== "resolved") throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    if (this.engine.isRunning(issue.id) || workspace && isWorkspaceBusy(workspace.status)) throw new WorkspaceRestoreRefusal("issue_already_running");
    if (issueRow.environmentKind !== "dev") {
      await reservation.closeSession(issue.id);
      return this.markReopened(issue);
    }

    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    if (repositoryState === "development_workspace") {
      if (!await pathExists(workspaceRoot)) throw new WorkspaceRestoreRefusal("workspace_missing");
      try { issueRepositoryWorkspaceNames(repositories); }
      catch (error) { throw new WorkspaceRestoreRefusal(errorMessage(error)); }
      await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
      await reservation.closeSession(issue.id);
      return this.markReopened(issue);
    }
    if (repositoryState !== "development_snapshot") throw new WorkspaceRestoreRefusal("development_repository_state_invalid");
    if (await pathExists(workspaceRoot)) throw new WorkspaceRestoreRefusal("workspace_path_already_exists");

    try { developmentWorktreeMode(issue.type); issueRepositoryWorkspaceNames(repositories); }
    catch (error) { throw new WorkspaceRestoreRefusal(errorMessage(error)); }
    await reservation.closeSession(issue.id);
    try {
      return await this.projects.restoreDevelopmentWorkspace(
        issue,
        repositories,
        this.codeServer,
        () => this.restoreDevelopmentRuntime(issue),
        (prepared, names) => this.database.transaction(async (transaction) => {
          const now = new Date();
          for (const [index, repository] of repositories.entries()) {
            await transaction.update(issueRepositories).set({ localPath: prepared[index]!.workspacePath, workspaceName: names.get(repository.url)!, updatedAt: now }).where(eq(issueRepositories.id, repository.id));
          }
          await transaction.update(issueWorkspaces).set({ status: "ready", codeServerReady: true, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
          const [reopened] = await transaction.update(issues).set({ status: "open", resolvedAt: null, updatedAt: now }).where(and(eq(issues.id, issue.id), eq(issues.status, "resolved"))).returning();
          if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
          return reopened;
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "workspace_restore_cleanup_failed") throw new WorkspaceRestoreRefusal(error.message);
      throw error instanceof WorkspaceRestoreRefusal ? error : new WorkspaceRestoreRefusal(errorMessage(error));
    }
  }

  private async markReopened(issue: Issue): Promise<Issue> {
    const [reopened] = await this.database.update(issues).set({ status: "open", resolvedAt: null, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, "resolved"))).returning();
    if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    return reopened;
  }

  private async releaseLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<WorkspaceReleaseResult> {
    const { issue, workspace } = issueRow;
    if (issueRow.environmentKind !== "dev") throw new WorkspaceReleaseRefusal("workspace_not_development");
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const inspection = await this.inspectLocked(issue, workspace, repositories);
    if (["issue_not_resolved", "issue_already_running", "workspace_busy"].includes(inspection.blockedReason ?? "")) throw new WorkspaceReleaseRefusal(inspection.blockedReason!);
    let names: Map<string, string>;
    try { names = issueRepositoryWorkspaceNames(repositories); }
    catch (error) { throw new WorkspaceReleaseRefusal(errorMessage(error)); }
    if (repositoryState === "development_snapshot") {
      if (inspection.blockedReason !== "workspace_missing") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
      await reservation.closeSession(issue.id);
      if (!workspace?.codeServerReady) await this.restoreDevelopmentRuntime(issue);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
    }
    if (repositoryState !== "development_workspace") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
    if (inspection.blockedReason === "workspace_missing") {
      try { assertManagedIssueWorkspacePaths(issueWorkspaceRoot(this.stateRoot, issue.key), repositories.map((repository) => repository.localPath!)); }
      catch (error) { throw new WorkspaceReleaseRefusal(errorMessage(error)); }
      await reservation.closeSession(issue.id);
      await this.markReleased(issue.id, repositories);
      await this.restoreDevelopmentRuntime(issue);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
    }
    if (!inspection.releasable) throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "workspace_not_releasable");
    let mode: ReturnType<typeof developmentWorktreeMode>;
    try { mode = developmentWorktreeMode(issue.type); }
    catch (error) { throw new WorkspaceReleaseRefusal(errorMessage(error)); }
    await reservation.closeSession(issue.id);
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
          await this.markReleased(issue.id, repositories);
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

  private async markReleased(issueId: string, repositories: IssueRepository[]): Promise<void> {
    const names = issueRepositoryWorkspaceNames(repositories);
    await this.database.transaction(async (transaction) => {
      const now = new Date();
      for (const repository of repositories) {
        await transaction.update(issueRepositories).set({ localPath: null, workspaceName: names.get(repository.url)!, updatedAt: now }).where(eq(issueRepositories.id, repository.id));
      }
      await transaction.update(issueWorkspaces).set({ status: "stopped", codeServerReady: false, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issueId));
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
        issueRepositoryWorkspaceNames(repositories);
        await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
        for (const repository of repositories) await this.worktrees.assertClean(repository.url, repository.localPath!);
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
    if (!issueRow.workspace) throw new Error(`issue_workspace_missing:${issueRow.issue.key}`);
    return issueRow;
  }

  private async issueRows(): Promise<IssueRow[]> {
    const rows = await this.database.select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind }).from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id)).orderBy(asc(issues.updatedAt));
    const invalid = rows.find((row) => !row.workspace);
    if (invalid) throw new Error(`issue_workspace_missing:${invalid.issue.key}`);
    return rows;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.queue.run(operation);
  }
}
