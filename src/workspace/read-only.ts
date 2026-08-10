import { access, rm } from "node:fs/promises";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";

import type { openDatabase } from "../db/client.ts";
import { agentSessions, environments, issueRepositories, issueWorkspaces, issues } from "../db/schema.ts";
import { WorktreeManager } from "./git.ts";
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
