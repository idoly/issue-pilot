import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { agentSessions, environments, issueRepositories, issueWorkspaces, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories } from "../db/schema.ts";
import { CodeServerManager } from "./code-server.ts";
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
  const [deployment, repositories, allRepositories, existingRepositories] = await Promise.all([
    database.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, issue.serviceId), eq(serviceDeployments.environmentId, issue.environmentId))).limit(1).then((rows) => rows[0]),
    database.select({ repository: serviceRepositories, baseBranch: serviceDeploymentRepositories.baseBranch }).from(serviceRepositories)
      .innerJoin(serviceDeploymentRepositories, eq(serviceDeploymentRepositories.repositoryId, serviceRepositories.id))
      .innerJoin(serviceDeployments, and(eq(serviceDeployments.id, serviceDeploymentRepositories.deploymentId), eq(serviceDeployments.serviceId, issue.serviceId), eq(serviceDeployments.environmentId, issue.environmentId)))
      .where(eq(serviceRepositories.serviceId, issue.serviceId)),
    database.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, issue.serviceId)),
    database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
  ]);
  if (!deployment) throw new Error("issue_service_deployment_not_found");
  if (!allRepositories.length) throw new Error("selected_service_has_no_repository");
  if (repositories.length !== allRepositories.length) throw new Error("deployment_repository_branches_invalid");
  if (existingRepositories.length && classifyRepositoryState(existingRepositories) !== "read_only") throw new Error("readonly_repository_state_invalid");
  const urls = repositories.map(({ repository }) => repository.url);
  const names = repositoryWorkspaceNames(urls);
  const checkouts = [];
  for (const { repository, baseBranch } of repositories) {
    const checkout = await worktrees.prepareShared({ url: repository.url, baseBranch });
    checkouts.push({ name: names.get(repository.url)!, checkout });
    const repositoryState = { baseBranch: checkout.baseBranch, workingBranch: null, localPath: null, commitBefore: checkout.baseCommit };
    await database.insert(issueRepositories).values({ issueId: issue.id, url: repository.url, ...repositoryState }).onConflictDoUpdate({
      target: [issueRepositories.issueId, issueRepositories.url],
      set: { ...repositoryState, updatedAt: new Date() },
    });
  }
  if (existingRepositories.some((repository) => !urls.includes(repository.url))) {
    await database.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), notInArray(issueRepositories.url, urls)));
  }

  const runtimeRoot = await prepareIssueRuntime(stateRoot, issue.key, checkouts.map(({ name, checkout }) => ({ name, repositoryPath: checkout.workspacePath })), "read");
  await codeServer.ensure(issue.key, runtimeRoot);
  await database.transaction(async (transaction) => {
    await transaction.update(agentSessions).set({ workspacePath: runtimeRoot, updatedAt: new Date() }).where(eq(agentSessions.issueId, issue.id));
    await transaction.update(issueWorkspaces).set({ codeServerReady: true, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
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
