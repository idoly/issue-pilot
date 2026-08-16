import { and, eq, inArray, notInArray } from "drizzle-orm";
import { rmdir } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { Database } from "../db/client.ts";
import { agentSessions, issueRepositories, issueWorkspaces } from "../db/schema.ts";
import { SerialQueue } from "../serial.ts";
import type { EnvironmentKind, IssueType } from "../domain/contracts.ts";
import { loadDeploymentRepositories } from "./deployment.ts";
import { issueRepositoryWorkspaceNames, repositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure, type PreparedWorktree } from "./git.ts";
import { prepareProjectWrappers } from "./project-wrappers.ts";
import { prepareIssueRuntime, prepareIssueRuntimeBatch, type RuntimePreparationResult } from "./runtime.ts";
import { assertManagedIssueWorkspaceLayout, classifyRepositoryState, issueWorkspaceRoot, pathExists } from "./state.ts";

export interface PreparedIssueRepository {
  name: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string | null;
  baseCommit: string;
  access: "read" | "write";
}

export interface PreparedIssueProject {
  deployment: { id: string; config: Record<string, unknown> };
  runtimeRoot: string;
  workspaceRoot: string;
  executableRoot?: string;
  repositories: PreparedIssueRepository[];
  runtimeReady: boolean;
}
type ProjectIssue = { id: string; key: string; type: IssueType; serviceId: string; environmentId: string };
type IssueRepository = typeof issueRepositories.$inferSelect;
type DeploymentRepository = Awaited<ReturnType<typeof loadDeploymentRepositories>>["repositories"][number];
interface PreparedReadOnlyDeployment {
  names: Map<string, string>;
  repositories: Array<{ repository: DeploymentRepository["repository"]; checkout: PreparedWorktree }>;
}
type ReadOnlyDeploymentPreparationCache = Map<string, Promise<PreparedReadOnlyDeployment>>;

export interface PreparedDevelopmentConversion {
  prepared: PreparedWorktree[];
  repositories: DeploymentRepository[];
  existingRepositories: IssueRepository[];
  names: Map<string, string>;
  runtimeRoot: string;
}

type IssueRepositoryWriter = Pick<Database, "insert" | "delete">;
type IssueRepositoryReplacement = Pick<IssueRepository, "url" | "baseBranch" | "workingBranch" | "localPath" | "workspaceName" | "commitBefore">;

async function replaceIssueRepositoryRows(
  writer: IssueRepositoryWriter,
  issueId: string,
  existing: IssueRepository[],
  replacements: IssueRepositoryReplacement[],
  now: Date,
): Promise<void> {
  for (const { url, ...state } of replacements) {
    await writer.insert(issueRepositories).values({ issueId, url, ...state }).onConflictDoUpdate({
      target: [issueRepositories.issueId, issueRepositories.url],
      set: { ...state, updatedAt: now },
    });
  }
  const retainedUrls = new Set(replacements.map(({ url }) => url));
  if (!existing.some(({ url }) => !retainedUrls.has(url))) return;
  const issueFilter = eq(issueRepositories.issueId, issueId);
  await writer.delete(issueRepositories).where(retainedUrls.size ? and(issueFilter, notInArray(issueRepositories.url, [...retainedUrls])) : issueFilter);
}

export function developmentWorktreeMode(issueType: IssueType): "hotfix" | "feature" {
  if (issueType === "defect_fix") return "hotfix";
  if (issueType === "feature_development") return "feature";
  throw new Error("unsupported_dev_issue_type");
}

export function repositoryPreparationMode(environmentKind: EnvironmentKind, issueType: IssueType): "shared" | "hotfix" | "feature" {
  return environmentKind === "dev" ? developmentWorktreeMode(issueType) : "shared";
}

export class IssueProjectManager {
  private readonly stateRoot: string;
  private readonly database: Database;
  private readonly worktrees: WorktreeManager;

  constructor(database: Database, stateRoot: string, worktrees = new WorktreeManager(stateRoot)) {
    this.database = database;
    this.stateRoot = path.resolve(stateRoot);
    this.worktrees = worktrees;
  }

  async hydrateDevelopmentRuntime(issue: Pick<ProjectIssue, "id" | "key" | "type">): Promise<string> {
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    if (!repositories.length) throw new Error("issue_has_no_repositories");
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    const names = issueRepositoryWorkspaceNames(repositories);
    let runtimeRoot: string;
    if (await pathExists(workspaceRoot)) {
      if (classifyRepositoryState(repositories) !== "development_workspace") throw new Error("development_repository_state_invalid");
      await assertManagedIssueWorkspaceLayout(workspaceRoot, repositories.map((repository) => repository.localPath!));
      runtimeRoot = await prepareIssueRuntime(this.stateRoot, issue.key, repositories.map((repository) => ({ name: names.get(repository.url)!, repositoryPath: repository.localPath! })), "write");
      await prepareProjectWrappers(runtimeRoot);
    } else {
      if (classifyRepositoryState(repositories) !== "development_snapshot") throw new Error("development_repository_state_invalid");
      const snapshots = [];
      for (const repository of repositories) {
        const snapshot = await this.worktrees.prepareBranchSnapshot({ url: repository.url, baseBranch: repository.baseBranch, workingBranch: repository.workingBranch! });
        snapshots.push({ name: names.get(repository.url)!, repositoryPath: snapshot.workspacePath });
      }
      runtimeRoot = await prepareIssueRuntime(this.stateRoot, issue.key, snapshots, "read");
    }
    await this.database.update(issueWorkspaces).set({ runtimeReady: true, lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    return runtimeRoot;
  }

  async restoreDevelopmentWorkspace<T>(
    issue: Pick<ProjectIssue, "id" | "key" | "type">,
    repositories: Array<typeof issueRepositories.$inferSelect>,
    recoverRuntime: () => Promise<void>,
    finalize: (prepared: PreparedWorktree[], names: Map<string, string>) => Promise<T>,
  ): Promise<T> {
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    const mode = developmentWorktreeMode(issue.type);
    const names = issueRepositoryWorkspaceNames(repositories);
    try {
      return await this.worktrees.prepareBatch({
        worktrees: repositories.map((repository) => ({
          issueKey: issue.key,
          workspaceName: names.get(repository.url)!,
          url: repository.url,
          baseBranch: repository.baseBranch,
          mode,
          workingBranch: repository.workingBranch!,
          ...(repository.commitBefore ? { existingBaseCommit: repository.commitBefore } : {}),
        })),
        finalize: async (prepared) => {
          await assertManagedIssueWorkspaceLayout(workspaceRoot, prepared.map(({ workspacePath }) => workspacePath));
          const runtimeRoot = await prepareIssueRuntime(this.stateRoot, issue.key, prepared.map((worktree, index) => ({ name: names.get(repositories[index]!.url)!, repositoryPath: worktree.workspacePath })), "write");
          await prepareProjectWrappers(runtimeRoot);
          return finalize(prepared, names);
        },
      });
    } catch (error) {
      let cleanupFailed = error instanceof WorktreeRollbackFailure;
      try { await rmdir(workspaceRoot); }
      catch (cleanupError) {
        if (!(cleanupError && typeof cleanupError === "object" && "code" in cleanupError && cleanupError.code === "ENOENT")) cleanupFailed = true;
      }
      try { await recoverRuntime(); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw new Error("workspace_restore_cleanup_failed", { cause: error });
      throw error;
    }
  }

  private async prepareReadOnlyDeployment(input: { serviceId: string; environmentId: string }): Promise<PreparedReadOnlyDeployment> {
    const { repositories: repositoryRows } = await loadDeploymentRepositories(this.database, input);
    const urls = repositoryRows.map(({ repository }) => repository.url);
    const names = repositoryWorkspaceNames(urls);
    const repositories: PreparedReadOnlyDeployment["repositories"] = [];
    for (const { repository, baseBranch } of repositoryRows) {
      repositories.push({ repository, checkout: await this.worktrees.prepareShared({ url: repository.url, baseBranch }) });
    }
    return { names, repositories };
  }

  async hydrateReadOnlyRuntime(issue: ProjectIssue): Promise<string> {
    return this.hydrateReadOnlyRuntimeWithPreparations(issue);
  }

  async hydrateReadOnlyRuntimes(issues: ProjectIssue[]): Promise<RuntimePreparationResult> {
    const preparations: ReadOnlyDeploymentPreparationCache = new Map();
    const repositoryRows = issues.length
      ? await this.database.select().from(issueRepositories).where(inArray(issueRepositories.issueId, issues.map(({ id }) => id)))
      : [];
    const repositoriesByIssue = new Map<string, IssueRepository[]>();
    for (const repository of repositoryRows) {
      const repositories = repositoriesByIssue.get(repository.issueId) ?? [];
      repositories.push(repository);
      repositoriesByIssue.set(repository.issueId, repositories);
    }
    const databaseQueue = new SerialQueue();
    return prepareIssueRuntimeBatch(
      this.database,
      issues,
      (issue) => this.hydrateReadOnlyRuntimeWithPreparations(issue, preparations, repositoriesByIssue.get(issue.id) ?? [], databaseQueue),
      { concurrency: issuePilotConfig.workspace.taskConcurrency },
    );
  }

  private async hydrateReadOnlyRuntimeWithPreparations(
    issue: ProjectIssue,
    preparations?: ReadOnlyDeploymentPreparationCache,
    repositoryRows?: IssueRepository[],
    databaseQueue?: SerialQueue,
  ): Promise<string> {
    const existingRepositoryRows = repositoryRows ?? await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    if (existingRepositoryRows.length && classifyRepositoryState(existingRepositoryRows) !== "read_only") throw new Error("readonly_repository_state_invalid");

    const preparationKey = JSON.stringify([issue.serviceId, issue.environmentId]);
    let preparation = preparations?.get(preparationKey);
    if (!preparation) {
      preparation = this.prepareReadOnlyDeployment({ serviceId: issue.serviceId, environmentId: issue.environmentId });
      preparations?.set(preparationKey, preparation);
    }
    const { names, repositories } = await preparation;
    const runtimeRoot = await prepareIssueRuntime(this.stateRoot, issue.key, repositories.map(({ repository, checkout }) => ({ name: names.get(repository.url)!, repositoryPath: checkout.workspacePath })), "read");
    const saveRuntimeState = () => this.database.transaction(async (transaction) => {
      const now = new Date();
      await replaceIssueRepositoryRows(transaction, issue.id, existingRepositoryRows, repositories.map(({ repository, checkout }) => ({
        url: repository.url,
        baseBranch: checkout.baseBranch,
        workingBranch: null,
        localPath: null,
        workspaceName: null,
        commitBefore: checkout.baseCommit,
      })), now);
      await transaction.update(agentSessions).set({ workspacePath: runtimeRoot, updatedAt: now }).where(eq(agentSessions.issueId, issue.id));
      await transaction.update(issueWorkspaces).set({ runtimeReady: true, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
    });
    if (databaseQueue) await databaseQueue.run(saveRuntimeState);
    else await saveRuntimeState();
    return runtimeRoot;
  }

  async convertReadOnlyToDevelopment<T>(
    issue: ProjectIssue,
    developmentEnvironmentId: string,
    finalize: (conversion: PreparedDevelopmentConversion) => Promise<T>,
  ): Promise<T> {
    const [{ repositories }, existingRepositories] = await Promise.all([
      loadDeploymentRepositories(this.database, { serviceId: issue.serviceId, environmentId: developmentEnvironmentId }),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (classifyRepositoryState(existingRepositories) !== "read_only") throw new Error("readonly_repository_state_invalid");
    const workspaceRoot = issueWorkspaceRoot(this.stateRoot, issue.key);
    if (await pathExists(workspaceRoot)) throw new Error("workspace_path_already_exists");
    const names = repositoryWorkspaceNames(repositories.map(({ repository }) => repository.url));
    try {
      return await this.worktrees.prepareBatch({
        worktrees: repositories.map(({ repository, baseBranch }) => ({
          issueKey: issue.key,
          workspaceName: names.get(repository.url)!,
          url: repository.url,
          baseBranch,
          mode: "hotfix",
        })),
        finalize: async (prepared) => {
          await assertManagedIssueWorkspaceLayout(workspaceRoot, prepared.map(({ workspacePath }) => workspacePath));
          const runtimeRoot = await prepareIssueRuntime(this.stateRoot, issue.key, prepared.map((worktree, index) => ({
            name: names.get(repositories[index]!.repository.url)!,
            repositoryPath: worktree.workspacePath,
          })), "write");
          await prepareProjectWrappers(runtimeRoot);
          return finalize({ prepared, repositories, existingRepositories, names, runtimeRoot });
        },
      });
    } catch (error) {
      let cleanupFailed = error instanceof WorktreeRollbackFailure;
      let recoveryError: unknown;
      try { await this.hydrateReadOnlyRuntime(issue); }
      catch (caught) { cleanupFailed = true; recoveryError = caught; }
      if (cleanupFailed) throw new Error("workspace_conversion_cleanup_failed", { cause: new AggregateError([error, recoveryError].filter(Boolean), "workspace_conversion_cleanup_failed") });
      throw error;
    }
  }

  async prepare(issue: ProjectIssue, environmentKind: EnvironmentKind): Promise<PreparedIssueProject> {
    const [{ deployment, repositories: repositoryRows }, existingRepositoryRows] = await Promise.all([
      loadDeploymentRepositories(this.database, { serviceId: issue.serviceId, environmentId: issue.environmentId }),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    const shared = repositoryPreparationMode(environmentKind, issue.type) === "shared";
    const repositoryUrls = new Set(repositoryRows.map(({ repository }) => repository.url));
    const removedRepositories = existingRepositoryRows.filter((repository) => !repositoryUrls.has(repository.url));
    const existingState = existingRepositoryRows.length ? classifyRepositoryState(existingRepositoryRows) : undefined;
    if (shared && existingState && existingState !== "read_only") throw new Error("readonly_repository_state_invalid");
    if (!shared && existingState && existingState !== "development_workspace") throw new Error("development_repository_state_invalid");

    const existingByUrl = new Map(existingRepositoryRows.map((repository) => [repository.url, repository]));
    const existingNames = shared ? new Map<string, string>() : issueRepositoryWorkspaceNames(existingRepositoryRows);
    if (!shared && await pathExists(issueWorkspaceRoot(this.stateRoot, issue.key))) {
      await assertManagedIssueWorkspaceLayout(issueWorkspaceRoot(this.stateRoot, issue.key), existingRepositoryRows.map((repository) => repository.localPath!));
    }
    const names = repositoryWorkspaceNames(repositoryRows.map(({ repository }) => repository.url), existingNames);
    const saveRepositoryRows = async (prepared: PreparedWorktree[]) => {
      await this.database.transaction((transaction) => replaceIssueRepositoryRows(
        transaction,
        issue.id,
        existingRepositoryRows,
        repositoryRows.map(({ repository }, index) => {
          const workspace = prepared[index]!;
          return {
            url: repository.url,
            baseBranch: workspace.baseBranch,
            workingBranch: workspace.workingBranch,
            localPath: shared ? null : workspace.workspacePath,
            workspaceName: shared ? null : names.get(repository.url)!,
            commitBefore: shared ? workspace.baseCommit : existingByUrl.get(repository.url)?.commitBefore ?? workspace.baseCommit,
          };
        }),
        new Date(),
      ));
    };

    let prepared: PreparedWorktree[];
    if (shared) {
      prepared = [];
      for (const { repository, baseBranch } of repositoryRows) prepared.push(await this.worktrees.prepareShared({ url: repository.url, baseBranch }));
      await saveRepositoryRows(prepared);
    } else {
      const mode = developmentWorktreeMode(issue.type);
      prepared = await this.worktrees.prepareBatch({
        worktrees: repositoryRows.map(({ repository, baseBranch }) => {
          const existing = existingByUrl.get(repository.url);
          return {
            issueKey: issue.key,
            workspaceName: names.get(repository.url)!,
            url: repository.url,
            baseBranch: existing?.baseBranch ?? baseBranch,
            mode,
            ...(existing?.workingBranch ? { workingBranch: existing.workingBranch } : {}),
            ...(existing?.localPath ? { existingWorkspacePath: existing.localPath } : {}),
            ...(existing?.commitBefore ? { existingBaseCommit: existing.commitBefore } : {}),
          };
        }),
        finalize: async (workspaces) => {
          if (removedRepositories.length) {
            await this.worktrees.removeBatch({
              issueKey: issue.key,
              mode,
              worktrees: removedRepositories.map((repository) => ({
                workspaceName: existingNames.get(repository.url)!,
                url: repository.url,
                workingBranch: repository.workingBranch!,
                workspacePath: repository.localPath!,
              })),
              finalize: () => saveRepositoryRows(workspaces),
            });
          } else await saveRepositoryRows(workspaces);
          return workspaces;
        },
      });
    }

    const runtimeRoot = await prepareIssueRuntime(
      this.stateRoot,
      issue.key,
      prepared.map((workspace, index) => ({ name: names.get(repositoryRows[index]!.repository.url)!, repositoryPath: workspace.workspacePath })),
      shared ? "read" : "write",
    );
    const workspaceRoot = shared ? runtimeRoot : issueWorkspaceRoot(this.stateRoot, issue.key);
    const executableRoot = shared ? undefined : await prepareProjectWrappers(runtimeRoot);
    return {
      deployment: { id: deployment.id, config: deployment.config },
      runtimeRoot,
      workspaceRoot,
      ...(executableRoot ? { executableRoot } : {}),
      repositories: prepared.map((workspace, index) => {
        const name = names.get(repositoryRows[index]!.repository.url)!;
        return {
          name,
          workspacePath: shared ? path.join(runtimeRoot, name) : workspace.workspacePath,
          baseBranch: workspace.baseBranch,
          workingBranch: workspace.workingBranch,
          baseCommit: workspace.baseCommit,
          access: shared ? "read" : "write",
        };
      }),
      runtimeReady: true,
    };
  }
}
