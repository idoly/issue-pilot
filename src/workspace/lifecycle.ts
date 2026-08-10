import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { asc, eq } from "drizzle-orm";

import type { AgentController } from "../agent/engine.ts";
import type { openDatabase } from "../db/client.ts";
import { issueRepositories, issues, issueWorkspaces } from "../db/schema.ts";
import { WorktreeManager } from "./git.ts";
import { assertManagedIssueWorkspaceLayout, issueWorkspaceRoot, removeIssueWorkspaceLink } from "./state.ts";

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

export interface WorkspaceRetentionPolicy {
  retentionMs: number;
  highWaterBytes: number;
  targetBytes: number;
  maintenanceIntervalMs: number;
}

export interface WorkspaceInspection {
  issueId: string;
  issueKey: string;
  issueStatus: string;
  workspaceStatus: string;
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

type Database = ReturnType<typeof openDatabase>["db"];
type Issue = typeof issues.$inferSelect;
type IssueWorkspace = typeof issueWorkspaces.$inferSelect;

function numericEnvironment(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
  return parsed;
}

export function workspacePolicyFromEnvironment(environment: NodeJS.ProcessEnv = process.env): WorkspaceRetentionPolicy {
  const retentionValue = environment.ISSUE_PILOT_WORKSPACE_RETENTION_HOURS;
  const retentionMs = retentionValue?.toLowerCase() === "off"
    ? Number.POSITIVE_INFINITY
    : numericEnvironment(retentionValue, 7 * 24, "workspace_retention_hours") * 60 * 60 * 1000;
  const highWaterBytes = numericEnvironment(environment.ISSUE_PILOT_WORKSPACE_HIGH_WATER_BYTES, 20 * GIB, "workspace_high_water_bytes");
  const targetBytes = numericEnvironment(environment.ISSUE_PILOT_WORKSPACE_TARGET_BYTES, highWaterBytes === 0 ? 0 : Math.floor(highWaterBytes * 0.8), "workspace_target_bytes");
  const maintenanceIntervalMs = numericEnvironment(environment.ISSUE_PILOT_WORKSPACE_MAINTENANCE_MINUTES, 15, "workspace_maintenance_minutes") * 60 * 1000;
  if (highWaterBytes > 0 && targetBytes >= highWaterBytes) throw new Error("workspace_target_must_be_below_high_water");
  return { retentionMs, highWaterBytes, targetBytes, maintenanceIntervalMs };
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function directoryBytes(candidate: string): Promise<number> {
  if (!await exists(candidate)) return 0;
  const { stdout } = await execFileAsync("du", ["-sk", "--", candidate], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  const kibibytes = Number(stdout.trim().split(/\s+/, 1)[0]);
  if (!Number.isSafeInteger(kibibytes) || kibibytes < 0) throw new Error("invalid_workspace_disk_usage");
  return kibibytes * 1024;
}

export class WorkspaceLifecycleManager {
  private readonly database: Database;
  private readonly stateRoot: string;
  private readonly engine: AgentController;
  private readonly worktrees: WorktreeManager;
  readonly policy: WorkspaceRetentionPolicy;
  private tail = Promise.resolve();

  constructor(database: Database, stateRoot: string, engine: AgentController, policy: WorkspaceRetentionPolicy = workspacePolicyFromEnvironment()) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.engine = engine;
    this.policy = policy;
    this.worktrees = new WorktreeManager(this.stateRoot);
  }

  start(onError: (error: unknown) => void = () => undefined): () => void {
    if (this.policy.maintenanceIntervalMs === 0) return () => undefined;
    const timer = setInterval(() => { void this.maintain().catch(onError); }, this.policy.maintenanceIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async inspectIssue(issueId: string): Promise<WorkspaceInspection> {
    return this.exclusive(async () => {
      const row = await this.issueRow(issueId);
      return this.inspectLocked(row.issue, row.workspace);
    });
  }

  async stats(): Promise<{ totalBytes: number; policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number }; workspaces: WorkspaceInspection[] }> {
    return this.exclusive(async () => {
      const rows = await this.issueRows();
      const workspaces: WorkspaceInspection[] = [];
      for (const row of rows) workspaces.push(await this.inspectLocked(row.issue, row.workspace));
      return {
        totalBytes: workspaces.reduce((total, workspace) => total + workspace.bytes, 0),
        policy: {
          retentionHours: Number.isFinite(this.policy.retentionMs) ? this.policy.retentionMs / 3_600_000 : null,
          highWaterBytes: this.policy.highWaterBytes,
          targetBytes: this.policy.targetBytes,
          maintenanceIntervalMinutes: this.policy.maintenanceIntervalMs / 60_000,
        },
        workspaces,
      };
    });
  }

  async releaseIssue(issueId: string): Promise<WorkspaceReleaseResult> {
    return this.exclusive(async () => {
      const row = await this.issueRow(issueId);
      return this.releaseLocked(row.issue, row.workspace);
    });
  }

  async maintain(): Promise<{ totalBytes: number; released: WorkspaceReleaseResult[]; blocked: Array<{ issueKey: string; reason: string }> }> {
    return this.exclusive(async () => {
      const rows = await this.issueRows();
      const sizes = new Map<string, number>();
      let totalBytes = 0;
      for (const { issue } of rows) {
        const bytes = await directoryBytes(issueWorkspaceRoot(this.stateRoot, issue.key));
        sizes.set(issue.id, bytes);
        totalBytes += bytes;
      }

      const released: WorkspaceReleaseResult[] = [];
      const blocked: Array<{ issueKey: string; reason: string }> = [];
      const attempted = new Set<string>();
      const candidates = rows.filter(({ issue }) => issue.status === "resolved" && (sizes.get(issue.id) ?? 0) > 0);
      const releaseCandidate = async (row: { issue: Issue; workspace: IssueWorkspace | null }) => {
        attempted.add(row.issue.id);
        try {
          const result = await this.releaseLocked(row.issue, row.workspace);
          if (!result.alreadyReleased) {
            released.push(result);
            totalBytes = Math.max(0, totalBytes - (sizes.get(row.issue.id) ?? result.releasedBytes));
          }
        } catch (error) {
          if (error instanceof WorkspaceReleaseRefusal) blocked.push({ issueKey: row.issue.key, reason: error.reason });
          else throw error;
        }
      };

      if (Number.isFinite(this.policy.retentionMs)) {
        const cutoff = Date.now() - this.policy.retentionMs;
        const retentionCandidates = [...candidates].sort((left, right) => (left.issue.resolvedAt?.getTime() ?? left.issue.updatedAt.getTime()) - (right.issue.resolvedAt?.getTime() ?? right.issue.updatedAt.getTime()));
        for (const row of retentionCandidates) {
          if (row.issue.resolvedAt && row.issue.resolvedAt.getTime() <= cutoff) await releaseCandidate(row);
        }
      }
      if (this.policy.highWaterBytes > 0 && totalBytes > this.policy.highWaterBytes) {
        const quotaCandidates = [...candidates].sort((left, right) => (left.workspace?.updatedAt.getTime() ?? left.issue.updatedAt.getTime()) - (right.workspace?.updatedAt.getTime() ?? right.issue.updatedAt.getTime()));
        for (const row of quotaCandidates) {
          if (totalBytes <= this.policy.targetBytes) break;
          if (!attempted.has(row.issue.id)) await releaseCandidate(row);
        }
      }
      return { totalBytes, released, blocked };
    });
  }

  private async releaseLocked(issue: Issue, workspace: IssueWorkspace | null): Promise<WorkspaceReleaseResult> {
    const inspection = await this.inspectLocked(issue, workspace);
    if (inspection.blockedReason === "workspace_missing") {
      const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      if (workspace?.codeServerReady && repositories.every((repository) => repository.localPath === null)) {
        return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
      }
      await removeIssueWorkspaceLink(this.stateRoot, issue.key);
      await this.markReleased(issue.id);
      return { issueKey: issue.key, releasedBytes: 0, alreadyReleased: true };
    }
    if (!inspection.releasable) throw new WorkspaceReleaseRefusal(inspection.blockedReason ?? "workspace_not_releasable");

    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    await this.engine.closeSession(issue.id);
    for (const repository of repositories) {
      if (!repository.localPath) continue;
      try {
        await this.worktrees.remove(repository.url, repository.localPath);
      } catch (error) {
        if (error instanceof Error && error.message === "obsolete_workspace_has_changes") throw new WorkspaceReleaseRefusal("workspace_has_changes");
        throw error;
      }
    }
    await rm(issueWorkspaceRoot(this.stateRoot, issue.key), { recursive: true, force: true });
    await removeIssueWorkspaceLink(this.stateRoot, issue.key);
    await this.markReleased(issue.id);
    return { issueKey: issue.key, releasedBytes: inspection.bytes, alreadyReleased: false };
  }

  private async markReleased(issueId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.update(issueRepositories).set({ localPath: null, updatedAt: new Date() }).where(eq(issueRepositories.issueId, issueId));
      await transaction.update(issueWorkspaces).set({ status: "stopped", codeServerReady: false, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
    });
  }

  private async inspectLocked(issue: Issue, workspace: IssueWorkspace | null): Promise<WorkspaceInspection> {
    const root = issueWorkspaceRoot(this.stateRoot, issue.key);
    const bytes = await directoryBytes(root);
    let blockedReason: string | null = null;
    if (!await exists(root)) blockedReason = "workspace_missing";
    else if (this.engine.isRunning(issue.id)) blockedReason = "issue_already_running";
    else if (workspace && ["preparing", "running"].includes(workspace.status)) blockedReason = "workspace_busy";
    else {
      const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
      try {
        await assertManagedIssueWorkspaceLayout(root, repositories.flatMap((repository) => repository.localPath ? [repository.localPath] : []));
        for (const repository of repositories) {
          if (repository.localPath) await this.worktrees.assertClean(repository.localPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blockedReason = message === "obsolete_workspace_has_changes" ? "workspace_has_changes" : message;
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

  private async issueRow(issueId: string): Promise<{ issue: Issue; workspace: IssueWorkspace | null }> {
    const [row] = await this.database.select({ issue: issues, workspace: issueWorkspaces }).from(issues)
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id)).where(eq(issues.id, issueId)).limit(1);
    if (!row) throw new Error("issue_not_found");
    return row;
  }

  private issueRows(): Promise<Array<{ issue: Issue; workspace: IssueWorkspace | null }>> {
    return this.database.select({ issue: issues, workspace: issueWorkspaces }).from(issues)
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id)).orderBy(asc(issues.updatedAt));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
