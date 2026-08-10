import { access, rm } from "node:fs/promises";
import path from "node:path";

import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { agentSessions, environments, issueRepositories, issueWorkspaces, issues, serviceDeployments, serviceRepositories } from "../db/schema.ts";
import { CodeServerManager } from "./code-server.ts";
import { repositoryWorkspaceNames, WorktreeManager } from "./git.ts";
import { prepareReadOnlyRuntime } from "./runtime.ts";
import { assertManagedIssueWorkspaceLayout, issueRuntimeRoot, issueWorkspaceRoot } from "./state.ts";

type Database = ReturnType<typeof openDatabase>["db"];

export interface WorkspaceRepositoryReference {
  url: string;
  localPath: string | null;
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

export async function retireReadOnlyIssueWorkspace(stateRoot: string, issueKey: string, repositories: WorkspaceRepositoryReference[], worktrees = new WorktreeManager(stateRoot)): Promise<boolean> {
  const root = issueWorkspaceRoot(stateRoot, issueKey);
  const localRepositories = repositories.filter((repository) => repository.localPath !== null);
  if (!localRepositories.length) return false;
  for (const repository of localRepositories) {
    if (path.dirname(path.resolve(repository.localPath!)) !== root) throw new Error("workspace_path_outside_issue_root");
  }

  if (await exists(root)) await assertManagedIssueWorkspaceLayout(root, localRepositories.map((repository) => repository.localPath!));
  for (const repository of localRepositories) await worktrees.assertClean(repository.localPath!);
  for (const repository of localRepositories) await worktrees.remove(repository.url, repository.localPath!);
  await rm(root, { recursive: true, force: true });
  return true;
}

export async function migrateReadOnlyIssueWorkspaces(database: Database, stateRoot: string): Promise<{
  migrated: string[];
  blocked: Array<{ issueKey: string; reason: string }>;
}> {
  const rows = await database.select({
    issueId: issues.id,
    issueKey: issues.key,
    url: issueRepositories.url,
    localPath: issueRepositories.localPath,
  }).from(issueRepositories)
    .innerJoin(issues, eq(issues.id, issueRepositories.issueId))
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .where(inArray(environments.kind, ["prod", "test"]));
  const grouped = new Map<string, { issueKey: string; repositories: WorkspaceRepositoryReference[] }>();
  for (const row of rows) {
    const entry = grouped.get(row.issueId) ?? { issueKey: row.issueKey, repositories: [] };
    entry.repositories.push({ url: row.url, localPath: row.localPath });
    grouped.set(row.issueId, entry);
  }

  const migrated: string[] = [];
  const blocked: Array<{ issueKey: string; reason: string }> = [];
  for (const [issueId, entry] of grouped) {
    try {
      const retired = await retireReadOnlyIssueWorkspace(stateRoot, entry.issueKey, entry.repositories);
      await database.transaction(async (transaction) => {
        await transaction.update(issueRepositories).set({ localPath: null, updatedAt: new Date() }).where(eq(issueRepositories.issueId, issueId));
        await transaction.update(issueWorkspaces).set({ codeServerReady: false, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issueId));
        await transaction.update(agentSessions).set({ workspacePath: issueRuntimeRoot(stateRoot, entry.issueKey), updatedAt: new Date() }).where(eq(agentSessions.issueId, issueId));
      });
      if (retired) migrated.push(entry.issueKey);
    } catch (error) {
      blocked.push({ issueKey: entry.issueKey, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { migrated, blocked };
}

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
      const obsoleteUrls = existingRepositories.filter((repository) => !urls.includes(repository.url)).map((repository) => repository.url);
      if (obsoleteUrls.length) await database.delete(issueRepositories).where(and(eq(issueRepositories.issueId, issue.id), notInArray(issueRepositories.url, urls)));

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
