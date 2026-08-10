import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { agentSessions, environments, issueRepositories, issueWorkspaces, issues, serviceDeployments, serviceRepositories } from "../db/schema.ts";
import { CodeServerManager } from "./code-server.ts";
import { repositoryWorkspaceNames, WorktreeManager } from "./git.ts";
import { prepareReadOnlyRuntime } from "./runtime.ts";

type Database = ReturnType<typeof openDatabase>["db"];

export async function prepareReadOnlyIssueRuntimes(
  database: Database,
  stateRoot: string,
  codeServer: Pick<CodeServerManager, "ensure"> = new CodeServerManager(stateRoot),
): Promise<{ prepared: string[]; blocked: Array<{ issueKey: string; reason: string }> }> {
  const readOnlyIssues = await database.select({ issue: issues, session: agentSessions }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .innerJoin(agentSessions, eq(agentSessions.issueId, issues.id))
    .where(inArray(environments.kind, ["prod", "test"]));
  const worktrees = new WorktreeManager(stateRoot);
  const prepared: string[] = [];
  const blocked: Array<{ issueKey: string; reason: string }> = [];

  for (const { issue } of readOnlyIssues) {
    try {
      const [deployment, repositories, existingRepositories] = await Promise.all([
        database.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, issue.serviceId), eq(serviceDeployments.environmentId, issue.environmentId))).limit(1).then((rows) => rows[0]),
        database.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, issue.serviceId)),
        database.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
      ]);
      if (!deployment) throw new Error("issue_service_deployment_not_found");
      if (!repositories.length) throw new Error("selected_service_has_no_repository");
      if (existingRepositories.some((repository) => repository.localPath !== null || repository.workingBranch !== null)) throw new Error("readonly_repository_state_invalid");
      const urls = repositories.map((repository) => repository.url);
      const names = repositoryWorkspaceNames(urls);
      const checkouts = [];
      for (const repository of repositories) {
        const checkout = await worktrees.prepareShared({ url: repository.url, baseBranch: deployment.baseBranch });
        checkouts.push({ name: names.get(repository.url)!, checkout });
        await database.insert(issueRepositories).values({
          issueId: issue.id,
          url: repository.url,
          baseBranch: checkout.baseBranch,
          workingBranch: null,
          localPath: null,
          commitBefore: checkout.baseCommit,
        }).onConflictDoUpdate({
          target: [issueRepositories.issueId, issueRepositories.url],
          set: { baseBranch: checkout.baseBranch, workingBranch: null, localPath: null, commitBefore: checkout.baseCommit, updatedAt: new Date() },
        });
      }
      const removedUrls = existingRepositories.filter((repository) => !urls.includes(repository.url)).map((repository) => repository.url);
      if (removedUrls.length) await database.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), notInArray(issueRepositories.url, urls)));

      const runtimeRoot = await prepareReadOnlyRuntime(stateRoot, issue.key, checkouts.map(({ name, checkout }) => ({ name, checkoutPath: checkout.workspacePath })));
      await codeServer.ensure(issue.key, runtimeRoot);
      await database.transaction(async (transaction) => {
        await transaction.update(agentSessions).set({ workspacePath: runtimeRoot, updatedAt: new Date() }).where(eq(agentSessions.issueId, issue.id));
        await transaction.update(issueWorkspaces).set({ codeServerReady: true, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
      });
      prepared.push(issue.key);
    } catch (error) {
      await database.update(issueWorkspaces).set({ codeServerReady: false, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id)).catch(() => undefined);
      blocked.push({ issueKey: issue.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { prepared, blocked };
}
