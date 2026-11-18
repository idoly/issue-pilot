import { OperationError } from "../operation-error.ts";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq, inArray } from "drizzle-orm";
import pMap from "p-map";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters } from "../configuration/parameters.ts";
import type { ApplicationParameters } from "../configuration/contracts.ts";
import { AgentBusyError, type AgentController, type AgentReservation } from "../agent/contracts.ts";
import { errorChain, isStableErrorCode, stableErrorReason } from "../diagnostics.ts";
import type { Database } from "../db/client.ts";
import { agentSessions, environments, issueRelations, issueRepositories, issues, issueWorkspaces } from "../db/schema.ts";
import { isIssueActive, isWorkspaceBusy, scopeTransitionRefusal, type IssueScopeState, type IssueStatus, type WorkspaceStatus } from "../domain/contracts.ts";
import { DomainError, OPERATIONAL_FAILURE_CODES } from "../domain/errors.ts";
import { SerialQueue } from "../serial.ts";
import { executeLocalCommand } from "../process.ts";
import { transitionIssue } from "../issues/status.ts";
import { issueRepositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure } from "./git.ts";
import { developmentWorktreeMode, IssueProjectManager, replaceIssueRepositoryRows, type ExpectedRepository } from "./project.ts";
import { inspectReleasedRepositories } from "./runtime.ts";
import { assertIssueRoot, assertManagedIssueWorkspaceLayout, classifyRepositoryState, gitRoot, issueRoot, pathExists } from "./state.ts";

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

/** Operator-correctable lifecycle refusal: a stable conflict code that HTTP maps once, keeping the owner failure as cause. */
class WorkspaceRefusal extends DomainError {
  constructor(reason: string, options?: ErrorOptions) {
    super(reason, "conflict", options);
  }
}

export class IssueDeletionRefusal extends WorkspaceRefusal {}
export class WorkspaceReleaseRefusal extends WorkspaceRefusal {}
export class WorkspaceRestoreRefusal extends WorkspaceRefusal {}
export class WorkspaceConversionRefusal extends WorkspaceRefusal {}
export class WorkspaceScopeMigrationRefusal extends WorkspaceRefusal {}

/**
 * Republish an owner failure as this operation's refusal only when it is a stable, operator-correctable code.
 * Typed domain failures, uncertain outcomes, operational state damage and unstable messages keep the original
 * error so HTTP reports their real category, outcome and diagnostics.
 */
function refuseWith(Refusal: new (reason: string, options?: ErrorOptions) => WorkspaceRefusal, error: unknown, reason?: string): never {
  if (error instanceof DomainError || !(error instanceof Error) || !isStableErrorCode(error.message)) throw error;
  if (errorChain(error).some((cause) => cause instanceof OperationError) || OPERATIONAL_FAILURE_CODES.has(error.message)) throw error;
  throw new Refusal(reason ?? error.message, { cause: error });
}

type Issue = typeof issues.$inferSelect;
type IssueWorkspace = typeof issueWorkspaces.$inferSelect;
type TransitionAudit = (writer: Pick<Database, "insert">, now: Date) => Promise<void>;
type IssueRepository = typeof issueRepositories.$inferSelect;
/** Every Issue owns exactly one Workspace; row readers refuse a missing one instead of passing null downstream. */
type IssueRow = { issue: Issue; workspace: IssueWorkspace; environmentKind: typeof environments.$inferSelect.kind };

function issueScopeState({ issue, workspace, environmentKind }: IssueRow): IssueScopeState {
  return { environmentKind, issueType: issue.type, status: issue.status, workspaceStatus: workspace.status };
}

/** Complete apparent disk usage of a path in bytes; a missing path measures zero. */
export async function directoryBytes(candidate: string): Promise<number> {
  if (!(await pathExists(candidate))) return 0;
  const { diskUsageMs, diskUsageOutputBytes } = issuePilotConfig.limits.process;
  // A nonzero exit can include a lower bound. It cannot serve as a complete measurement.
  const measured = await executeLocalCommand("du", ["-sk", "--", candidate], { timeout: diskUsageMs, maxOutputBytes: diskUsageOutputBytes });
  if (measured.code !== 0) throw new Error("workspace_disk_usage_failed", { cause: new Error(measured.stderr) });
  const stdout = measured.stdout;
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
  private currentPolicy: WorkspaceLifecyclePolicy;
  private readonly queue = new SerialQueue();
  // Serialize whole background jobs while they yield the lifecycle queue between batches.
  private readonly backgroundQueue = new SerialQueue();
  private statsRequest: Promise<WorkspaceStatistics> | undefined;
  private lastStatistics: WorkspaceStatistics | null = null;
  private statisticsError: string | null = null;
  private sampling = 0;
  private statisticsRevision = 0;
  private maintenanceTimer:
    | {
        handle: ReturnType<typeof setTimeout> | undefined;
        active: Promise<void> | undefined;
        report: (error: unknown) => void;
        completed: (durationMs: number) => void;
      }
    | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private readonly measure: (candidate: string) => Promise<number>;

  constructor(
    database: Database,
    stateRoot: string,
    engine: AgentController,
    policy: WorkspaceLifecyclePolicy = workspaceLifecyclePolicy(),
    options: { measure?: (candidate: string) => Promise<number> } = {},
  ) {
    assertWorkspaceLifecyclePolicy(policy);
    this.measure = options.measure ?? directoryBytes;
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.engine = engine;
    this.currentPolicy = policy;
    this.worktrees = new WorktreeManager(this.stateRoot);
    this.projects = new IssueProjectManager(this.database, this.stateRoot, this.worktrees);
  }

  start(onError: (error: unknown) => void = () => undefined, onComplete: (durationMs: number) => void = () => undefined): void {
    if (this.stopping || this.maintenanceTimer) return;
    const report = (error: unknown) => {
      try {
        onError(error);
      } catch {
        /* Reporting must not interrupt maintenance. */
      }
    };
    this.maintenanceTimer = { handle: undefined, active: undefined, report, completed: onComplete };
    this.scheduleMaintenance();
  }

  stop(): Promise<void> {
    const timer = this.maintenanceTimer;
    clearTimeout(timer?.handle);
    this.maintenanceTimer = undefined;
    this.stopping = true;
    return (this.stopPromise ??= Promise.all([timer?.active, this.backgroundQueue.idle()]).then(() => this.queue.idle()));
  }

  get policy(): WorkspaceLifecyclePolicy {
    return this.currentPolicy;
  }

  /** A changed policy applies from the next maintenance cycle and statistics sample; a running cycle keeps its values. */
  updatePolicy(policy: WorkspaceLifecyclePolicy): void {
    assertWorkspaceLifecyclePolicy(policy);
    const rescheduled = policy.maintenanceIntervalMs !== this.currentPolicy.maintenanceIntervalMs;
    this.currentPolicy = policy;
    this.statsRequest = undefined;
    this.statisticsRevision++;
    if (rescheduled) this.scheduleMaintenance();
  }

  private scheduleMaintenance(): void {
    const timer = this.maintenanceTimer;
    if (!timer || timer.active) return;
    clearTimeout(timer.handle);
    timer.handle = undefined;
    const interval = this.currentPolicy.maintenanceIntervalMs;
    if (interval <= 0) return;
    timer.handle = setTimeout(() => {
      timer.handle = undefined;
      const startedAt = performance.now();
      timer.active = this.maintain()
        .then(async (result) => {
          for (const failure of result.failures) timer.report(new Error(`workspace_maintenance_failed:${failure.issueKey}`, { cause: failure.error }));
          const { sharedCheckoutHighWaterBytes, sharedCheckoutTargetBytes } = issuePilotConfig.workspace;
          await this.worktrees.reclaimSharedCheckouts(sharedCheckoutHighWaterBytes, sharedCheckoutTargetBytes, timer.report, () => this.stopping);
          timer.completed(Math.round(performance.now() - startedAt));
        })
        .catch(timer.report)
        .finally(() => {
          timer.active = undefined;
          this.scheduleMaintenance();
        });
    }, interval);
    timer.handle.unref();
  }

  async inspectIssue(issueId: string): Promise<WorkspaceInspection> {
    return this.exclusive(async () => {
      const issueRow = await this.issueRow(issueId);
      return this.inspectLocked(issueRow);
    });
  }

  /** HTTP reads never wait behind filesystem/Git work. Cold start and explicit retry share one sample. */
  readStats(refresh = false): { snapshot: WorkspaceStatistics | null; sampling: boolean; error: string | null } {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    if (!this.sampling && (refresh || (!this.lastStatistics && !this.statisticsError))) {
      // Sampling records the failure for readers; the background caller must also consume its rejection.
      void this.sampleStats().catch(() => undefined);
    }
    return { snapshot: this.lastStatistics, sampling: this.sampling > 0, error: this.statisticsError };
  }

  async sampleStats(): Promise<WorkspaceStatistics> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    if (this.statsRequest) return this.statsRequest;
    this.sampling++;
    this.statisticsError = null;
    const revision = this.statisticsRevision;
    const promise = this.background(async () => {
      const value = await this.sampleStatistics();
      this.publishStatistics(value, revision);
      return value;
    });
    this.statsRequest = promise;
    try {
      return await promise;
    } catch (error) {
      if (revision === this.statisticsRevision) this.statisticsError = stableErrorReason(error, "workspace_statistics_failed");
      throw error;
    } finally {
      this.sampling--;
      if (this.statsRequest === promise) this.statsRequest = undefined;
    }
  }

  private async sampleStatistics(measuredBytes?: Map<string, number>): Promise<WorkspaceStatistics> {
    const { policy, issueRows, repositories } = await this.queue.run(async () => ({
      policy: this.policy,
      issueRows: await this.issueRows(),
      repositories: await this.database.select().from(issueRepositories),
    }));
    const repositoriesByIssue = new Map<string, IssueRepository[]>();
    for (const repository of repositories) {
      const group = repositoriesByIssue.get(repository.issueId) ?? [];
      group.push(repository);
      repositoriesByIssue.set(repository.issueId, group);
    }
    const inspections = await this.inBatches(issueRows, policy.taskConcurrency, (issueRow) =>
      this.inspectLocked(issueRow, repositoriesByIssue.get(issueRow.issue.id) ?? [], measuredBytes?.get(issueRow.issue.id), false),
    );
    const sharedGitBytes = await this.queue.run(() => this.measure(gitRoot(this.stateRoot)));
    return {
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
  }

  private publishStatistics(value: WorkspaceStatistics, revision: number): void {
    // Policy changes and queued lifecycle writes supersede in-flight samples, but retain the last successful display.
    if (revision !== this.statisticsRevision) return;
    this.lastStatistics = value;
    this.statisticsError = null;
  }

  async releaseIssue(issueId: string, authorize?: () => Promise<unknown>): Promise<WorkspaceReleaseResult> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => {
        const { issueKey, releasedBytes, alreadyReleased } = await this.releaseLocked(await this.issueRow(issueId), reservation);
        return { issueKey, releasedBytes, alreadyReleased };
      },
      (error) => {
        if (error instanceof AgentBusyError) throw new WorkspaceReleaseRefusal(error.message);
        throw error;
      },
      authorize,
    );
  }

  async reopenIssue(issueId: string, authorize?: () => Promise<unknown>): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.reopenLocked(await this.issueRow(issueId), reservation),
      (error) => refuseWith(WorkspaceRestoreRefusal, error),
      authorize,
    );
  }

  async convertIssueToDevelopment(
    issueId: string,
    expectedIssueUpdatedAt?: string,
    recordTransition?: TransitionAudit,
    authorize?: () => Promise<unknown>,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.convertLocked(await this.issueRow(issueId), reservation, expectedIssueUpdatedAt, recordTransition, expectedRepositories),
      (error) => refuseWith(WorkspaceConversionRefusal, error),
      authorize,
    );
  }

  async migrateDevelopmentIssueScope(
    issueId: string,
    target: { serviceId: string; environmentId: string },
    expectedIssueUpdatedAt: string,
    recordTransition?: TransitionAudit,
    authorize?: () => Promise<unknown>,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<Issue> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => this.migrateDevelopmentScopeLocked(await this.issueRow(issueId), target, expectedIssueUpdatedAt, reservation, recordTransition, expectedRepositories),
      (error) => refuseWith(WorkspaceScopeMigrationRefusal, error, error instanceof Error && error.message === "workspace_has_changes" ? "scope_transition_removed_repository_changed" : undefined),
      authorize,
    );
  }

  async maintain(): Promise<{ totalBytes: number; released: WorkspaceReleaseResult[]; blocked: Array<{ issueKey: string; reason: string }>; failures: Array<{ issueKey: string; error: unknown }> }> {
    this.statsRequest = undefined;
    this.statisticsRevision++;
    const revision = this.statisticsRevision;
    this.sampling++;
    this.statisticsError = null;
    return this.background(async () => {
      const { policy, issueRows } = await this.queue.run(async () => ({ policy: this.policy, issueRows: await this.issueRows() }));
      const failures: Array<{ issueKey: string; error: unknown }> = [];
      // Measure per Issue: one unmeasurable tree must not abort maintenance.
      const measuredWorkspaces = await this.inBatches(issueRows, policy.taskConcurrency, async ({ issue }) => {
        try {
          return { issueId: issue.id, bytes: await this.measure(issueRoot(this.stateRoot, issue.key)) };
        } catch (error) {
          failures.push({ issueKey: issue.key, error });
          return undefined;
        }
      });
      const measured = measuredWorkspaces.filter((workspace): workspace is { issueId: string; bytes: number } => workspace !== undefined);
      let measurementIncomplete = measured.length !== issueRows.length;
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
        ({ issue, environmentKind, workspace }) => environmentKind === "dev" && issue.status === "resolved" && (workspaceBytes.get(issue.id) ?? 0) > 0 && !workspace.releasedAt,
      );
      const releaseCandidate = async (candidate: IssueRow) => {
        const { id, key } = candidate.issue;
        try {
          const measured = await this.queue.run(async () => {
            // A foreground mutation or policy update supersedes the measured quota and retention candidates.
            if (revision !== this.statisticsRevision) return;
            return this.engine.runExclusive([id], async (reservation) => {
              const current = await this.issueRow(id);
              attemptedIssues.add(id);
              if (current.workspace.releasedAt) return;
              try {
                return await this.releaseLocked(current, reservation);
              } catch (error) {
                // A release can fail after writing to disk. Refresh its size before returning the reservation.
                try {
                  updateBytes(id, await this.measure(issueRoot(this.stateRoot, key)));
                } catch (measurementError) {
                  measurementIncomplete = true;
                  throw new AggregateError([error, measurementError], "workspace_maintenance_measurement_failed");
                }
                throw error;
              }
            });
          });
          if (!measured) return;
          updateBytes(id, measured.remainingBytes);
          if (!measured.alreadyReleased) {
            const { issueKey, releasedBytes, alreadyReleased } = measured;
            released.push({ issueKey, releasedBytes, alreadyReleased });
          }
        } catch (error) {
          attemptedIssues.add(id);
          if (error instanceof WorkspaceReleaseRefusal || error instanceof AgentBusyError) blocked.push({ issueKey: key, reason: error.message });
          else failures.push({ issueKey: key, error });
        }
      };

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
        const quotaCandidates = [...candidates].sort((left, right) => left.workspace.updatedAt.getTime() - right.workspace.updatedAt.getTime());
        for (const candidate of quotaCandidates) {
          if (totalBytes <= policy.targetBytes) break;
          if (!attemptedIssues.has(candidate.issue.id)) await releaseCandidate(candidate);
        }
      }
      // Failed measurements must not replace a previously complete snapshot with a partial total.
      if (measurementIncomplete) {
        if (revision === this.statisticsRevision) this.statisticsError = "workspace_measurement_incomplete";
      } else {
        try {
          this.publishStatistics(await this.sampleStatistics(workspaceBytes), revision);
        } catch (error) {
          if (revision === this.statisticsRevision) this.statisticsError = stableErrorReason(error, "workspace_statistics_failed");
          this.maintenanceTimer?.report(new Error("workspace_statistics_failed", { cause: error }));
        }
      }
      return { totalBytes, released, blocked, failures };
    })
      .catch((error) => {
        if (revision === this.statisticsRevision) this.statisticsError = stableErrorReason(error, "workspace_statistics_failed");
        throw error;
      })
      .finally(() => {
        this.sampling--;
      });
  }

  private async migrateDevelopmentScopeLocked(
    issueRow: IssueRow,
    target: { serviceId: string; environmentId: string },
    expectedIssueUpdatedAt: string,
    reservation: AgentReservation,
    recordTransition?: TransitionAudit,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<Issue> {
    const { issue } = issueRow;
    if (issue.updatedAt.toISOString() !== expectedIssueUpdatedAt) throw new WorkspaceScopeMigrationRefusal("scope_transition_plan_stale");
    const [targetEnvironment] = await this.database.select().from(environments).where(eq(environments.id, target.environmentId)).limit(1);
    const refusal = scopeTransitionRefusal("migrate_development", issueScopeState(issueRow), targetEnvironment?.kind);
    if (refusal) throw new WorkspaceScopeMigrationRefusal(refusal);

    const relatedIssueIds = await this.relatedIssueIds(issue.id);
    await reservation.closeSession(issue.id);
    const migrated = await this.projects.migrateDevelopmentScope(
      issue,
      target,
      async ({ prepared, repositories, existingRepositories, names }) => {
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
          const [updatedWorkspace] = await transaction
            .update(issueWorkspaces)
            .set({ status: "ready", runtimeReady: true, releasedAt: null, lastError: null, updatedAt: now })
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
      },
      false,
      expectedRepositories,
    );
    reservation.enqueue(issue.id);
    this.engine.markScopeChanged?.(relatedIssueIds);
    return migrated;
  }

  private async convertLocked(
    issueRow: IssueRow,
    reservation: AgentReservation,
    expectedIssueUpdatedAt?: string,
    recordTransition?: TransitionAudit,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<Issue> {
    const { issue } = issueRow;
    if (expectedIssueUpdatedAt && issue.updatedAt.toISOString() !== expectedIssueUpdatedAt) throw new WorkspaceConversionRefusal("scope_transition_plan_stale");
    const refusal = scopeTransitionRefusal("convert_to_development", issueScopeState(issueRow), "dev");
    if (refusal) throw new WorkspaceConversionRefusal(refusal);
    const [developmentEnvironment] = await this.database.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    if (!developmentEnvironment) throw new WorkspaceConversionRefusal("development_environment_not_found");
    const relatedIssueIds = await this.relatedIssueIds(issue.id);
    await reservation.closeSession(issue.id);
    try {
      const converted = await this.projects.convertReadOnlyToDevelopment(
        issue,
        developmentEnvironment.id,
        async ({ prepared, repositories, existingRepositories, names }) => {
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
            const [updatedWorkspace] = await transaction
              .update(issueWorkspaces)
              .set({ status: "ready", runtimeReady: true, releasedAt: null, lastError: null, updatedAt: now })
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
        },
        false,
        expectedRepositories,
      );
      reservation.enqueue(issue.id);
      this.engine.markScopeChanged?.(relatedIssueIds);
      return converted;
    } catch (error) {
      refuseWith(WorkspaceConversionRefusal, error);
    }
  }

  private async reopenLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<Issue> {
    const { issue, workspace } = issueRow;
    if (issue.status !== "resolved") throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    if (isIssueActive({ agentRunning: this.engine.isRunning(issue.id), workspaceStatus: workspace.status })) throw new WorkspaceRestoreRefusal("issue_already_running");
    if (issueRow.environmentKind !== "dev") {
      await reservation.closeSession(issue.id);
      return this.markReopened(issue);
    }

    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    const relatedIssueIds = await this.relatedIssueIds(issue.id);
    if (repositoryState === "development_workspace") {
      // The root owner rejects redirected roots; only a missing root is the operator-facing refusal.
      await assertIssueRoot(this.stateRoot, issue.key).catch((error: unknown) => {
        if (error instanceof Error && error.message === "issue_root_missing") throw new WorkspaceRestoreRefusal("workspace_missing", { cause: error });
        throw error;
      });
      try {
        issueRepositoryWorkspaceNames(repositories);
      } catch (error) {
        refuseWith(WorkspaceRestoreRefusal, error);
      }
      await assertManagedIssueWorkspaceLayout(
        workspaceRoot,
        repositories.map((repository) => repository.localPath!),
      );
      await reservation.closeSession(issue.id);
      const reopened = await this.markReopened(issue);
      this.engine.markScopeChanged?.(relatedIssueIds);
      return reopened;
    }
    if (repositoryState !== "development_snapshot") throw new WorkspaceRestoreRefusal("development_repository_state_invalid");
    if (!workspace.releasedAt) throw new WorkspaceRestoreRefusal("development_repository_state_invalid");
    let names: Map<string, string>;
    let commits: Map<string, string>;
    try {
      developmentWorktreeMode(issue.type);
      names = issueRepositoryWorkspaceNames(repositories);
      commits = await inspectReleasedRepositories(this.stateRoot, issue.key, repositories, names);
    } catch (error) {
      refuseWith(WorkspaceRestoreRefusal, error);
    }

    await reservation.closeSession(issue.id);
    try {
      const reopened = await this.projects.restoreDevelopmentWorkspace(issue, repositories, names, commits, (prepared) =>
        this.database.transaction(async (transaction) => {
          const now = new Date();
          for (const [index, repository] of repositories.entries()) {
            await transaction
              .update(issueRepositories)
              .set({ localPath: prepared[index]!.workspacePath, workspaceName: names.get(repository.url)!, updatedAt: now })
              .where(eq(issueRepositories.id, repository.id));
          }
          await transaction.update(issueWorkspaces).set({ status: "ready", runtimeReady: true, releasedAt: null, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
          const reopened = await transitionIssue(transaction, issue.id, { from: ["resolved"], to: "open", resolvedAt: null, updatedAt: now });
          if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
          return reopened;
        }),
      );
      this.engine.markScopeChanged?.(relatedIssueIds);
      return reopened;
    } catch (error) {
      refuseWith(WorkspaceRestoreRefusal, error);
    }
  }

  private async markReopened(issue: Issue): Promise<Issue> {
    const reopened = await transitionIssue(this.database, issue.id, { from: ["resolved"], to: "open", resolvedAt: null });
    if (!reopened) throw new WorkspaceRestoreRefusal("invalid_issue_status_transition");
    return reopened;
  }

  /** Destructive API operation, distinct from workspace release. Unknown/dirty Git state is never forced. */
  async deleteIssue(issueId: string, authorize: () => Promise<unknown>): Promise<void> {
    return this.withIssueReservation(
      issueId,
      async (reservation) => {
        const { issue } = await this.issueRow(issueId);
        const [reference] = await this.database.select({ id: issueRelations.issueId }).from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId)).limit(1);
        if (reference) throw new IssueDeletionRefusal("issue_is_related_context");
        const root = issueRoot(this.stateRoot, issue.key);
        const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issueId));
        const state = classifyRepositoryState(repositories);
        if (repositories.length && state === "invalid") throw new IssueDeletionRefusal("development_repository_state_invalid");
        const active = repositories.filter((repository) => repository.localPath !== null);
        if (active.length) issueRepositoryWorkspaceNames(repositories);
        // Session shutdown hooks can still write files. Validate the final filesystem state after they stop.
        await reservation.closeSession(issueId);
        if (!(await pathExists(root))) throw new IssueDeletionRefusal("workspace_missing");
        if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root) throw new IssueDeletionRefusal("workspace_path_outside_issue_root");
        await assertManagedIssueWorkspaceLayout(
          root,
          active.map((repository) => repository.localPath!),
        );
        for (const repository of active) {
          await this.worktrees.assertClean(repository.url, repository.localPath!, repository.workingBranch!);
        }
        const stagingRoot = path.join(this.stateRoot, "control", "deletions");
        await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
        if ((await realpath(stagingRoot)) !== stagingRoot) throw new IssueDeletionRefusal("workspace_path_outside_issue_root");
        const staged = path.join(stagingRoot, `${issue.key.toLowerCase()}-${randomUUID()}`);
        // Private Git and its worktrees share this root. Stage them intact: database failure
        // restores the original files, permissions and index without reconstructing a checkout.
        // No Git operation runs at the temporary location or publishes the private branch.
        await rename(root, staged);
        try {
          await this.database.transaction(async (transaction) => {
            await transaction.delete(issues).where(eq(issues.id, issueId));
          });
        } catch (error) {
          try {
            await rename(staged, root);
          } catch (rollbackError) {
            throw new OperationError("issue_delete_rollback_failed", "unknown", { cause: new AggregateError([error, rollbackError]) });
          }
          throw error;
        }
        // After DB commit, do not restore a partly removed root or pretend the delete fully succeeded.
        // Failed cleanup remains explicitly staged for operator inspection; never scan/adopt it on startup.
        try {
          await rm(staged, { recursive: true });
        } catch (error) {
          throw new OperationError("issue_delete_cleanup_failed", "committed", { cause: error });
        }
      },
      (error) => {
        if (error instanceof IssueDeletionRefusal) throw error;
        if (error instanceof AgentBusyError) throw new IssueDeletionRefusal(error.message);
        if (error instanceof Error && ["workspace_has_changes", "workspace_repository_missing"].includes(error.message)) throw new IssueDeletionRefusal(error.message, { cause: error });
        throw error;
      },
      authorize,
    );
  }

  private async releaseLocked(issueRow: IssueRow, reservation: AgentReservation): Promise<MeasuredWorkspaceRelease> {
    const { issue, workspace } = issueRow;
    if (issueRow.environmentKind !== "dev") throw new WorkspaceReleaseRefusal("workspace_not_development");
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    const repositoryState = classifyRepositoryState(repositories);
    // A released snapshot has no code bytes to subtract; only the resulting footprint is used.
    const inspection = await this.inspectLocked(issueRow, repositories, repositoryState === "development_snapshot" ? 0 : undefined);
    if (["issue_not_resolved", "issue_already_running", "workspace_busy", "workspace_missing"].includes(inspection.blockedReason ?? "")) throw new WorkspaceReleaseRefusal(inspection.blockedReason!);
    let names: Map<string, string>;
    try {
      names = issueRepositoryWorkspaceNames(repositories);
    } catch (error) {
      refuseWith(WorkspaceReleaseRefusal, error);
    }
    if (repositoryState === "development_snapshot") {
      // releasedAt is committed with the snapshot repository rows; it is the release marker, not a status inference.
      if (!workspace.releasedAt) throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
      if (inspection.blockedReason !== "workspace_released") throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "development_repository_state_invalid");
      await reservation.closeSession(issue.id);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true, remainingBytes: await this.measure(issueRoot(this.stateRoot, issue.key)) };
    }
    if (repositoryState !== "development_workspace") throw new WorkspaceReleaseRefusal("development_repository_state_invalid");
    // A missing root also lost the Issue's private Git store. Marking it released would let a later
    // restore rebuild from an older shared ref, so leave it for operator inspection like reopen does.
    if (!inspection.releasable) throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "workspace_not_releasable");
    const relatedIssueIds = await this.relatedIssueIds(issue.id);
    let mode: ReturnType<typeof developmentWorktreeMode>;
    try {
      mode = developmentWorktreeMode(issue.type);
    } catch (error) {
      refuseWith(WorkspaceReleaseRefusal, error);
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
      if (error instanceof WorktreeRollbackFailure) throw new WorkspaceReleaseRefusal("workspace_release_rollback_failed", { cause: error });
      if (error instanceof Error && ["workspace_has_changes", "workspace_repository_missing"].includes(error.message)) throw new WorkspaceReleaseRefusal(error.message, { cause: error });
      if (error && typeof error === "object" && "code" in error && error.code === "ENOTEMPTY") throw new WorkspaceReleaseRefusal("workspace_has_untracked_files", { cause: error });
      throw error;
    }
    // The released view no longer exposes these worktrees; referencing live sessions must re-prepare.
    this.engine.markScopeChanged?.(relatedIssueIds);
    const remainingBytes = await this.measure(issueRoot(this.stateRoot, issue.key));
    return { issueKey: issue.key, releasedBytes: Math.max(0, inspection.bytes - remainingBytes), alreadyReleased: false, remainingBytes };
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
      await transaction.update(issueWorkspaces).set({ status: "stopped", runtimeReady: false, releasedAt: now, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issueId));
    });
  }

  private async inspectLocked(issueRow: IssueRow, knownRepositories?: IssueRepository[], knownBytes?: number, inspectReleased = true): Promise<WorkspaceInspection> {
    const { issue, workspace, environmentKind } = issueRow;
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    const bytes = knownBytes ?? (await this.measure(workspaceRoot));
    let blockedReason: string | null = null;
    if (environmentKind !== "dev") blockedReason = "workspace_not_development";
    else if (issue.status !== "resolved") blockedReason = "issue_not_resolved";
    else if (this.engine.isRunning(issue.id)) blockedReason = "issue_already_running";
    else if (isWorkspaceBusy(workspace.status)) blockedReason = "workspace_busy";
    else if (!(await pathExists(workspaceRoot))) blockedReason = "workspace_missing";
    else {
      const repositories = knownRepositories ?? (await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)));
      const state = classifyRepositoryState(repositories);
      if (state === "development_snapshot") {
        if (!workspace.releasedAt) blockedReason = "development_repository_state_invalid";
        else
          try {
            // Capacity samples only need to know that these worktrees have already been removed.
            if (inspectReleased) await inspectReleasedRepositories(this.stateRoot, issue.key, repositories, issueRepositoryWorkspaceNames(repositories));
            blockedReason = "workspace_released";
          } catch (error) {
            blockedReason = stableErrorReason(error, "workspace_runtime_inspection_failed");
          }
      } else if (state !== "development_workspace") blockedReason = "development_repository_state_invalid";
      else if (workspace.releasedAt) blockedReason = "development_repository_state_invalid";
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
      workspaceStatus: workspace.status,
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      bytes,
      releasable: blockedReason === null,
      blockedReason,
    };
  }

  /** Live sessions of Issues that read this Issue's evidence must re-prepare after its code view changes. */
  private async relatedIssueIds(issueId: string): Promise<string[]> {
    const rows = await this.database.select({ issueId: issueRelations.issueId }).from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId));
    return rows.map(({ issueId: referencingIssueId }) => referencingIssueId);
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
    const { workspace } = issueRow;
    if (!workspace) throw new Error(`issue_workspace_missing:${issueRow.issue.key}`);
    return { ...issueRow, workspace };
  }

  private async issueRows(): Promise<IssueRow[]> {
    const rows = await this.database
      .select({ issue: issues, workspace: issueWorkspaces, environmentKind: environments.kind })
      .from(issues)
      .innerJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
      .orderBy(asc(issues.updatedAt));
    return rows.map(({ workspace, ...row }) => {
      if (!workspace) throw new Error(`issue_workspace_missing:${row.issue.key}`);
      return { ...row, workspace };
    });
  }

  private withIssueReservation<T>(issueId: string, operation: (reservation: AgentReservation) => Promise<T>, rethrow: (error: unknown) => never, authorize?: () => Promise<unknown>): Promise<T> {
    // Later readers must queue behind this write rather than join a pre-write sample.
    this.statsRequest = undefined;
    this.statisticsRevision++;
    return this.exclusive(async () => {
      // Keep HTTP policy at the caller, but recheck it after the lifecycle wait.
      await authorize?.();
      try {
        return await this.engine.runExclusive([issueId], operation);
      } catch (error) {
        return rethrow(error);
      }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.queue.run(operation);
  }

  private async background<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error("workspace_lifecycle_closing");
    return this.backgroundQueue.run(operation);
  }

  private async inBatches<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    for (let offset = 0; offset < items.length; offset += concurrency) {
      // Only one batch is queued ahead of foreground callers. Drain admitted jobs even after stop begins.
      const batch = items.slice(offset, offset + concurrency);
      results.push(...(await this.queue.run(() => pMap(batch, operation, { concurrency, stopOnError: false }))));
    }
    return results;
  }
}
