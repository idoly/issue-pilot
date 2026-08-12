import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { agentSessions, environments, issueRepositories, issueWorkspaces, issues } from "../db/schema.ts";
import { CodeServerManager } from "./code-server.ts";
import { loadDeploymentRepositories, type DeploymentRepository } from "./deployment.ts";
import { repositoryWorkspaceNames, WorktreeManager } from "./git.ts";
import { prepareIssueRuntime, prepareIssueRuntimeBatch, type RuntimePreparationResult } from "./runtime.ts";
import { classifyRepositoryState } from "./state.ts";

type ReadOnlyIssue = typeof issues.$inferSelect;
type CodeServer = Pick<CodeServerManager, "ensure">;

async function prepareReadOnlyIssueRuntime(
  database: Database,
  stateRoot: string,
  issue: ReadOnlyIssue,
  codeServer: CodeServer,
  worktrees: WorktreeManager,
): Promise<void> {
  const [{ repositories }, existingRepositories] = await Promise.all([
    loadDeploymentRepositories(database, { serviceId: issue.serviceId, environmentId: issue.environmentId }),
    database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
  ]);
  if (existingRepositories.length && classifyRepositoryState(existingRepositories) !== "read_only") throw new Error("readonly_repository_state_invalid");
  const urls = repositories.map(({ repository }) => repository.url);
  const names = repositoryWorkspaceNames(urls);
  const checkouts: Array<{ repository: DeploymentRepository["repository"]; name: string; checkout: Awaited<ReturnType<WorktreeManager["prepareShared"]>> }> = [];
  for (const { repository, baseBranch } of repositories) {
    checkouts.push({ repository, name: names.get(repository.url)!, checkout: await worktrees.prepareShared({ url: repository.url, baseBranch }) });
  }

  const runtimeRoot = await prepareIssueRuntime(stateRoot, issue.key, checkouts.map(({ name, checkout }) => ({ name, repositoryPath: checkout.workspacePath })), "read");
  await codeServer.ensure(issue.key, runtimeRoot);
  await database.transaction(async (transaction) => {
    const now = new Date();
    for (const { repository, checkout } of checkouts) {
      const repositoryState = { baseBranch: checkout.baseBranch, workingBranch: null, localPath: null, workspaceName: null, commitBefore: checkout.baseCommit };
      await transaction.insert(issueRepositories).values({ issueId: issue.id, url: repository.url, ...repositoryState }).onConflictDoUpdate({
        target: [issueRepositories.issueId, issueRepositories.url],
        set: { ...repositoryState, updatedAt: now },
      });
    }
    if (existingRepositories.some((repository) => !urls.includes(repository.url))) {
      await transaction.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), notInArray(issueRepositories.url, urls)));
    }
    await transaction.update(agentSessions).set({ workspacePath: runtimeRoot, updatedAt: now }).where(eq(agentSessions.issueId, issue.id));
    await transaction.update(issueWorkspaces).set({ codeServerReady: true, lastError: null, updatedAt: now }).where(eq(issueWorkspaces.issueId, issue.id));
  });
}

export async function prepareReadOnlyIssueRuntimes(
  database: Database,
  stateRoot: string,
  codeServer: CodeServer = new CodeServerManager(stateRoot),
): Promise<RuntimePreparationResult> {
  const readOnlyIssues = await database.select({ issue: issues }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .innerJoin(agentSessions, eq(agentSessions.issueId, issues.id))
    .where(inArray(environments.kind, ["prod", "test"]));
  const worktrees = new WorktreeManager(stateRoot);
  return prepareIssueRuntimeBatch(
    database,
    readOnlyIssues.map(({ issue }) => issue),
    (issue) => prepareReadOnlyIssueRuntime(database, stateRoot, issue, codeServer, worktrees),
  );
}
