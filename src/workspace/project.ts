import { and, asc, eq, isNotNull, notInArray, or } from "drizzle-orm";
import { domainError } from "../domain/errors.ts";
import path from "node:path";

import type { Database } from "../db/client.ts";
import { agentSessions, environments, issueRelations, issueRepositories, issues, issueWorkspaces, services } from "../db/schema.ts";
import type { EnvironmentKind, IssueType } from "../domain/contracts.ts";
import { loadIssueCredentialOwner } from "../configuration/user-credentials.ts";
import { createPersonalGitEnvironment } from "./git-credentials.ts";
import { loadIssueDeployments } from "./issue-services.ts";
import type { loadDeploymentRepositories } from "./deployment.ts";
import { issueRepositoryWorkspaceNames, repositoryStorePath, repositoryWorkspaceNames, WorktreeManager, WorktreeRollbackFailure, type PreparedWorktree } from "./git.ts";
import { prepareIssueRuntime, resolveRecordedRepository, type IssueRuntimeRepository, type RelatedIssueRuntime } from "./runtime.ts";
import { assertIssueRoot, assertManagedIssueWorkspaceLayout, classifyRepositoryState, issueRoot, pathExists } from "./state.ts";

interface PreparedIssueRepository {
  name: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string | null;
  baseCommit: string;
  access: "read" | "write";
}

export interface PreparedIssueProject {
  runtimeRoot: string;
  repositories: PreparedIssueRepository[];
  relatedIssueKeys: string[];
  readRoots: string[];
  runtimeReady: boolean;
}
type ProjectIssue = { id: string; key: string; type: IssueType; serviceId: string; environmentId: string };
type IssueRepository = typeof issueRepositories.$inferSelect;

function allowRepositoryRead(readRoots: Set<string>, sharedStore: string, root: string, developmentStore?: string): void {
  if (!developmentStore) readRoots.add(root);
  // Private development stores only borrow shared baseline objects.
  readRoots.add(developmentStore ? path.join(sharedStore, "objects") : sharedStore);
}
type DeploymentRepository = Awaited<ReturnType<typeof loadDeploymentRepositories>>["repositories"][number];

export interface PreparedDevelopmentConversion {
  prepared: PreparedWorktree[];
  repositories: DeploymentRepository[];
  existingRepositories: IssueRepository[];
  names: Map<string, string>;
}

export type PreparedDevelopmentScopeMigration = PreparedDevelopmentConversion;

/** The repository set a scope-transition plan was verified against. */
export interface ExpectedRepository {
  url: string;
  baseBranch: string;
}

/** Refuse a plan whose target deployment changed before execution instead of re-resolving silently. */
export function assertSameRepositorySet(actual: ReadonlyArray<ExpectedRepository>, expected: readonly ExpectedRepository[] | undefined): void {
  if (!expected) return;
  const key = ({ url, baseBranch }: ExpectedRepository) => `${url}\0${baseBranch}`;
  const actualKeys = new Set(actual.map(key));
  const expectedKeys = new Set(expected.map(key));
  if (actualKeys.size !== expectedKeys.size || [...actualKeys].some((value) => !expectedKeys.has(value))) throw new Error("scope_transition_plan_stale");
}

type IssueRepositoryWriter = Pick<Database, "insert" | "delete">;
type IssueRepositoryReplacement = Pick<IssueRepository, "url" | "baseBranch" | "workingBranch" | "localPath" | "workspaceName" | "commitBefore">;

export async function replaceIssueRepositoryRows(writer: IssueRepositoryWriter, issueId: string, existing: IssueRepository[], replacements: IssueRepositoryReplacement[], now: Date): Promise<void> {
  const previousByUrl = new Map(existing.map((row) => [row.url, row]));
  for (const { url, ...state } of replacements) {
    const previous = previousByUrl.get(url);
    if (previous && Object.entries(state).every(([key, value]) => previous[key as keyof typeof state] === value)) continue;
    await writer
      .insert(issueRepositories)
      .values({ issueId, url, ...state })
      .onConflictDoUpdate({
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
    const workspaceRoot = await assertIssueRoot(this.stateRoot, issue.key).catch((error: unknown) => {
      if (error instanceof Error && error.message === "issue_root_missing") throw new Error("workspace_missing", { cause: error });
      throw error;
    });
    const repositories = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id));
    if (!repositories.length) throw new Error("issue_has_no_repositories");
    const state = classifyRepositoryState(repositories);
    const names = issueRepositoryWorkspaceNames(repositories);
    const relatedIssues = await this.prepareRelatedIssueRuntimes(issue.id);
    if (state !== "development_workspace") throw new Error("development_repository_state_invalid");
    await assertManagedIssueWorkspaceLayout(
      workspaceRoot,
      repositories.map((repository) => repository.localPath!),
    );
    const runtimeRoot = await prepareIssueRuntime(
      this.stateRoot,
      issue.key,
      repositories.map((repository) => ({ name: names.get(repository.url)!, repositoryPath: repository.localPath! })),
      "write",
      relatedIssues,
    );
    await this.database
      .update(issueWorkspaces)
      .set({ runtimeReady: true, releasedAt: null, lastError: null, updatedAt: new Date() })
      .where(and(eq(issueWorkspaces.issueId, issue.id), or(eq(issueWorkspaces.runtimeReady, false), isNotNull(issueWorkspaces.lastError))));
    return runtimeRoot;
  }

  async restoreDevelopmentWorkspace<T>(
    issue: Pick<ProjectIssue, "id" | "key" | "type">,
    repositories: Array<typeof issueRepositories.$inferSelect>,
    names: ReadonlyMap<string, string>,
    commits: ReadonlyMap<string, string>,
    finalize: (prepared: PreparedWorktree[]) => Promise<T>,
  ): Promise<T> {
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    const mode = developmentWorktreeMode(issue.type);
    const relatedIssues = await this.prepareRelatedIssueRuntimes(issue.id);
    if (!(await pathExists(workspaceRoot))) throw new Error("workspace_missing");
    const worktrees = [];
    for (const repository of repositories) {
      worktrees.push({
        issueKey: issue.key,
        workspaceName: names.get(repository.url)!,
        url: repository.url,
        baseBranch: repository.baseBranch,
        mode,
        workingBranch: repository.workingBranch!,
        expectedWorkingCommit: commits.get(repository.url)!,
        ...(repository.commitBefore ? { existingBaseCommit: repository.commitBefore } : {}),
      });
    }
    // The released view is derived from recorded Git state even when this removes old generated links.
    await prepareIssueRuntime(this.stateRoot, issue.key, [], "write", relatedIssues);
    return this.worktrees.prepareBatch({
      worktrees,
      finalize: async (prepared) => {
        await assertManagedIssueWorkspaceLayout(
          workspaceRoot,
          prepared.map(({ workspacePath }) => workspacePath),
        );
        return finalize(prepared);
      },
    });
  }

  private async prepareRelatedIssueRuntimes(issueId: string, agent?: { readRoots: Set<string>; checkedCheckouts: Set<string> }): Promise<RelatedIssueRuntime[]> {
    const relations = await this.database.select().from(issueRelations).where(eq(issueRelations.issueId, issueId)).orderBy(asc(issueRelations.createdAt), asc(issueRelations.relatedIssueId));
    const relatedIssues: RelatedIssueRuntime[] = [];
    for (const relation of relations) {
      const [related] = await this.database
        .select({ issue: issues, service: services, environment: environments, session: agentSessions, releasedAt: issueWorkspaces.releasedAt })
        .from(issues)
        .innerJoin(services, eq(services.id, issues.serviceId))
        .innerJoin(environments, eq(environments.id, issues.environmentId))
        .leftJoin(agentSessions, eq(agentSessions.issueId, issues.id))
        .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
        .where(eq(issues.id, relation.relatedIssueId))
        .limit(1);
      if (!related) throw new Error("related_issue_context_unavailable");
      const repositoryRows = await this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, related.issue.id));
      const names = issueRepositoryWorkspaceNames(repositoryRows);
      const checkoutByUrl = new Map<string, IssueRuntimeRepository>();
      if (agent) {
        try {
          agent.readRoots.add(await assertIssueRoot(this.stateRoot, related.issue.key));
          const state = classifyRepositoryState(repositoryRows);
          if (repositoryRows.length && state === "invalid") throw domainError("source_repository_state_invalid");
          if (state === "development_snapshot" && !related.releasedAt) throw domainError("source_repository_state_invalid");
          if (state !== "invalid") {
            for (const [index, repository] of repositoryRows.entries()) {
              const { root, store } = await resolveRecordedRepository(this.stateRoot, related.issue.key, repository, names.get(repository.url)!, state, agent.checkedCheckouts);
              allowRepositoryRead(agent.readRoots, repositoryStorePath(this.stateRoot, repository.url), root, store);
              if (state === "development_snapshot") {
                const name = `.related-${related.issue.key.toLowerCase()}-code-${index + 1}`;
                checkoutByUrl.set(repository.url, { name, repositoryPath: root });
              }
            }
          }
        } catch (error) {
          throw new Error("related_issue_context_unavailable", { cause: error });
        }
      }
      const repositoryMetadata = repositoryRows.map((repository) => {
        const checkout = checkoutByUrl.get(repository.url);
        return {
          name: names.get(repository.url),
          url: repository.url,
          baseBranch: repository.baseBranch,
          workingBranch: repository.workingBranch,
          commit: checkout ? path.basename(checkout.repositoryPath) : repository.commitBefore,
          ...(checkout ? { checkout: checkout.name } : {}),
        };
      });
      let conversationPath: string | undefined;
      if (related.session) {
        const candidate = path.resolve(related.session.sessionFile);
        if (path.dirname(candidate) === issueRoot(this.stateRoot, related.issue.key) && (await pathExists(candidate))) conversationPath = candidate;
      }
      relatedIssues.push({
        key: related.issue.key,
        workDirectory: issueRoot(this.stateRoot, related.issue.key),
        repositoryLinks: [...checkoutByUrl.values()],
        ...(conversationPath ? { conversationPath } : {}),
        metadata: {
          key: related.issue.key,
          title: related.issue.title,
          description: related.issue.description,
          type: related.issue.type,
          status: related.issue.status,
          priority: related.issue.priority,
          service: { key: related.service.key, name: related.service.name },
          environmentKey: related.environment.key,
          repositories: repositoryMetadata,
          ...(conversationPath ? { conversationFile: `.related-${related.issue.key.toLowerCase()}.jsonl` } : {}),
          directory: `.related-${related.issue.key.toLowerCase()}`,
          note: "The related Issue directory and any listed checkout paths are read-only evidence. Do not modify them.",
        },
      });
    }
    return relatedIssues;
  }

  async convertReadOnlyToDevelopment<T>(
    issue: ProjectIssue,
    developmentEnvironmentId: string,
    finalize: (conversion: PreparedDevelopmentConversion) => Promise<T>,
    credentialsApplied = false,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<T> {
    if (!credentialsApplied)
      return this.withPersonalGit(issue.id, { serviceId: issue.serviceId, environmentId: developmentEnvironmentId }, () =>
        this.convertReadOnlyToDevelopment(issue, developmentEnvironmentId, finalize, true, expectedRepositories),
      );
    const [{ repositories }, existingRepositories] = await Promise.all([
      loadIssueDeployments(this.database, { id: issue.id, serviceId: issue.serviceId, environmentId: developmentEnvironmentId }),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (classifyRepositoryState(existingRepositories) !== "read_only") throw new Error("readonly_repository_state_invalid");
    assertSameRepositorySet(
      repositories.map(({ repository, baseBranch }) => ({ url: repository.url, baseBranch })),
      expectedRepositories,
    );
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    // Read-only Issues already have working files here. Worktree preparation claims
    // individual repository paths and refuses collisions without removing those files.
    const names = repositoryWorkspaceNames(repositories.map(({ repository }) => repository.url));
    // Capture and validate the analyzed view before replacing any links. Recovery
    // restores this view; it must not fetch a new baseline or rewrite durable rows.
    const previousNames = issueRepositoryWorkspaceNames(existingRepositories);
    const previousRuntime: IssueRuntimeRepository[] = [];
    for (const repository of existingRepositories) {
      const name = previousNames.get(repository.url)!;
      const { root } = await resolveRecordedRepository(this.stateRoot, issue.key, repository, name, "read_only");
      previousRuntime.push({ name, repositoryPath: root });
    }
    const relatedIssues = await this.prepareRelatedIssueRuntimes(issue.id);
    try {
      // A development worktree takes the same root name as the former read-only link.
      // Remove only manifest-owned links; recovery below restores them on failure.
      await prepareIssueRuntime(this.stateRoot, issue.key, [], "write");
      return await this.worktrees.prepareBatch({
        worktrees: repositories.map(({ repository, baseBranch }) => ({
          issueKey: issue.key,
          workspaceName: names.get(repository.url)!,
          url: repository.url,
          baseBranch,
          mode: "hotfix",
        })),
        finalize: async (prepared) => {
          await assertManagedIssueWorkspaceLayout(
            workspaceRoot,
            prepared.map(({ workspacePath }) => workspacePath),
          );
          await prepareIssueRuntime(
            this.stateRoot,
            issue.key,
            prepared.map((worktree, index) => ({
              name: names.get(repositories[index]!.repository.url)!,
              repositoryPath: worktree.workspacePath,
            })),
            "write",
            relatedIssues,
          );
          return finalize({ prepared, repositories, existingRepositories, names });
        },
      });
    } catch (error) {
      return this.recoverAfterFailure(error, "workspace_conversion_cleanup_failed", () => prepareIssueRuntime(this.stateRoot, issue.key, previousRuntime, "read", relatedIssues));
    }
  }

  async migrateDevelopmentScope<T>(
    issue: ProjectIssue,
    target: { serviceId: string; environmentId: string },
    finalize: (migration: PreparedDevelopmentScopeMigration) => Promise<T>,
    credentialsApplied = false,
    expectedRepositories?: readonly ExpectedRepository[],
  ): Promise<T> {
    if (!credentialsApplied) return this.withPersonalGit(issue.id, target, () => this.migrateDevelopmentScope(issue, target, finalize, true, expectedRepositories));
    const [{ repositories }, existingRepositories] = await Promise.all([
      loadIssueDeployments(this.database, { id: issue.id, ...target }),
      this.database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
    ]);
    if (classifyRepositoryState(existingRepositories) !== "development_workspace") throw new Error("development_repository_state_invalid");
    const existingByUrl = new Map(existingRepositories.map((repository) => [repository.url, repository]));
    // Retained repositories keep the branch they were prepared from; only added ones use the target branch.
    assertSameRepositorySet(
      repositories.map(({ repository, baseBranch }) => ({ url: repository.url, baseBranch: existingByUrl.get(repository.url)?.baseBranch ?? baseBranch })),
      expectedRepositories,
    );
    const workspaceRoot = issueRoot(this.stateRoot, issue.key);
    if (!(await pathExists(workspaceRoot))) throw new Error("workspace_missing");
    await assertManagedIssueWorkspaceLayout(
      workspaceRoot,
      existingRepositories.map((repository) => repository.localPath!),
    );

    const existingNames = issueRepositoryWorkspaceNames(existingRepositories);
    const targetUrls = new Set(repositories.map(({ repository }) => repository.url));
    const removedRepositories = existingRepositories.filter((repository) => !targetUrls.has(repository.url));
    for (const repository of removedRepositories) await this.worktrees.assertClean(repository.url, repository.localPath!, repository.workingBranch!);

    const names = repositoryWorkspaceNames(
      repositories.map(({ repository }) => repository.url),
      existingNames,
    );
    const mode = developmentWorktreeMode(issue.type);
    try {
      return await this.worktrees.prepareBatch({
        worktrees: repositories.map(({ repository, baseBranch }) => {
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
        finalize: async (prepared) => {
          await assertManagedIssueWorkspaceLayout(workspaceRoot, [...prepared.map(({ workspacePath }) => workspacePath), ...removedRepositories.map(({ localPath }) => localPath!)]);
          await prepareIssueRuntime(
            this.stateRoot,
            issue.key,
            prepared.map((worktree, index) => ({
              name: names.get(repositories[index]!.repository.url)!,
              repositoryPath: worktree.workspacePath,
            })),
            "write",
          );
          const complete = () => finalize({ prepared, repositories, existingRepositories, names });
          if (!removedRepositories.length) return complete();
          let result: T | undefined;
          await this.worktrees.removeBatch({
            issueKey: issue.key,
            mode,
            worktrees: removedRepositories.map((repository) => ({
              workspaceName: existingNames.get(repository.url)!,
              url: repository.url,
              workingBranch: repository.workingBranch!,
              workspacePath: repository.localPath!,
            })),
            finalize: async () => {
              result = await complete();
            },
          });
          return result!;
        },
      });
    } catch (error) {
      return this.recoverAfterFailure(error, "workspace_scope_migration_cleanup_failed", () => this.hydrateDevelopmentRuntime(issue));
    }
  }

  /** A failed preparation restores the previous runtime view; rollback and recovery failures are both preserved. */
  private async recoverAfterFailure(error: unknown, failureCode: string, recover: () => Promise<unknown>): Promise<never> {
    let cleanupFailed = error instanceof WorktreeRollbackFailure;
    let recoveryError: unknown;
    try {
      await recover();
    } catch (caught) {
      cleanupFailed = true;
      recoveryError = caught;
    }
    if (cleanupFailed) throw new Error(failureCode, { cause: new AggregateError([error, recoveryError].filter(Boolean), failureCode) });
    throw error;
  }

  private async withPersonalGit<T>(issueId: string, target: { serviceId: string; environmentId: string }, operation: () => Promise<T>): Promise<T> {
    const { repositories } = await loadIssueDeployments(this.database, { id: issueId, ...target });
    const urls = repositories.map(({ repository }) => repository.url);
    if (urls.every((url) => url.startsWith("file:") || path.isAbsolute(url))) return operation();
    const owner = await loadIssueCredentialOwner(this.database, issueId);
    if (owner.user.role !== "developer") throw new Error("issue_developer_owner_required");
    const git = await createPersonalGitEnvironment(owner.credentials, urls);
    try {
      return await this.worktrees.withGitEnvironment(git.env, operation);
    } finally {
      await git.close();
    }
  }

  async prepare(issue: ProjectIssue, environmentKind: EnvironmentKind, gitEnvironment?: Record<string, string>): Promise<PreparedIssueProject> {
    if (gitEnvironment) return this.worktrees.withGitEnvironment(gitEnvironment, () => this.prepare(issue, environmentKind));
    await assertIssueRoot(this.stateRoot, issue.key);
    const [{ repositories: repositoryRows }, existingRepositoryRows] = await Promise.all([
      loadIssueDeployments(this.database, issue),
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
    if (!shared && (await pathExists(issueRoot(this.stateRoot, issue.key)))) {
      await assertManagedIssueWorkspaceLayout(
        issueRoot(this.stateRoot, issue.key),
        existingRepositoryRows.map((repository) => repository.localPath!),
      );
    }
    const names = repositoryWorkspaceNames(
      repositoryRows.map(({ repository }) => repository.url),
      existingNames,
    );
    const saveRepositoryRows = async (prepared: PreparedWorktree[]) => {
      await this.database.transaction((transaction) =>
        replaceIssueRepositoryRows(
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
              commitBefore: shared ? workspace.baseCommit : (existingByUrl.get(repository.url)?.commitBefore ?? workspace.baseCommit),
            };
          }),
          new Date(),
        ),
      );
    };

    const readRoots = new Set<string>();
    const checkedCheckouts = new Set<string>();
    const relatedIssues = await this.prepareRelatedIssueRuntimes(issue.id, { readRoots, checkedCheckouts });
    let prepared: PreparedWorktree[];
    if (shared) {
      prepared = [];
      for (const { repository, baseBranch } of repositoryRows) prepared.push(await this.worktrees.prepareShared({ url: repository.url, baseBranch }, checkedCheckouts));
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
      relatedIssues,
    );
    for (const [index, workspace] of prepared.entries()) {
      const sharedStore = repositoryStorePath(this.stateRoot, repositoryRows[index]!.repository.url);
      allowRepositoryRead(readRoots, sharedStore, workspace.workspacePath, shared ? undefined : workspace.cachePath);
    }
    return {
      runtimeRoot,
      readRoots: [...readRoots],
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
      relatedIssueKeys: relatedIssues.map(({ key }) => key),
      runtimeReady: true,
    };
  }
}
