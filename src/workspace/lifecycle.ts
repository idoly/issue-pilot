import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { and, asc, eq, inArray } from "drizzle-orm";
import pMap from "p-map";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters } from "../configuration/parameters.ts";
import type { ApplicationParameters } from "../configuration/contracts.ts";
import type { AgentController, AgentReservation } from "../agent/engine.ts";
import { stableErrorReason } from "../diagnostics.ts";
import type { Database } from "../db/client.ts";
import { agentSessions, environments, issueRelations, issueRepositories, issues, issueWorkspaces } from "../db/schema.ts";
import { errorMessage, isWorkspaceBusy, type IssueStatus, type WorkspaceStatus } from "../domain/contracts.ts";
import { KeyedSerialQueue, SerialQueue } from "../serial.ts";
import { issueRepositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure } from "./git.ts";
import { developmentWorktreeMode, IssueProjectManager, replaceIssueRepositoryRows } from "./project.ts";
import { assertReleasedIssueRuntime } from "./runtime.ts";
import { assertManagedIssueWorkspaceLayout, classifyRepositoryState, gitRoot, issueRoot, pathExists } from "./state.ts";

const execFileAsync = promisify(execFile);

export interface WorkspaceLifecyclePolicy {
  retentionMs: number;
  highWaterBytes: number;
  targetBytes: number;
  maintenanceIntervalMs: number;
  taskConcurrency: number;
}

export function workspaceLifecyclePolicy(parameters: ApplicationParameters = applicationParameters()): WorkspaceLifecyclePolicy {
  return {
    retentionMs: parameters.workspaceRetentionMs,
    highWaterBytes: parameters.workspaceHighWaterBytes,
    targetBytes: parameters.workspaceTargetBytes,
    maintenanceIntervalMs: parameters.workspaceMaintenanceIntervalMs,
    taskConcurrency: issuePilotConfig.workspace.taskConcurrency,
  };
}

function assertWorkspaceLifecyclePolicy(policy: WorkspaceLifecyclePolicy): void {
  if (policy.highWaterBytes > 0 && policy.targetBytes >= policy.highWaterBytes) throw new Error("workspace_target_must_be_below_high_water");
  if (!Number.isSafeInteger(policy.taskConcurrency) || policy.taskConcurrency < 1) throw new Error("workspace_task_concurrency_invalid");
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

interface MeasuredWorkspaceRelease extends WorkspaceReleaseResult {
  remainingBytes: number;
}

type WorkspaceStatistics = {
  sampledAt: string;
  totalBytes: number;
  sharedGitBytes: number;
  policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number };
  workspaces: WorkspaceInspection[];
};

class WorkspaceRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class WorkspaceReleaseRefusal extends WorkspaceRefusal {}
export class WorkspaceRestoreRefusal extends WorkspaceRefusal {}
export class WorkspaceConversionRefusal extends WorkspaceRefusal {}
export class WorkspaceScopeMigrationRefusal extends WorkspaceRefusal {}

type Issue = typeof issues.$inferSelect;
type IssueWorkspace = typeof issueWorkspaces.$inferSelect;
type TransitionAudit = (writer: Pick<Database, "insert">, now: Date) => Promise<void>;
type IssueRepository = typeof issueRepositories.$inferSelect;
type IssueRow = { issue: Issue; workspace: IssueWorkspace | null; environmentKind: typeof environments.$inferSelect.kind };

async function directoryBytes(candidate: string): Promise<number> {
  if (!(await pathExists(candidate))) return 0;
  const { diskUsageMs, diskUsageOutputBytes } = issuePilotConfig.limits.process;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("du", ["-sk", "--", candidate], { encoding: "utf8", timeout: diskUsageMs, maxBuffer: diskUsageOutputBytes }));
  } catch (error) {
    // du exits 1 for unreadable entries (e.g. a model-run `chmod 000`) yet still prints the measurable total.
    // Accept that lower bound so one Issue cannot break statistics, maintenance or startup; timeouts still fail.
    const partial = error && typeof error === "object" && "code" in error && error.code === 1 && "stdout" in error && typeof error.stdout === "string" ? error.stdout : undefined;
    if (partial === undefined || !partial.trim()) throw error;
    stdout = partial;
  }
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
  private readonly prepareDevelopmentRuntime: (issue: Pick<Issue, "id" | "key" | "type">) => Promise<unknown>;
  private currentPolicy: WorkspaceLifecyclePolicy;
  private readonly queue = new SerialQueue();
  private readonly issueQueue = new KeyedSerialQueue();
  private statsPromise: Promise<WorkspaceStatistics> | undefined;
  private statisticsCache: { createdAt: number; value: WorkspaceStatistics } | undefined;
  private workspaceBytesCache: { expiresAt: number; values: Map<string, number>; sharedGitBytes?: number } | undefined;
  private maintenanceTimer: { handle: ReturnType<typeof setInterval> | undefined; report: (error: unknown) => void } | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    database: Database,
    stateRoot: string,
    engine: AgentController,
    policy: WorkspaceLifecyclePolicy = workspaceLifecyclePolicy(),
    prepareRuntime?: (issue: Pick<Issue, "id" | "key" | "type">) => Promise<unknown>,
  ) {
    assertWorkspaceLifecyclePolicy(policy);
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.engine = engine;
    this.currentPolicy = policy;
    this.worktrees = new WorktreeManager(this.stateRoot);
    this.projects = new IssueProjectManager(this.database, this.stateRoot, this.worktrees);
    this.prepareDevelopmentRuntime = prepareRuntime ?? ((issue) => this.projects.hydrateDevelopmentRuntime(issue));
  }

  start(onError: (error: unknown) => void = () => undefined): () => Promise<void> {
    const report = (error: unknown) => {
      try {
        onError(error);
      } catch {
        /* Reporting must not interrupt maintenance. */
      }
    };
    this.maintenanceTimer = { handle: undefined, report };
    this.scheduleMaintenance();
    return () => {
      if (this.maintenanceTimer?.handle) clearInterval(this.maintenanceTimer.handle);
      this.maintenanceTimer = undefined;
      this.stopping = true;
      this.stopPromise ??= Promise.all([this.queue.idle(), this.issueQueue.idle()]).then(() => undefined);
      return this.stopPromise;
    };
  }

  get policy(): WorkspaceLifecyclePolicy {
    return this.currentPolicy;
  }

  /** A changed policy applies from the next maintenance cycle and statistics sample; a running cycle keeps its values. */
  updatePolicy(policy: WorkspaceLifecyclePolicy): void {
    assertWorkspaceLifecyclePolicy(policy);
    const rescheduled = policy.maintenanceIntervalMs !== this.currentPolicy.maintenanceIntervalMs;
    this.currentPolicy = policy;
    this.statsPromise = undefined;
    this.invalidateMeasurements();
    if (rescheduled) this.scheduleMaintenance();
  }

  private scheduleMaintenance(): void {
    const timer = this.maintenanceTimer;
    if (!timer) return;
    if (timer.handle) clearInterval(timer.handle);
    timer.handle = undefined;
    if (this.currentPolicy.maintenanceIntervalMs <= 0) return;
    timer.handle = setInterval(() => {
      void this.maintain()
        .then((result) => {
          for (const failure of result.failures) timer.report(new Error(`workspace_auto_release_failed:${failure.issueKey}`, { cause: failure.error }));
        })
        .catch(timer.report);
    }, this.currentPolicy.maintenanceIntervalMs);
    timer.handle.unref();
  }

  // Statistics reuse the last sample for one maintenance cycle; the page shows sampledAt and can force a refresh.
  private get workspaceBytesCacheMs(): number {
    return this.currentPolicy.maintenanceIntervalMs > 0 ? this.currentPolicy.maintenanceIntervalMs : 5_000;
  }

  async inspectIssue(issueId: string): Promise<WorkspaceInspection> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.issueQueue.run(issueId, async () => {
      const issueRow = await this.issueRow(issueId);
      return this.inspectLocked(issueRow);
    });
  }

  async stats(refresh = false): Promise<WorkspaceStatistics> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    // A refresh must not reuse a scan that may have started from cached measurements.
    if (this.statsPromise && !refresh) return this.statsPromise;
    if (!refresh && this.statisticsCache && Date.now() - this.statisticsCache.createdAt <= this.workspaceBytesCacheMs) return this.statisticsCache.value;
    const request = this.exclusive(async () => {
      const policy = this.policy;
      const issueRows = await this.issueRows();
      const repositories = await this.database.select().from(issueRepositories);
      const repositoriesByIssue = new Map<string, IssueRepository[]>();
      for (const repository of repositories) {
        const group = repositoriesByIssue.get(repository.issueId) ?? [];
        group.push(repository);
        repositoriesByIssue.set(repository.issueId, group);
      }
      const cached = !refresh && this.workspaceBytesCache && this.workspaceBytesCache.expiresAt > Date.now() ? this.workspaceBytesCache : undefined;
      const measuredBytes = cached?.values;
      const inspections = await pMap(
        issueRows,
        (issueRow) => this.issueQueue.run(issueRow.issue.id, () => this.inspectLocked(issueRow, repositoriesByIssue.get(issueRow.issue.id) ?? [], measuredBytes?.get(issueRow.issue.id))),
        { concurrency: policy.taskConcurrency, stopOnError: false },
      );
      const sharedGitBytes = cached?.sharedGitBytes ?? (await directoryBytes(gitRoot(this.stateRoot)));
      this.workspaceBytesCache = { expiresAt: Date.now() + this.workspaceBytesCacheMs, values: new Map(inspections.map((workspace) => [workspace.issueId, workspace.bytes])), sharedGitBytes };
      const value: WorkspaceStatistics = {
        sampledAt: new Date().toISOString(),
        totalBytes: inspections.reduce((total, workspace) => total + workspace.bytes, 0),
        sharedGitBytes,
        policy: {
          retentionHours: Number.isFinite(policy.retentionMs) ? policy.retentionMs / 3_600_000 : null,
          highWaterBytes: policy.highWaterBytes,
          targetBytes: policy.targetBytes,
          maintenanceIntervalMinutes: policy.maintenanceIntervalMs / 60_000,
        },
        workspaces: inspections,
      };
      // A policy saved during the scan must not be hidden behind this sample.
      if (policy === this.policy) this.statisticsCache = { createdAt: Date.now(), value };
      return value;
    });
    this.statsPromise = request;
    try {
      return await request;
    } finally {
      if (this.statsPromise === request) this.statsPromise = undefined;
    }
  }

  async releaseIssue(issueId: string, authorize?: () => Promise<unknown>): Promise<WorkspaceReleaseResult> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => {
        const { issueKey, releasedBytes, alreadyReleased } = await this.releaseLocked(await this.issueRow(issueId), reservation);
        return { issueKey, releasedBytes, alreadyReleased };
      },
      (error) => {
        if (error instanceof Error && error.message === "issue_already_running") throw new WorkspaceReleaseRefusal(error.message);
        throw error;
      },
      authorize,
    );
  }

  async reopenIssue(issueId: string, authorize?: () => Promise<unknown>): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.reopenLocked(await this.issueRow(issueId), reservation),
      (error) => {
        if (error instanceof WorkspaceRestoreRefusal) throw error;
        throw new WorkspaceRestoreRefusal(errorMessage(error));
      },
      authorize,
    );
  }

  async convertIssueToDevelopment(issueId: string, expectedIssueUpdatedAt?: string, recordTransition?: TransitionAudit, authorize?: () => Promise<unknown>): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.convertLocked(await this.issueRow(issueId), reservation, expectedIssueUpdatedAt, recordTransition),
      (error) => {
        if (error instanceof WorkspaceConversionRefusal) throw error;
        throw new WorkspaceConversionRefusal(errorMessage(error));
      },
      authorize,
    );
  }

  async migrateDevelopmentIssueScope(
    issueId: string,
    target: { serviceId: string; environmentId: string },
    expectedIssueUpdatedAt: string,
    recordTransition?: TransitionAudit,
    authorize?: () => Promise<unknown>,
  ): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.migrateDevelopmentScopeLocked(await this.issueRow(issueId), target, expectedIssueUpdatedAt, reservation, recordTransition),
      (error) => {
        if (error instanceof WorkspaceScopeMigrationRefusal) throw error;
        const message = errorMessage(error);
        if (message === "workspace_has_changes") throw new WorkspaceScopeMigrationRefusal("scope_transition_removed_repository_changed");
        throw new WorkspaceScopeMigrationRefusal(message);
      },
      authorize,
    );
  }

  async maintain(): Promise<{ totalBytes: number; released: WorkspaceReleaseResult[]; blocked: Array<{ issueKey: string; reason: string }>; failures: Array<{ issueKey: string; error: unknown }> }> {
    return this.exclusive(async () => {
      // Automatic release changes workspace state, so a cached sample must not outlive this maintenance pass.
      this.invalidateMeasurements();
      const policy = this.policy;
      const issueRows = await this.issueRows();
      const failures: Array<{ issueKey: string; error: unknown }> = [];
      // Measure per Issue: one unmeasurable tree must not abort startup or every later maintenance cycle.
      const measuredWorkspaces = await pMap(
        issueRows,
        async ({ issue }) => {
          try {
            return { issueId: issue.id, bytes: await directoryBytes(issueRoot(this.stateRoot, issue.key)) };
          } catch (error) {
            failures.push({ issueKey: issue.key, error });
            return undefined;
          }
        },
        { concurrency: policy.taskConcurrency },
      );
      const measured = measuredWorkspaces.filter((workspace): workspace is { issueId: string; bytes: number } => workspace !== undefined);
      const measurementIncomplete = measured.length !== issueRows.length;
      const workspaceBytes = new Map(measured.map(({ issueId, bytes }) => [issueId, bytes]));
      let totalBytes = measured.reduce((total, { bytes }) => total + bytes, 0);
      const updateBytes = (issueId: string, remainingBytes: number) => {
        totalBytes = Math.max(0, totalBytes - (workspaceBytes.get(issueId) ?? 0) + remainingBytes);
        workspaceBytes.set(issueId, remainingBytes);
      };

      const released: WorkspaceReleaseResult[] = [];
      const blocked: Array<{ issueKey: string; reason: string }> = [];
      const attemptedIssues = new Set<string>();
      // An unmeasured workspace has no known bytes, so it is left for the next cycle instead of being released blind.
      const candidates = issueRows.filter(
        ({ issue, environmentKind }) => workspaceBytes.has(issue.id) && environmentKind === "dev" && issue.status === "resolved" && workspaceBytes.get(issue.id)! > 0,
      );
      const releaseCandidate = async (candidate: IssueRow, runtimeRecoveryOnly = false) => {
        attemptedIssues.add(candidate.issue.id);
        try {
          const measured = await this.issueQueue.run(candidate.issue.id, () =>
            this.engine.runExclusive([candidate.issue.id], async (reservation) => {
              const current = await this.issueRow(candidate.issue.id);
              if (runtimeRecoveryOnly) {
                const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, current.issue.id));
                if (classifyRepositoryState(repositories) !== "development_snapshot") return undefined;
              }
              return this.releaseLocked(current, reservation);
            }),
          );
          if (!measured) {
            attemptedIssues.delete(candidate.issue.id);
            return;
          }
          updateBytes(candidate.issue.id, measured.remainingBytes);
          if (!measured.alreadyReleased) {
            const { issueKey, releasedBytes, alreadyReleased } = measured;
            released.push({ issueKey, releasedBytes, alreadyReleased });
          }
        } catch (error) {
          try {
            updateBytes(candidate.issue.id, await directoryBytes(issueRoot(this.stateRoot, candidate.issue.key)));
          } catch (measurementError) {
            // Keep the earlier estimate and continue with other candidates; this Issue reports both failures.
            failures.push({ issueKey: candidate.issue.key, error: new AggregateError([error, measurementError], "workspace_maintenance_measurement_failed") });
            return;
          }
          if (error instanceof WorkspaceReleaseRefusal) blocked.push({ issueKey: candidate.issue.key, reason: error.reason });
          else if (error instanceof Error && error.message === "issue_already_running") blocked.push({ issueKey: candidate.issue.key, reason: error.message });
          else failures.push({ issueKey: candidate.issue.key, error });
        }
      };

      // Finish an already-recorded release even after disk pressure has gone away.
      // The reserved recheck permits only snapshot-view recovery, never new code removal.
      for (const candidate of candidates) if (candidate.workspace?.status === "stopped" && !candidate.workspace.runtimeReady) await releaseCandidate(candidate, true);
      if (Number.isFinite(policy.retentionMs)) {
        const retentionCutoff = Date.now() - policy.retentionMs;
        const retentionCandidates = [...candidates].sort(
          (left, right) => (left.issue.resolvedAt?.getTime() ?? left.issue.updatedAt.getTime()) - (right.issue.resolvedAt?.getTime() ?? right.issue.updatedAt.getTime()),
        );
        for (const candidate of retentionCandidates) {
          if (!attemptedIssues.has(candidate.issue.id) && candidate.issue.resolvedAt && candidate.issue.resolvedAt.getTime() <= retentionCutoff) await releaseCandidate(candidate);
        }
      }
      if (policy.highWaterBytes > 0 && totalBytes > policy.highWaterBytes) {
        const quotaCandidates = [...candidates].sort(
          (left, right) => (left.workspace?.updatedAt.getTime() ?? left.issue.updatedAt.getTime()) - (right.workspace?.updatedAt.getTime() ?? right.issue.updatedAt.getTime()),
        );
        for (const candidate of quotaCandidates) {
          if (totalBytes <= policy.targetBytes) break;
          if (!attemptedIssues.has(candidate.issue.id)) await releaseCandidate(candidate);
        }
      }
      // A partial total must not seed the statistics cache; the next stats call rescans instead.
      if (!measurementIncomplete) this.workspaceBytesCache = { expiresAt: Date.now() + this.workspaceBytesCacheMs, values: workspaceBytes };
      return { totalBytes, released, blocked, failures };
    });
  }

  private async migrateDevelopmentScopeLocked(
    issueRow: IssueRow,
    target: { serviceId: string; environmentId: string },
    expectedIssueUpdatedAt: string,
    reservation: AgentReservation,
    recordTransition?: TransitionAudit,
  ): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (issue.updatedAt.toISOString() !== expectedIssueUpdatedAt) throw new WorkspaceScopeMigrationRefusal("scope_transition_plan_stale");
    const [targetEnvironment] = await this.database.select().from(environments).where(eq(environments.id, target.environmentId)).limit(1);
    if (
      issueRow.environmentKind !== "dev" ||
      targetEnvironment?.kind !== "dev" ||
      !["defect_fix", "feature_development"].includes(issue.type) ||
      !["open", "pending"].includes(issue.status) ||
      workspace?.status !== "ready"
    )
      throw new WorkspaceScopeMigrationRefusal("issue_not_migratable_between_development_scopes");

    await reservation.closeSession(issue.id);
    const migrated = await this.projects.migrateDevelopmentScope(issue, target, async ({ prepared, repositories, existingRepositories, names }) => {
      return this.database.transaction(async (transaction) => {
        const now = new Date();
        const existingByUrl = new Map(existingRepositories.map((repository) => [repository.url, repository]));
        await replaceIssueRepositoryRows(
          transaction,
          issue.id,
          existingRepositories,
          repositories.map(({ repository }, index) => {
            const worktree = prepared[index]!;
            return {
              url: repository.url,
              baseBranch: worktree.baseBranch,
              workingBranch: worktree.workingBranch,
              localPath: worktree.workspacePath,
              workspaceName: names.get(repository.url)!,
              commitBefore: existingByUrl.get(repository.url)?.commitBefore ?? worktree.baseCommit,
            };
          }),
          now,
        );
        await transaction
          .update(agentSessions)
          .set({ workspacePath: issueRoot(this.stateRoot, issue.key), updatedAt: now })
          .where(eq(agentSessions.issueId, issue.id));
        await transaction.delete(issueRelations).where(eq(issueRelations.issueId, issue.id));
        const [updatedWorkspace] = await transaction
          .update(issueWorkspaces)
          .set({ status: "ready", runtimeReady: true, lastError: null, updatedAt: now })
          .where(and(eq(issueWorkspaces.issueId, issue.id), eq(issueWorkspaces.status, "ready")))
          .returning({ issueId: issueWorkspaces.issueId });
        const [updated] = await transaction
          .update(issues)
          .set({ serviceId: target.serviceId, environmentId: target.environmentId, updatedAt: now })
          .where(
            and(
              eq(issues.id, issue.id),
              eq(issues.serviceId, issue.serviceId),
              eq(issues.environmentId, issue.environmentId),
              eq(issues.type, issue.type),
              eq(issues.updatedAt, new Date(expectedIssueUpdatedAt)),
              inArray(issues.status, ["open", "pending"]),
            ),
          )
          .returning();
        if (!updatedWorkspace || !updated) throw new WorkspaceScopeMigrationRefusal("scope_transition_plan_stale");
        await recordTransition?.(transaction, now);
        return updated;
      });
    });
    reservation.enqueue(issue.id);
    return migrated;
  }

  private async convertLocked(issueRow: IssueRow, reservation: AgentReservation, expectedIssueUpdatedAt?: string, recordTransition?: TransitionAudit): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (expectedIssueUpdatedAt && issue.updatedAt.toISOString() !== expectedIssueUpdatedAt) throw new WorkspaceConversionRefusal("scope_transition_plan_stale");
    if (!["prod", "test"].includes(issueRow.environmentKind) || issue.type !== "smart_analysis" || !["open", "pending"].includes(issue.status) || workspace?.status !== "ready") {
      throw new WorkspaceConversionRefusal("issue_not_convertible_to_development");
    }
    const [developmentEnvironment] = await this.database.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    if (!developmentEnvironment) throw new WorkspaceConversionRefusal("development_environment_not_found");
    await reservation.closeSession(issue.id);
    try {
      const converted = await this.projects.convertReadOnlyToDevelopment(issue, developmentEnvironment.id, async ({ prepared, repositories, existingRepositories, names }) => {
        return this.database.transaction(async (transaction) => {
          const now = new Date();
          await replaceIssueRepositoryRows(
            transaction,
            issue.id,
            existingRepositories,
            repositories.map(({ repository }, index) => {
              const worktree = prepared[index]!;
              return {
                url: repository.url,
                baseBranch: worktree.baseBranch,
                workingBranch: worktree.workingBranch,
                localPath: worktree.workspacePath,
                workspaceName: names.get(repository.url)!,
                commitBefore: worktree.baseCommit,
              };
            }),
            now,
          );
          await transaction
            .update(agentSessions)
            .set({ workspacePath: issueRoot(this.stateRoot, issue.key), updatedAt: now })
            .where(eq(agentSessions.issueId, issue.id));
          await transaction.delete(issueRelations).where(eq(issueRelations.issueId, issue.id));
          const [updatedWorkspace] = await transaction
            .update(issueWorkspaces)
            .set({ status: "ready", runtimeReady: true, lastError: null, updatedAt: now })
            .where(and(eq(issueWorkspaces.issueId, issue.id), eq(issueWorkspaces.status, "ready")))
            .returning({ issueId: issueWorkspaces.issueId });
          const [converted] = await transaction
            .update(issues)
            .set({ environmentId: developmentEnvironment.id, type: "defect_fix", updatedAt: now })
            .where(and(eq(issues.id, issue.id), eq(issues.environmentId, issue.environmentId), eq(issues.type, "smart_analysis"), inArray(issues.status, ["open", "pending"])))
            .returning();
          if (!updatedWorkspace || !converted) throw new WorkspaceConversionRefusal("issue_changed_during_conversion");
          await recordTransition?.(transaction, now);
          return converted;
        });
      });
      reservation.enqueue(issue.id);
      return converted;
    } catch (error) {
      if (error instanceof WorkspaceConversionRefusal) throw error;
      throw new WorkspaceConversionRefusal(errorMessage(error));
    }
  }

  private async reopenLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (issue.status !== "resolved") throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    if (this.engine.isRunning(issue.id) || (workspace && isWorkspaceBusy(workspace.status))) throw new WorkspaceRestoreRefusal("issue_already_running");
    if (issueRow.environmentKind !== "dev") {
      await reservation.closeSession(issue.id);
      return this.markReopened(issue);
    }

    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    if (repositoryState === "development_workspace") {
      if (!(await pathExists(workspaceRoot))) throw new WorkspaceRestoreRefusal("workspace_missing");
      try {
        issueRepositoryWorkspaceNames(repositories);
      } catch (error) {
        throw new WorkspaceRestoreRefusal(errorMessage(error));
      }
      await assertManagedIssueWorkspaceLayout(
        workspaceRoot,
        repositories.map((repository) => repository.localPath!),
      );
      await reservation.closeSession(issue.id);
      return this.markReopened(issue);
    }
    if (repositoryState !== "development_snapshot") throw new WorkspaceRestoreRefusal("development_repository_state_invalid");
    try {
      const names = issueRepositoryWorkspaceNames(repositories);
      await assertReleasedIssueRuntime(
        this.stateRoot,
        issue.key,
        repositories.map((repository) => ({ name: names.get(repository.url)!, url: repository.url })),
      );
    } catch (error) {
      throw new WorkspaceRestoreRefusal(errorMessage(error));
    }

    try {
      developmentWorktreeMode(issue.type);
      issueRepositoryWorkspaceNames(repositories);
    } catch (error) {
      throw new WorkspaceRestoreRefusal(errorMessage(error));
    }
    await reservation.closeSession(issue.id);
    try {
      return await this.projects.restoreDevelopmentWorkspace(
        issue,
        repositories,
        () => this.restoreDevelopmentRuntime(issue),
        (prepared, names) =>
          this.database.transaction(async (transaction) => {
            const now = new Date();
            for (const [index, repository] of repositories.entries()) {
              await transaction
                .update(issueRepositories)
                .set({ localPath: prepared[index]!.workspacePath, workspaceName: names.get(repository.url)!, updatedAt: now })
                .where(eq(issueRepositories.id, repository.id));
            }
            await transaction.update(issueWorkspaces).set({ status: "ready", runtimeReady: true, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
            const [reopened] = await transaction
              .update(issues)
              .set({ status: "open", resolvedAt: null, updatedAt: now })
              .where(and(eq(issues.id, issue.id), eq(issues.status, "resolved")))
              .returning();
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
    const [reopened] = await this.database
      .update(issues)
      .set({ status: "open", resolvedAt: null, updatedAt: new Date() })
      .where(and(eq(issues.id, issue.id), eq(issues.status, "resolved")))
      .returning();
    if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    return reopened;
  }

  private async releaseLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<MeasuredWorkspaceRelease> {
    const { issue, workspace } = issueRow;
    if (issueRow.environmentKind !== "dev") throw new WorkspaceReleaseRefusal("workspace_not_development");
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const inspection = await this.inspectLocked(issueRow, repositories);
    if (["issue_not_resolved", "issue_already_running", "workspace_busy"].includes(inspection.blockedReason ?? "")) throw new WorkspaceReleaseRefusal(inspection.blockedReason!);
    let names: Map<string, string>;
    try {
      names = issueRepositoryWorkspaceNames(repositories);
    } catch (error) {
      throw new WorkspaceReleaseRefusal(errorMessage(error));
    }
    if (repositoryState === "development_snapshot") {
      // A snapshot Issue keeps its root; workspace_missing here means it was lost and must reach the refusal below.
      if (!["workspace_released", "workspace_runtime_not_ready", "workspace_runtime_restore_failed"].includes(inspection.blockedReason ?? ""))
        throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "development_repository_state_invalid");
      await reservation.closeSession(issue.id);
      if (!workspace?.runtimeReady) await this.restoreDevelopmentRuntime(issue);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true, remainingBytes: await directoryBytes(issueRoot(this.stateRoot, issue.key)) };
    }
    if (repositoryState !== "development_workspace") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
    // A missing root also lost the Issue's private Git store. Marking it released would let a later
    // restore rebuild from an older shared ref, so leave it for operator inspection like reopen does.
    if (inspection.blockedReason === "workspace_missing") throw new WorkspaceReleaseRefusal("workspace_missing");
    if (!inspection.releasable) throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "workspace_not_releasable");
    let mode: ReturnType<typeof developmentWorktreeMode>;
    try {
      mode = developmentWorktreeMode(issue.type);
    } catch (error) {
      throw new WorkspaceReleaseRefusal(errorMessage(error));
    }
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
          // The Issue working directory also owns durable scripts, attachments and checkpoints.
          // Release only the registered worktrees; preserve the directory and other files.
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
    const remainingBytes = await directoryBytes(issueRoot(this.stateRoot, issue.key));
    return { issueKey: issue.key, releasedBytes: Math.max(0, inspection.bytes - remainingBytes), alreadyReleased: false, remainingBytes };
  }

  private async restoreDevelopmentRuntime(issue: Issue): Promise<void> {
    try {
      await this.prepareDevelopmentRuntime(issue);
    } catch (error) {
      const reason = stableErrorReason(error, "workspace_runtime_restore_failed");
      try {
        await this.database.update(issueWorkspaces).set({ runtimeReady: false, lastError: reason, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
      } catch (stateError) {
        throw new AggregateError([error, stateError], "workspace_runtime_restore_failed");
      }
      throw new Error("workspace_runtime_restore_failed", { cause: error });
    }
  }

  private async markReleased(issueId: string, repositories: IssueRepository[]): Promise<void> {
    const names = issueRepositoryWorkspaceNames(repositories);
    await this.database.transaction(async (transaction) => {
      const now = new Date();
      for (const repository of repositories) {
        await transaction
          .update(issueRepositories)
          .set({ localPath: null, workspaceName: names.get(repository.url)!, updatedAt: now })
          .where(eq(issueRepositories.id, repository.id));
      }
      await transaction.update(issueWorkspaces).set({ status: "stopped", runtimeReady: false, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issueId));
    });
  }

  private async inspectLocked(issueRow: IssueRow, knownRepositories?: IssueRepository[], knownBytes?: number): Promise<WorkspaceInspection> {
    const { issue, workspace, environmentKind } = issueRow;
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    const bytes = knownBytes ?? (await directoryBytes(workspaceRoot));
    let blockedReason: string | null = null;
    if (environmentKind !== "dev") blockedReason = "workspace_not_development";
    else if (issue.status !== "resolved") blockedReason = "issue_not_resolved";
    else if (this.engine.isRunning(issue.id)) blockedReason = "issue_already_running";
    else if (workspace && isWorkspaceBusy(workspace.status)) blockedReason = "workspace_busy";
    else if (!(await pathExists(workspaceRoot))) blockedReason = "workspace_missing";
    else {
      const repositories = knownRepositories ?? (await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)));
      const state = classifyRepositoryState(repositories);
      if (state === "development_snapshot") {
        try {
          const names = issueRepositoryWorkspaceNames(repositories);
          if (!workspace?.runtimeReady) blockedReason = workspace?.lastError ? "workspace_runtime_restore_failed" : "workspace_runtime_not_ready";
          else {
            await assertReleasedIssueRuntime(
              this.stateRoot,
              issue.key,
              repositories.map((repository) => ({ name: names.get(repository.url)!, url: repository.url })),
            );
            blockedReason = "workspace_released";
          }
        } catch (error) {
          blockedReason = stableErrorReason(error, "workspace_runtime_inspection_failed");
        }
      } else if (state !== "development_workspace") blockedReason = "development_repository_state_invalid";
      else
        try {
          issueRepositoryWorkspaceNames(repositories);
          await assertManagedIssueWorkspaceLayout(
            workspaceRoot,
            repositories.map((repository) => repository.localPath!),
          );
          for (const repository of repositories) await this.worktrees.assertClean(repository.url, repository.localPath!, repository.workingBranch!);
        } catch (error) {
          blockedReason = stableErrorReason(error, "workspace_inspection_failed");
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
    const [issueRow] = await this.database
      .select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind })
      .from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issueRow) throw new Error("issue_not_found");
    if (!issueRow.workspace) throw new Error(`issue_workspace_missing:${issueRow.issue.key}`);
    return issueRow;
  }

  private async issueRows(): Promise<IssueRow[]> {
    const rows = await this.database
      .select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind })
      .from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
      .orderBy(asc(issues.updatedAt));
    const invalid = rows.find((row) => !row.workspace);
    if (invalid) throw new Error(`issue_workspace_missing:${invalid.issue.key}`);
    return rows;
  }

  private withIssueReservation<T>(issueId: string, operation: (reservation: AgentReservation) => Promise<T>, rethrow: (error: unknown) => never, authorize?: () => Promise<unknown>): Promise<T> {
    // Release, reopen and conversion change workspace state; the next statistics request must rescan.
    this.invalidateMeasurements();
    return this.exclusive(() =>
      this.issueQueue.run(issueId, async () => {
        // Keep HTTP policy at the caller, but recheck it after both lifecycle and inspection waits.
        await authorize?.();
        try {
          return await this.engine.runExclusive([issueId], operation);
        } catch (error) {
          return rethrow(error);
        } finally {
          this.invalidateMeasurements();
        }
      }),
    );
  }

  private invalidateMeasurements(): void {
    this.workspaceBytesCache = undefined;
    this.statisticsCache = undefined;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.queue.run(operation);
  }
}
